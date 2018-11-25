var StreamDemux = require('stream-demux');
var SCChannel = require('sc-channel').SCChannel;
var Response = require('./response').Response;
var AuthEngine = require('./auth').AuthEngine;
var formatter = require('sc-formatter');
var SCTransport = require('./sctransport').SCTransport;
var querystring = require('querystring');
var LinkedList = require('linked-list');
var base64 = require('base-64');
var clone = require('clone');

var scErrors = require('sc-errors');
var InvalidArgumentsError = scErrors.InvalidArgumentsError;
var InvalidMessageError = scErrors.InvalidMessageError;
var InvalidActionError = scErrors.InvalidActionError;
var SocketProtocolError = scErrors.SocketProtocolError;
var TimeoutError = scErrors.TimeoutError;
var BadConnectionError = scErrors.BadConnectionError;

var isBrowser = typeof window !== 'undefined';


var SCClientSocket = function (opts) {
  // TODO 2: Change all var to let or const.
  // TODO 2: Review all emitted events and make sure that emitted objects are consistent.
  this.id = null;
  this.state = this.CLOSED;
  this.authState = this.UNAUTHENTICATED;
  this.signedAuthToken = null;
  this.authToken = null;
  this.pendingReconnect = false;
  this.pendingReconnectTimeout = null;
  this.preparingPendingSubscriptions = false;
  this.clientId = opts.clientId;

  this.connectTimeout = opts.connectTimeout;
  this.ackTimeout = opts.ackTimeout;
  this.channelPrefix = opts.channelPrefix || null;
  this.disconnectOnUnload = opts.disconnectOnUnload == null ? true : opts.disconnectOnUnload;
  this.authTokenName = opts.authTokenName;

  // pingTimeout will be ackTimeout at the start, but it will
  // be updated with values provided by the 'connect' event
  this.pingTimeout = this.ackTimeout;
  this.pingTimeoutDisabled = !!opts.pingTimeoutDisabled;
  this.active = true;

  this._clientMap = opts.clientMap || {};

  var maxTimeout = Math.pow(2, 31) - 1;

  var verifyDuration = (propertyName) => {
    if (this[propertyName] > maxTimeout) {
      throw new InvalidArgumentsError('The ' + propertyName +
        ' value provided exceeded the maximum amount allowed');
    }
  };

  verifyDuration('connectTimeout');
  verifyDuration('ackTimeout');

  this.connectAttempts = 0;

  this._transmitBuffer = new LinkedList();

  this.channels = {}; // TODO 2

  this._channelEventDemux = new StreamDemux();
  this._channelDataDemux = new StreamDemux();

  this._receiverDemux = new StreamDemux();
  this._procedureDemux = new StreamDemux();
  this._listenerDemux = new StreamDemux();

  this.options = opts;

  this._cid = 1;

  this.options.callIdGenerator = () => {
    return this._cid++;
  };

  if (this.options.autoReconnect) {
    if (this.options.autoReconnectOptions == null) {
      this.options.autoReconnectOptions = {};
    }

    // Add properties to the this.options.autoReconnectOptions object.
    // We assign the reference to a reconnectOptions variable to avoid repetition.
    var reconnectOptions = this.options.autoReconnectOptions;
    if (reconnectOptions.initialDelay == null) {
      reconnectOptions.initialDelay = 10000;
    }
    if (reconnectOptions.randomness == null) {
      reconnectOptions.randomness = 10000;
    }
    if (reconnectOptions.multiplier == null) {
      reconnectOptions.multiplier = 1.5;
    }
    if (reconnectOptions.maxDelay == null) {
      reconnectOptions.maxDelay = 60000;
    }
  }

  if (this.options.subscriptionRetryOptions == null) {
    this.options.subscriptionRetryOptions = {};
  }

  if (this.options.authEngine) {
    this.auth = this.options.authEngine;
  } else {
    this.auth = new AuthEngine();
  }

  if (this.options.codecEngine) {
    this.codec = this.options.codecEngine;
  } else {
    // Default codec engine
    this.codec = formatter;
  }

  if (this.options.protocol) {
    var protocolOptionError = new InvalidArgumentsError('The "protocol" option' +
      ' does not affect socketcluster-client. If you want to utilize SSL/TLS' +
      ' - use "secure" option instead');
    this._onSCError(protocolOptionError);
  }

  this.options.path = this.options.path.replace(/\/$/, '') + '/';

  this.options.query = opts.query || {};
  if (typeof this.options.query === 'string') {
    this.options.query = querystring.parse(this.options.query);
  }

  this._unloadHandler = () => {
    this.disconnect();
  };

  if (isBrowser && this.disconnectOnUnload && global.addEventListener) {
    global.addEventListener('beforeunload', this._unloadHandler, false);
  }
  this._clientMap[this.clientId] = this;

  if (this.options.autoConnect) {
    this.connect();
  }
};

SCClientSocket.CONNECTING = SCClientSocket.prototype.CONNECTING = SCTransport.prototype.CONNECTING;
SCClientSocket.OPEN = SCClientSocket.prototype.OPEN = SCTransport.prototype.OPEN;
SCClientSocket.CLOSED = SCClientSocket.prototype.CLOSED = SCTransport.prototype.CLOSED;

SCClientSocket.AUTHENTICATED = SCClientSocket.prototype.AUTHENTICATED = 'authenticated';
SCClientSocket.UNAUTHENTICATED = SCClientSocket.prototype.UNAUTHENTICATED = 'unauthenticated';

SCClientSocket.PENDING = SCClientSocket.prototype.PENDING = 'pending';

SCClientSocket.ignoreStatuses = scErrors.socketProtocolIgnoreStatuses;
SCClientSocket.errorStatuses = scErrors.socketProtocolErrorStatuses;

SCClientSocket.prototype._privateDataHandlerMap = {
  '#publish': function (data) {
    var undecoratedChannelName = this._undecorateChannelName(data.channel);
    var isSubscribed = this.isSubscribed(undecoratedChannelName, true);

    if (isSubscribed) {
      this._channelDataDemux.write(undecoratedChannelName, data.data);
    }
  },
  '#kickOut': function (data) {
    var undecoratedChannelName = this._undecorateChannelName(data.channel);
    var channel = this.channels[undecoratedChannelName];
    if (channel) {
      this.emit('kickOut', {
        channel: undecoratedChannelName,
        message: data.message
      });
      this._channelEventDemux.write(undecoratedChannelName, {
        event: 'kickOut',
        data: data.message
      });
      this._triggerChannelUnsubscribe(channel);
    }
  }
};

SCClientSocket.prototype._privateRPCHandlerMap = {
  '#setAuthToken': function (data, response) {
    if (data) {
      this._changeToAuthenticatedState(data.token);

      this.auth.saveToken(this.authTokenName, data.token, {})
      .catch((err) => {
        this._onSCError(err);
      });

      response.end();
    } else {
      response.error(new InvalidMessageError('No token data provided by #setAuthToken event'));
    }
  },
  '#removeAuthToken': function (data, response) {
    this.auth.removeToken(this.authTokenName)
    .then((oldToken) => {
      return {oldToken: oldToken};
    })
    .catch((err) => {
      return {error: err};
    })
    .then((result) => {
      if (result.error) {
        // Non-fatal error - Do not close the connection
        this._onSCError(result.error);
      } else {
        this.emit('removeAuthToken', result.oldToken);
      }
    });
    this._changeToUnauthenticatedStateAndClearTokens();
    response.end();
  }
};

SCClientSocket.prototype.getState = function () {
  return this.state;
};

SCClientSocket.prototype.getBytesReceived = function () {
  return this.transport.getBytesReceived();
};

SCClientSocket.prototype.deauthenticate = function () {
  this.auth.removeToken(this.authTokenName)
  .then((oldToken) => {
    return {oldToken: oldToken};
  })
  .catch((err) => {
    return {error: err};
  })
  .then((result) => {
    if (result.error) {
      // Non-fatal error - Do not close the connection
      this._onSCError(result.error);
      return;
    }
    this.emit('removeAuthToken', result.oldToken);
  });
  if (this.state !== this.CLOSED) {
    this.transmit('#removeAuthToken');
  }
  this._changeToUnauthenticatedStateAndClearTokens();

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
};

SCClientSocket.prototype.connect = SCClientSocket.prototype.open = function () {
  if (!this.active) {
    var error = new InvalidActionError('Cannot connect a destroyed client');
    this._onSCError(error);
    return;
  }

  if (this.state === this.CLOSED) {
    this.pendingReconnect = false;
    this.pendingReconnectTimeout = null;
    clearTimeout(this._reconnectTimeoutRef);

    this.state = this.CONNECTING;
    this.emit('connecting');

    if (this.transport) {
      this.transport.endAllListeners();
    }

    this.transport = new SCTransport(this.auth, this.codec, this.options);

    (async () => {
      for await (let status of this.transport.listener('open')) {
        this.state = this.OPEN;
        this._onSCOpen(status);
      }
    })();

    (async () => {
      for await (let err of this.transport.listener('error')) {
        this._onSCError(err);
      }
    })();

    (async () => {
      for await (let packet of this.transport.listener('close')) {
        this.state = this.CLOSED;
        this._onSCClose(packet.code, packet.data);
      }
    })();

    (async () => {
      for await (let packet of this.transport.listener('openAbort')) {
        this.state = this.CLOSED;
        this._onSCClose(packet.code, packet.data, true);
      }
    })();

    (async () => {
      for await (let packet of this.transport.listener('event')) {
        this.emit(packet.event, packet.data);
      }
    })();

    (async () => {
      for await (let packet of this.transport.listener('inboundTransmit')) {
        this._onSCInboundTransmit(packet.event, packet.data);
      }
    })();

    (async () => {
      for await (let packet of this.transport.listener('inboundInvoke')) {
        this._onSCInboundInvoke(packet.event, packet.data, packet.response);
      }
    })();
  }
};

SCClientSocket.prototype.reconnect = function (code, data) {
  this.disconnect(code, data);
  this.connect();
};

SCClientSocket.prototype.disconnect = function (code, data) {
  code = code || 1000;

  if (typeof code !== 'number') {
    throw new InvalidArgumentsError('If specified, the code argument must be a number');
  }

  if (this.state === this.OPEN || this.state === this.CONNECTING) {
    this.transport.close(code, data);
  } else {
    this.pendingReconnect = false;
    this.pendingReconnectTimeout = null;
    clearTimeout(this._reconnectTimeoutRef);
  }
};

SCClientSocket.prototype.destroy = function (code, data) {
  if (isBrowser && global.removeEventListener) {
    global.removeEventListener('beforeunload', this._unloadHandler, false);
  }
  this.active = false;
  this.disconnect(code, data);
  delete this._clientMap[this.clientId];
};

SCClientSocket.prototype._changeToUnauthenticatedStateAndClearTokens = function () {
  if (this.authState !== this.UNAUTHENTICATED) {
    var oldState = this.authState;
    var oldSignedToken = this.signedAuthToken;
    this.authState = this.UNAUTHENTICATED;
    this.signedAuthToken = null;
    this.authToken = null;

    var stateChangeData = {
      oldState: oldState,
      newState: this.authState
    };
    this.emit('authStateChange', stateChangeData);
    this.emit('deauthenticate', oldSignedToken);
  }
};

SCClientSocket.prototype._changeToAuthenticatedState = function (signedAuthToken) {
  this.signedAuthToken = signedAuthToken;
  this.authToken = this._extractAuthTokenData(signedAuthToken);

  if (this.authState !== this.AUTHENTICATED) {
    var oldState = this.authState;
    this.authState = this.AUTHENTICATED;
    var stateChangeData = {
      oldState: oldState,
      newState: this.authState,
      signedAuthToken: signedAuthToken,
      authToken: this.authToken
    };
    if (!this.preparingPendingSubscriptions) {
      this.processPendingSubscriptions();
    }

    this.emit('authStateChange', stateChangeData);
  }
  this.emit('authenticate', signedAuthToken);
};

SCClientSocket.prototype.decodeBase64 = function (encodedString) {
  var decodedString;
  if (typeof Buffer === 'undefined') {
    if (global.atob) {
      decodedString = global.atob(encodedString);
    } else {
      decodedString = base64.decode(encodedString);
    }
  } else {
    var buffer = Buffer.from(encodedString, 'base64');
    decodedString = buffer.toString('utf8');
  }
  return decodedString;
};

SCClientSocket.prototype.encodeBase64 = function (decodedString) {
  var encodedString;
  if (typeof Buffer === 'undefined') {
    if (global.btoa) {
      encodedString = global.btoa(decodedString);
    } else {
      encodedString = base64.encode(decodedString);
    }
  } else {
    var buffer = Buffer.from(decodedString, 'utf8');
    encodedString = buffer.toString('base64');
  }
  return encodedString;
};

SCClientSocket.prototype._extractAuthTokenData = function (signedAuthToken) {
  var tokenParts = (signedAuthToken || '').split('.');
  var encodedTokenData = tokenParts[1];
  if (encodedTokenData != null) {
    var tokenData = encodedTokenData;
    try {
      tokenData = this.decodeBase64(tokenData);
      return JSON.parse(tokenData);
    } catch (e) {
      return tokenData;
    }
  }
  return null;
};

SCClientSocket.prototype.getAuthToken = function () {
  return this.authToken;
};

SCClientSocket.prototype.getSignedAuthToken = function () {
  return this.signedAuthToken;
};

// Perform client-initiated authentication by providing an encrypted token string.
SCClientSocket.prototype.authenticate = function (signedAuthToken) {
  return this.invoke('#authenticate', signedAuthToken)
  .then((authStatus) => {
    return {authStatus: authStatus};
  })
  .catch((err) => {
    return {error: err};
  })
  .then((result) => {
    var err = result.error;
    var authStatus = result.authStatus;

    if (authStatus && authStatus.isAuthenticated != null) {
      // If authStatus is correctly formatted (has an isAuthenticated property),
      // then we will rehydrate the authError.
      if (authStatus.authError) {
        authStatus.authError = scErrors.hydrateError(authStatus.authError);
      }
    } else {
      // Some errors like BadConnectionError and TimeoutError will not pass a valid
      // authStatus object to the current function, so we need to create it ourselves.
      authStatus = {
        isAuthenticated: this.authState,
        authError: null
      };
    }
    if (err) {
      if (err.name !== 'BadConnectionError' && err.name !== 'TimeoutError') {
        // In case of a bad/closed connection or a timeout, we maintain the last
        // known auth state since those errors don't mean that the token is invalid.

        this._changeToUnauthenticatedStateAndClearTokens();
      }
      throw err;
    }
    if (authStatus.isAuthenticated) {
      this._changeToAuthenticatedState(signedAuthToken);
    } else {
      this._changeToUnauthenticatedStateAndClearTokens();
    }
    this.auth.saveToken(this.authTokenName, signedAuthToken, {})
    .catch((err) => {
      this._onSCError(err);
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(authStatus);
      }, 0);
    });
  });
};

SCClientSocket.prototype._tryReconnect = function (initialDelay) {
  var exponent = this.connectAttempts++;
  var reconnectOptions = this.options.autoReconnectOptions;
  var timeout;

  if (initialDelay == null || exponent > 0) {
    var initialTimeout = Math.round(reconnectOptions.initialDelay + (reconnectOptions.randomness || 0) * Math.random());

    timeout = Math.round(initialTimeout * Math.pow(reconnectOptions.multiplier, exponent));
  } else {
    timeout = initialDelay;
  }

  if (timeout > reconnectOptions.maxDelay) {
    timeout = reconnectOptions.maxDelay;
  }

  clearTimeout(this._reconnectTimeoutRef);

  this.pendingReconnect = true;
  this.pendingReconnectTimeout = timeout;
  this._reconnectTimeoutRef = setTimeout(() => {
    this.connect();
  }, timeout);
};

SCClientSocket.prototype._onSCOpen = function (status) {
  this.preparingPendingSubscriptions = true;

  if (status) {
    this.id = status.id;
    this.pingTimeout = status.pingTimeout;
    this.transport.pingTimeout = this.pingTimeout;
    if (status.isAuthenticated) {
      this._changeToAuthenticatedState(status.authToken);
    } else {
      this._changeToUnauthenticatedStateAndClearTokens();
    }
  } else {
    // This can happen if auth.loadToken (in sctransport.js) fails with
    // an error - This means that the signedAuthToken cannot be loaded by
    // the auth engine and therefore, we need to unauthenticate the client.
    this._changeToUnauthenticatedStateAndClearTokens();
  }

  this.connectAttempts = 0;

  if (this.options.autoSubscribeOnConnect) {
    this.processPendingSubscriptions();
  }

  // If the user invokes the callback while in autoSubscribeOnConnect mode, it
  // won't break anything.
  this.emit('connect', {
    status: status,
    processPendingSubscriptions: () => {
      this.processPendingSubscriptions();
    }
  });

  if (this.state === this.OPEN) {
    this._flushTransmitBuffer();
  }
};

// TODO 2: Maybe add default option to throw globally.
SCClientSocket.prototype._onSCError = function (err) {
  this.emit('error', err);
};

SCClientSocket.prototype._suspendSubscriptions = function () {
  Object.keys(this.channels).forEach((channelName) => {
    var newState;
    var channel = this.channels[channelName];
    if (
      channel.state === channel.SUBSCRIBED ||
      channel.state === channel.PENDING
    ) {
      newState = channel.PENDING;
    } else {
      newState = channel.UNSUBSCRIBED;
    }

    this._triggerChannelUnsubscribe(channel, newState);
  });
};

SCClientSocket.prototype._abortAllPendingEventsDueToBadConnection = function (failureType) {
  var currentNode = this._transmitBuffer.head;
  var nextNode;

  while (currentNode) {
    nextNode = currentNode.next;
    var eventObject = currentNode.data;
    clearTimeout(eventObject.timeout);
    delete eventObject.timeout;
    currentNode.detach();
    currentNode = nextNode;

    var callback = eventObject.callback;
    if (callback) {
      delete eventObject.callback;
      var errorMessage = "Event '" + eventObject.event +
        "' was aborted due to a bad connection";
      var error = new BadConnectionError(errorMessage, failureType);
      callback.call(eventObject, error, eventObject);
    }
    // Cleanup any pending response callback in the transport layer too.
    if (eventObject.cid) {
      this.transport.cancelPendingResponse(eventObject.cid);
    }
  }
};

SCClientSocket.prototype._onSCClose = function (code, data, openAbort) {
  this.id = null;

  if (this.transport) {
    this.transport.endAllListeners();
  }
  this.pendingReconnect = false;
  this.pendingReconnectTimeout = null;
  clearTimeout(this._reconnectTimeoutRef);

  this._suspendSubscriptions();
  this._abortAllPendingEventsDueToBadConnection(openAbort ? 'connectAbort' : 'disconnect');

  // Try to reconnect
  // on server ping timeout (4000)
  // or on client pong timeout (4001)
  // or on close without status (1005)
  // or on handshake failure (4003)
  // or on handshake rejection (4008)
  // or on socket hung up (1006)
  if (this.options.autoReconnect) {
    if (code === 4000 || code === 4001 || code === 1005) {
      // If there is a ping or pong timeout or socket closes without
      // status, don't wait before trying to reconnect - These could happen
      // if the client wakes up after a period of inactivity and in this case we
      // want to re-establish the connection as soon as possible.
      this._tryReconnect(0);

      // Codes 4500 and above will be treated as permanent disconnects.
      // Socket will not try to auto-reconnect.
    } else if (code !== 1000 && code < 4500) {
      this._tryReconnect();
    }
  }

  if (openAbort) {
    this.emit('connectAbort', {code, data});
  } else {
    this.emit('disconnect', {code, data});
  }
  this.emit('close', {code, data});

  if (!SCClientSocket.ignoreStatuses[code]) {
    var closeMessage;
    if (data) {
      closeMessage = 'Socket connection closed with status code ' + code + ' and reason: ' + data;
    } else {
      closeMessage = 'Socket connection closed with status code ' + code;
    }
    var err = new SocketProtocolError(SCClientSocket.errorStatuses[code] || closeMessage, code);
    this._onSCError(err);
  }
};

SCClientSocket.prototype.emit = function (eventName, data) {
  this._listenerDemux.write(eventName, data);
};

SCClientSocket.prototype._onSCInboundTransmit = function (event, data) {
  var handler = this._privateDataHandlerMap[event];
  if (handler) {
    handler.call(this, data);
  } else {
    this._receiverDemux.write(event, data);
  }
};

SCClientSocket.prototype._onSCInboundInvoke = function (event, data, response) {
  var handler = this._privateRPCHandlerMap[event];
  if (handler) {
    handler.call(this, data, response);
  } else {
    this._procedureDemux.write(event, {
      data,
      end: (data) => {
        response.end(data);
      },
      error: (err) => {
        response.error(err);
      }
    });
  }
};

SCClientSocket.prototype.decode = function (message) {
  return this.transport.decode(message);
};

SCClientSocket.prototype.encode = function (object) {
  return this.transport.encode(object);
};

SCClientSocket.prototype._flushTransmitBuffer = function () {
  var currentNode = this._transmitBuffer.head;
  var nextNode;

  while (currentNode) {
    nextNode = currentNode.next;
    var eventObject = currentNode.data;
    currentNode.detach();
    this.transport.transmitObject(eventObject);
    currentNode = nextNode;
  }
};

SCClientSocket.prototype._handleEventAckTimeout = function (eventObject, eventNode) {
  if (eventNode) {
    eventNode.detach();
  }
  delete eventObject.timeout;

  var callback = eventObject.callback;
  if (callback) {
    delete eventObject.callback;
    var error = new TimeoutError("Event response for '" + eventObject.event + "' timed out");
    callback.call(eventObject, error, eventObject);
  }
  // Cleanup any pending response callback in the transport layer too.
  if (eventObject.cid) {
    this.transport.cancelPendingResponse(eventObject.cid);
  }
};

SCClientSocket.prototype._processOutboundEvent = function (event, data, expectResponse) {
  if (!this.active) {
    var error = new InvalidActionError('Cannot send an event from a destroyed client');
    this._onSCError(error);
    return Promise.reject(error);
  }

  if (this.state === this.CLOSED) {
    this.connect();
  }
  var eventObject = {
    event: event
  };

  var promise;

  if (expectResponse) {
    promise = new Promise((resolve, reject) => {
      eventObject.callback = (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      };
    });
  } else {
    promise = Promise.resolve();
  }

  var eventNode = new LinkedList.Item();

  if (this.options.cloneData) {
    eventObject.data = clone(data);
  } else {
    eventObject.data = data;
  }
  eventNode.data = eventObject;

  eventObject.timeout = setTimeout(() => {
    this._handleEventAckTimeout(eventObject, eventNode);
  }, this.ackTimeout);

  this._transmitBuffer.append(eventNode);
  if (this.state === this.OPEN) {
    this._flushTransmitBuffer();
  }
  return promise;
};

SCClientSocket.prototype.send = function (data) {
  this.transport.send(data);
};

SCClientSocket.prototype.transmit = function (event, data) {
  return this._processOutboundEvent(event, data);
};

SCClientSocket.prototype.invoke = function (event, data) {
  return this._processOutboundEvent(event, data, true);
};

SCClientSocket.prototype.publish = function (channelName, data) {
  var pubData = {
    channel: this._decorateChannelName(channelName),
    data: data
  };
  return this.invoke('#publish', pubData);
};

SCClientSocket.prototype._triggerChannelSubscribe = function (channel, subscriptionOptions) {
  var channelName = channel.name;

  if (channel.state !== channel.SUBSCRIBED) {
    var oldState = channel.state;
    channel.state = channel.SUBSCRIBED;

    var stateChangeData = {
      channel: channelName,
      oldState,
      newState: channel.state,
      subscriptionOptions
    };
    this._channelEventDemux.write(channelName, {
      event: 'subscribeStateChange',
      data: stateChangeData
    });
    this._channelEventDemux.write(channelName, {
      event: 'subscribe',
      data: {
        subscriptionOptions
      }
    });
    this.emit('subscribeStateChange', stateChangeData);
    this.emit('subscribe', {
      channel: channelName,
      subscriptionOptions
    });
  }
};

SCClientSocket.prototype._triggerChannelSubscribeFail = function (err, channel, subscriptionOptions) {
  var channelName = channel.name;
  var meetsAuthRequirements = !channel.waitForAuth || this.authState === this.AUTHENTICATED;

  if (channel.state !== channel.UNSUBSCRIBED && meetsAuthRequirements) {
    channel.state = channel.UNSUBSCRIBED;

    this._channelEventDemux.write(channelName, {
      event: 'subscribeFail',
      data: {
        error: err,
        subscriptionOptions
      }
    });
    this.emit('subscribeFail', {
      error: err,
      channel: channelName,
      subscriptionOptions: subscriptionOptions
    });
  }
};

// Cancel any pending subscribe callback
SCClientSocket.prototype._cancelPendingSubscribeCallback = function (channel) {
  if (channel._pendingSubscriptionCid != null) {
    this.transport.cancelPendingResponse(channel._pendingSubscriptionCid);
    delete channel._pendingSubscriptionCid;
  }
};

SCClientSocket.prototype._decorateChannelName = function (channelName) {
  if (this.channelPrefix) {
    channelName = this.channelPrefix + channelName;
  }
  return channelName;
};

SCClientSocket.prototype._undecorateChannelName = function (decoratedChannelName) {
  if (this.channelPrefix && decoratedChannelName.indexOf(this.channelPrefix) === 0) {
    return decoratedChannelName.replace(this.channelPrefix, '');
  }
  return decoratedChannelName;
};

SCClientSocket.prototype._trySubscribe = function (channel) {
  var meetsAuthRequirements = !channel.waitForAuth || this.authState === this.AUTHENTICATED;

  // We can only ever have one pending subscribe action at any given time on a channel
  if (this.state === this.OPEN && !this.preparingPendingSubscriptions &&
    channel._pendingSubscriptionCid == null && meetsAuthRequirements) {

    var options = {
      noTimeout: true
    };

    var subscriptionOptions = {
      channel: this._decorateChannelName(channel.name)
    };
    if (channel.waitForAuth) {
      options.waitForAuth = true;
      subscriptionOptions.waitForAuth = options.waitForAuth;
    }
    if (channel.data) {
      subscriptionOptions.data = channel.data;
    }
    if (channel.batch) {
      options.batch = true;
      subscriptionOptions.batch = true;
    }

    channel._pendingSubscriptionCid = this.transport.invokeRaw(
      '#subscribe', subscriptionOptions, options,
      (err) => {
        delete channel._pendingSubscriptionCid;
        if (err) {
          this._triggerChannelSubscribeFail(err, channel, subscriptionOptions);
        } else {
          this._triggerChannelSubscribe(channel, subscriptionOptions);
        }
      }
    );
    this.emit('subscribeRequest', {
      channel: channel.name,
      subscriptionOptions
    });
  }
};

SCClientSocket.prototype.subscribe = function (channelName, options) {
  var channel = this.channels[channelName];

  if (!channel) {
    channel = new SCChannel(channelName, this, options);
    this.channels[channelName] = channel;
  } else if (options) {
    channel.setOptions(options);
  }

  if (channel.state === channel.UNSUBSCRIBED) {
    channel.state = channel.PENDING;
    this._trySubscribe(channel);
  }

  return channel;
};

SCClientSocket.prototype._triggerChannelUnsubscribe = function (channel, newState) {
  var channelName = channel.name;
  var oldState = channel.state;

  if (newState) {
    channel.state = newState;
  } else {
    channel.state = channel.UNSUBSCRIBED;
  }
  this._cancelPendingSubscribeCallback(channel);

  if (oldState === channel.SUBSCRIBED) {
    var stateChangeData = {
      channel: channelName,
      oldState: oldState,
      newState: channel.state
    };
    this._channelEventDemux.write(channelName, {
      event: 'subscribeStateChange',
      data: stateChangeData
    });
    this._channelEventDemux.write(channelName, {
      event: 'unsubscribe'
    });
    this.emit('subscribeStateChange', stateChangeData);
    this.emit('unsubscribe', channelName);
  }
};

SCClientSocket.prototype._tryUnsubscribe = function (channel) {
  if (this.state === this.OPEN) {
    var options = {
      noTimeout: true
    };
    if (channel.batch) {
      options.batch = true;
    }
    // If there is a pending subscribe action, cancel the callback
    this._cancelPendingSubscribeCallback(channel);

    // This operation cannot fail because the TCP protocol guarantees delivery
    // so long as the connection remains open. If the connection closes,
    // the server will automatically unsubscribe the client and thus complete
    // the operation on the server side.
    var decoratedChannelName = this._decorateChannelName(channel.name);
    this.transport.transmit('#unsubscribe', decoratedChannelName, options);
  }
};

SCClientSocket.prototype.unsubscribe = function (channelName) {
  var channel = this.channels[channelName];

  if (channel) {
    if (channel.state !== channel.UNSUBSCRIBED) {
      this._triggerChannelUnsubscribe(channel);
      this._tryUnsubscribe(channel);
    }
  }
};

SCClientSocket.prototype.channel = function (channelName, options) {
  var currentChannel = this.channels[channelName];

  if (!currentChannel) {
    currentChannel = new SCChannel(channelName, this, options);
    this.channels[channelName] = currentChannel;
  }
  return currentChannel;
};

// TODO 2: Switch to single channel.
SCClientSocket.prototype.destroyChannel = function (channelName) {
  var channel = this.channels[channelName];

  if (channel) {
    channel.unwatch();
    channel.unsubscribe();
    delete this.channels[channelName];
  }
};

SCClientSocket.prototype.receiver = function (receiverName) {
  return this._receiverDemux.stream(receiverName);
};

SCClientSocket.prototype.endReceiver = function (receiverName) {
  this._receiverDemux.end(receiverName);
};

SCClientSocket.prototype.procedure = function (procedureName) {
  return this._procedureDemux.stream(procedureName);
};

SCClientSocket.prototype.endProcedure = function (procedureName) {
  this._procedureDemux.end(procedureName);
};

SCClientSocket.prototype.listener = function (eventName) {
  return this._listenerDemux.stream(eventName);
};

SCClientSocket.prototype.endListener = function (eventName) {
  this._listenerDemux.end(eventName);
};

SCClientSocket.prototype.subscriptions = function (includePending) {
  var subs = [];
  Object.keys(this.channels).forEach((channelName) => {
    var includeChannel;
    var channel = this.channels[channelName];

    if (includePending) {
      includeChannel = channel && (channel.state === channel.SUBSCRIBED ||
        channel.state === channel.PENDING);
    } else {
      includeChannel = channel && channel.state === channel.SUBSCRIBED;
    }

    if (includeChannel) {
      subs.push(channelName);
    }
  });
  return subs;
};

SCClientSocket.prototype.isSubscribed = function (channelName, includePending) {
  var channel = this.channels[channelName];
  if (includePending) {
    return !!channel && (channel.state === channel.SUBSCRIBED ||
      channel.state === channel.PENDING);
  }
  return !!channel && channel.state === channel.SUBSCRIBED;
};

SCClientSocket.prototype.processPendingSubscriptions = function () {
  this.preparingPendingSubscriptions = false;

  var pendingChannels = [];

  Object.keys(this.channels).forEach((channelName) => {
    var channel = this.channels[channelName];
    if (channel.state === channel.PENDING) {
      pendingChannels.push(channel);
    }
  });

  pendingChannels.sort((a, b) => {
    var ap = a.priority || 0;
    var bp = b.priority || 0;
    if (ap > bp) {
      return -1;
    }
    if (ap < bp) {
      return 1;
    }
    return 0;
  });

  pendingChannels.forEach((channel) => {
    this._trySubscribe(channel);
  });
};

module.exports = SCClientSocket;

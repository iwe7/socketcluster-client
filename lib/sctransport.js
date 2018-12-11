const Response = require('./response').Response;
const querystring = require('querystring');
const StreamDemux = require('stream-demux');
let WebSocket;
let createWebSocket;

if (global.WebSocket) {
  WebSocket = global.WebSocket;
  createWebSocket = function (uri, options) {
    return new WebSocket(uri);
  };
} else {
  WebSocket = require('ws');
  createWebSocket = function (uri, options) {
    return new WebSocket(uri, null, options);
  };
}

const scErrors = require('sc-errors');
const TimeoutError = scErrors.TimeoutError;
const BadConnectionError = scErrors.BadConnectionError;


function SCTransport(authEngine, codecEngine, options) {
  this.state = this.CLOSED;
  this.auth = authEngine;
  this.codec = codecEngine;
  this.options = options;
  this.connectTimeout = options.connectTimeout;
  this.pingTimeout = options.pingTimeout;
  this.pingTimeoutDisabled = !!options.pingTimeoutDisabled;
  this.callIdGenerator = options.callIdGenerator;
  this.authTokenName = options.authTokenName;

  this._listenerDemux = new StreamDemux();
  this._pingTimeoutTicker = null;
  this._callbackMap = {};
  this._batchSendList = [];

  // Open the connection.

  this.state = this.CONNECTING;
  let uri = this.uri();

  let wsSocket = createWebSocket(uri, this.options);
  wsSocket.binaryType = this.options.binaryType;

  this.socket = wsSocket;

  wsSocket.onopen = () => {
    this._onOpen();
  };

  wsSocket.onclose = async (event) => {
    let code;
    if (event.code == null) {
      // This is to handle an edge case in React Native whereby
      // event.code is undefined when the mobile device is locked.
      // TODO: This is not ideal since this condition could also apply to
      // an abnormal close (no close control frame) which would be a 1006.
      code = 1005;
    } else {
      code = event.code;
    }
    this._onClose(code, event.reason);
  };

  wsSocket.onmessage = (message, flags) => {
    this._onMessage(message.data);
  };

  wsSocket.onerror = (error) => {
    // The onclose event will be called automatically after the onerror event
    // if the socket is connected - Otherwise, if it's in the middle of
    // connecting, we want to close it manually with a 1006 - This is necessary
    // to prevent inconsistent behavior when running the client in Node.js
    // vs in a browser.
    if (this.state === this.CONNECTING) {
      this._onClose(1006);
    }
  };

  this._connectTimeoutRef = setTimeout(() => {
    this._onClose(4007);
    this.socket.close(4007);
  }, this.connectTimeout);
};

SCTransport.CONNECTING = SCTransport.prototype.CONNECTING = 'connecting';
SCTransport.OPEN = SCTransport.prototype.OPEN = 'open';
SCTransport.CLOSED = SCTransport.prototype.CLOSED = 'closed';

SCTransport.prototype.emit = function (eventName, data) {
  this._listenerDemux.write(eventName, data);
};

SCTransport.prototype.listener = function (eventName) {
  return this._listenerDemux.stream(eventName);
};

SCTransport.prototype.closeListener = function (eventName) {
  this._listenerDemux.close(eventName);
};

SCTransport.prototype.closeAllListeners = function () {
  this._listenerDemux.closeAll();
};

SCTransport.prototype.uri = function () {
  let query = this.options.query || {};
  let schema = this.options.secure ? 'wss' : 'ws';

  if (this.options.timestampRequests) {
    query[this.options.timestampParam] = (new Date()).getTime();
  }

  query = querystring.encode(query);

  if (query.length) {
    query = '?' + query;
  }

  let host;
  if (this.options.host) {
    host = this.options.host;
  } else {
    let port = '';

    if (this.options.port && ((schema === 'wss' && this.options.port !== 443)
      || (schema === 'ws' && this.options.port !== 80))) {
      port = ':' + this.options.port;
    }
    host = this.options.hostname + port;
  }

  return schema + '://' + host + this.options.path + query;
};

SCTransport.prototype._onOpen = async function () {
  clearTimeout(this._connectTimeoutRef);
  this._resetPingTimeout();

  let status;

  try {
    status = await this._handshake();
  } catch (err) {
    if (err.statusCode == null) {
      err.statusCode = 4003;
    }
    this._onError(err);
    this._onClose(err.statusCode, err.toString());
    this.socket.close(err.statusCode);
    return;
  }

  this.state = this.OPEN;
  this.emit('open', status);
  this._resetPingTimeout();
};

SCTransport.prototype._handshake = async function () {
  let token = await this.auth.loadToken(this.authTokenName);
  // Don't wait for this.state to be 'open'.
  // The underlying WebSocket (this.socket) is already open.
  let options = {
    force: true
  };
  let status = await this.invoke('#handshake', {authToken: token}, options);
  if (status) {
    // Add the token which was used as part of authentication attempt
    // to the status object.
    status.authToken = token;
    if (status.authError) {
      status.authError = scErrors.hydrateError(status.authError);
    }
  }
  return status;
};

SCTransport.prototype._abortAllPendingEventsDueToBadConnection = function (failureType) {
  Object.keys(this._callbackMap || {}).forEach((i) => {
    let eventObject = this._callbackMap[i];
    delete this._callbackMap[i];

    clearTimeout(eventObject.timeout);
    delete eventObject.timeout;

    let errorMessage = `Event "${eventObject.event}" was aborted due to a bad connection`;
    let badConnectionError = new BadConnectionError(errorMessage, failureType);

    let callback = eventObject.callback;
    delete eventObject.callback;
    setTimeout(() => {
      callback.call(eventObject, badConnectionError, eventObject);
    }, 0);
  });
};

SCTransport.prototype._onClose = function (code, data) {
  delete this.socket.onopen;
  delete this.socket.onclose;
  delete this.socket.onmessage;
  delete this.socket.onerror;

  clearTimeout(this._connectTimeoutRef);
  clearTimeout(this._pingTimeoutTicker);
  clearTimeout(this._batchTimeout);

  if (this.state === this.OPEN) {
    this.state = this.CLOSED;
    this.emit('close', {code, data});
    this._abortAllPendingEventsDueToBadConnection('disconnect');

  } else if (this.state === this.CONNECTING) {
    this.state = this.CLOSED;
    this.emit('openAbort', {code, data});
    this._abortAllPendingEventsDueToBadConnection('connectAbort');
  }
};

SCTransport.prototype._handleTransmittedEventObject = function (obj, message) {
  if (obj && obj.event != null) {
    if (obj.cid == null) {
      this.emit('inboundTransmit', {...obj});
    } else {
      let response = new Response(this, obj.cid);
      this.emit('inboundInvoke', {...obj, response});
    }
  } else if (obj && obj.rid != null) {
    let eventObject = this._callbackMap[obj.rid];
    if (eventObject) {
      clearTimeout(eventObject.timeout);
      delete eventObject.timeout;
      delete this._callbackMap[obj.rid];

      if (eventObject.callback) {
        let rehydratedError = scErrors.hydrateError(obj.error);
        eventObject.callback(rehydratedError, obj.data);
      }
    }
  } else {
    this.emit('event', {event: 'raw', data: message});
  }
};

SCTransport.prototype._onMessage = function (message) {
  this.emit('event', {event: 'message', data: message});

  let obj = this.decode(message);

  // If ping
  if (obj === '#1') {
    this._resetPingTimeout();
    if (this.socket.readyState === this.socket.OPEN) {
      this.sendObject('#2');
    }
  } else {
    if (Array.isArray(obj)) {
      let len = obj.length;
      for (let i = 0; i < len; i++) {
        this._handleTransmittedEventObject(obj[i], message);
      }
    } else {
      this._handleTransmittedEventObject(obj, message);
    }
  }
};

SCTransport.prototype._onError = function (err) {
  this.emit('error', err);
};

SCTransport.prototype._resetPingTimeout = function () {
  if (this.pingTimeoutDisabled) {
    return;
  }

  let now = (new Date()).getTime();
  clearTimeout(this._pingTimeoutTicker);
  this._pingTimeoutTicker = setTimeout(() => {
    this._onClose(4000);
    this.socket.close(4000);
  }, this.pingTimeout);
};

SCTransport.prototype.getBytesReceived = function () {
  return this.socket.bytesReceived;
};

SCTransport.prototype.close = function (code, data) {
  if (this.state === this.OPEN || this.state === this.CONNECTING) {
    code = code || 1000;
    this._onClose(code, data);
    this.socket.close(code, data);
  }
};

SCTransport.prototype.transmitObject = function (eventObject, options) {
  let simpleEventObject = {
    event: eventObject.event,
    data: eventObject.data
  };

  if (eventObject.callback) {
    simpleEventObject.cid = eventObject.cid = this.callIdGenerator();
    this._callbackMap[eventObject.cid] = eventObject;
  }

  this.sendObject(simpleEventObject, options);

  return eventObject.cid || null;
};

SCTransport.prototype._handleEventAckTimeout = function (eventObject) {
  if (eventObject.cid) {
    delete this._callbackMap[eventObject.cid];
  }
  delete eventObject.timeout;

  let callback = eventObject.callback;
  if (callback) {
    delete eventObject.callback;
    let error = new TimeoutError(`Event response for "${eventObject.event}" timed out`);
    callback.call(eventObject, error, eventObject);
  }
};

SCTransport.prototype.transmit = function (event, data, options) {
  let eventObject = {
    event: event,
    data: data
  };

  if (this.state === this.OPEN || options.force) {
    this.transmitObject(eventObject, options);
  }
  return Promise.resolve();
};

SCTransport.prototype.invokeRaw = function (event, data, options, callback) {
  let eventObject = {
    event: event,
    data: data,
    callback: callback
  };

  if (!options.noTimeout) {
    eventObject.timeout = setTimeout(() => {
      this._handleEventAckTimeout(eventObject);
    }, this.options.ackTimeout);
  }
  let cid = null;
  if (this.state === this.OPEN || options.force) {
    cid = this.transmitObject(eventObject, options);
  }
  return cid;
};

SCTransport.prototype.invoke = function (event, data, options) {
  return new Promise((resolve, reject) => {
    this.invokeRaw(event, data, options, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
};

SCTransport.prototype.cancelPendingResponse = function (cid) {
  delete this._callbackMap[cid];
};

SCTransport.prototype.decode = function (message) {
  return this.codec.decode(message);
};

SCTransport.prototype.encode = function (object) {
  return this.codec.encode(object);
};

SCTransport.prototype.send = function (data) {
  if (this.socket.readyState !== this.socket.OPEN) {
    this._onClose(1005);
  } else {
    this.socket.send(data);
  }
};

SCTransport.prototype.serializeObject = function (object) {
  let str, formatError;
  try {
    str = this.encode(object);
  } catch (err) {
    formatError = err;
    this._onError(formatError);
  }
  if (!formatError) {
    return str;
  }
  return null;
};

SCTransport.prototype.sendObjectBatch = function (object) {
  this._batchSendList.push(object);
  if (this._batchTimeout) {
    return;
  }

  this._batchTimeout = setTimeout(() => {
    delete this._batchTimeout;
    if (this._batchSendList.length) {
      let str = this.serializeObject(this._batchSendList);
      if (str != null) {
        this.send(str);
      }
      this._batchSendList = [];
    }
  }, this.options.pubSubBatchDuration || 0);
};

SCTransport.prototype.sendObjectSingle = function (object) {
  let str = this.serializeObject(object);
  if (str != null) {
    this.send(str);
  }
};

SCTransport.prototype.sendObject = function (object, options) {
  if (options && options.batch) {
    this.sendObjectBatch(object);
  } else {
    this.sendObjectSingle(object);
  }
};

module.exports.SCTransport = SCTransport;

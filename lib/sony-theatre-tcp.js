'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`Expected an integer from ${min} to ${max}`);
  }
  return value;
}

function choice(value, values) {
  if (!values.includes(value)) {
    throw new TypeError(`Expected one of: ${values.join(', ')}`);
  }
  return value;
}

function toggle(value, on = 'on', off = 'off') {
  if (typeof value !== 'boolean') {
    throw new TypeError('Expected a boolean');
  }
  return value ? on : off;
}

/**
 * Sony BRAVIA Theatre TCP client.
 *
 * - All commands return promises.
 * - Getters return raw device values, often strings.
 * - Setters return the device acknowledgement.
 * - Requests are serialized.
 * - The next request reconnects after a connection loss.
 * - Failed commands are never automatically replayed.
 * - DRC and Auto Volume require polling.
 *
 * Events:
 *   notification: { feature, type, value }
 *   connectionError: Error
 *   disconnect
 */
class SonyTheatreTcp extends EventEmitter {
  constructor({ host, port = 33336, timeout = 5000 } = {}) {
    super();

    if (typeof host !== 'string' || !host.trim()) {
      throw new TypeError('host must be an IP address or hostname');
    }

    this.host = host;
    this.port = integer(Number(port), 1, 65535);
    this.timeout = integer(timeout, 1, 2147483647);

    this._socket = null;
    this._connecting = null;
    this._pending = null;
    this._queue = Promise.resolve();
    this._buffer = '';
    this._closed = false;
  }

  get connected() {
    return Boolean(
      this._socket
      && !this._socket.destroyed
      && !this._socket.connecting
    );
  }

  async connect() {
    if (this._closed) {
      throw new Error('Client is closed; create a new instance');
    }

    if (this._connecting) return this._connecting;
    if (this.connected) return;

    const socket = new net.Socket();

    this._socket = socket;
    this._buffer = '';

    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    const connection = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy(new Error('TCP connection timed out'));
      }, this.timeout);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });

      socket.on('data', data => {
        this.emit('rawData', data);
        this._receive(data);
      });

      socket.on('error', error => {
        clearTimeout(timer);
        reject(error);
        this._rejectPending(error);

        // Avoid EventEmitter's special unhandled 'error' event.
        this.emit('connectionError', error);
      });

      socket.once('close', () => {
        clearTimeout(timer);

        const error = new Error('TCP connection closed');
        reject(error);

        if (this._socket === socket) {
          this._socket = null;
          this._buffer = '';
          this._rejectPending(error);
          this.emit('disconnect');
        }
      });

      socket.connect(this.port, this.host);
    });

    this._connecting = connection;

    try {
      await connection;
    } finally {
      if (this._connecting === connection) {
        this._connecting = null;
      }
    }
  }

  /**
   * Permanent shutdown.
   * Create a new instance if you need to connect again.
   */
  close() {
    this._closed = true;
    this._rejectPending(new Error('Client closed'));
    this._socket?.destroy();
  }

  _rejectPending(error) {
    if (!this._pending) return;

    const pending = this._pending;
    this._pending = null;

    clearTimeout(pending.timer);
    pending.reject(error);
  }

  /**
   * TCP chunks may contain partial or multiple JSON messages.
   * Extract complete objects, including messages without newlines.
   */
  _receive(data) {
    this._buffer += data;

    if (this._buffer.length > 1024 * 1024) {
      this._socket?.destroy(
        new Error('TCP response exceeds 1 MiB')
      );
      return;
    }

    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let consumed = 0;

    for (let i = 0; i < this._buffer.length; i += 1) {
      const char = this._buffer[i];

      if (start < 0) {
        if (/\s/.test(char)) {
          consumed = i + 1;
          continue;
        }

        if (char !== '{') {
          this._socket?.destroy(
            new Error('Expected a JSON object from device')
          );
          return;
        }

        start = i;
      }

      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          quoted = false;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
      }

      if (depth === 0 && !quoted) {
        let message;

        try {
          message = JSON.parse(
            this._buffer.slice(start, i + 1)
          );
        } catch {
          this._socket?.destroy(
            new Error('Invalid JSON response from device')
          );
          return;
        }

        consumed = i + 1;
        start = -1;

        this._handleMessage(message);
      }
    }

    this._buffer = this._buffer.slice(consumed);
  }

  _handleMessage(message) {
    if (message.type === 'notify') {
      this.emit('notification', message);
      return;
    }

    const pending = this._pending;

    if (message.type !== 'result' || !pending) return;

    // Error replies may omit the ID.
    // Only one request is ever in flight.
    if (
      message.id !== undefined
      && String(message.id) !== String(pending.id)
    ) {
      return;
    }

    if (
      message.feature !== undefined
      && message.feature !== pending.feature
    ) {
      return;
    }

    if (
      message.value === 'ERR'
      || message.error !== undefined
    ) {
      const error = new Error(
        `Sony rejected ${pending.type} ${pending.feature}`
      );

      error.response = message;
      this._rejectPending(error);
      return;
    }

    this._pending = null;
    clearTimeout(pending.timer);
    pending.resolve(message.value);
  }

  _request(type, feature, value) {
    if (typeof feature !== 'string' || !feature) {
      return Promise.reject(
        new TypeError('feature must be a non-empty string')
      );
    }

    const operation = this._queue.then(async () => {
      await this.connect();

      if (this._closed) {
        throw new Error('Client closed');
      }

      // Preserve the documented command IDs.
      const id = feature === 'main.power'
        ? 3
        : feature.startsWith('main.')
          ? 2
          : 1;

      const request = { id, type, feature };

      if (type === 'set') {
        request.value = value;
      }

      const payload = `${JSON.stringify(request)}\n`;
      const socket = this._socket;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._rejectPending(
            new Error(
              `TCP request timed out: ${type} ${feature}`
            )
          );

          // Prevent a late response from matching a later request.
          socket.destroy();
        }, this.timeout);

        this._pending = {
          id,
          type,
          feature,
          timer,
          resolve,
          reject,
        };

        socket.write(payload, error => {
          if (error) socket.destroy(error);
        });
      });
    });

    // Keep the queue usable after a failed request.
    this._queue = operation.catch(() => {});

    return operation;
  }

  // Generic commands

  get(feature) {
    return this._request('get', feature);
  }

  set(feature, value) {
    return this._request('set', feature, value);
  }

  // Power

  getPower() {
    return this.get('main.power');
  }

  async setPower(enabled) {
    return this.set('main.power', toggle(enabled));
  }

  powerOn() {
    return this.setPower(true);
  }

  powerOff() {
    return this.setPower(false);
  }

  // Volume: 0–100

  getVolume() {
    return this.get('main.volumestep');
  }

  async setVolume(value) {
    return this.set(
      'main.volumestep',
      integer(value, 0, 100)
    );
  }

  // Rear level: -10–10

  getRearLevel() {
    return this.get('main.rearvolumestep');
  }

  async setRearLevel(value) {
    return this.set(
      'main.rearvolumestep',
      integer(value, -10, 10)
    );
  }

  // Source

  getSource() {
    return this.get('main.input');
  }

  async setSource(value) {
    // AirPlay can be detected, but must start from a sender.
    return this.set(
      'main.input',
      choice(value, [
        'tv',
        'hdmi1',
        'spotify',
        'bluetooth',
      ])
    );
  }

  // Bass:
  // With subwoofer: -10–10
  // Without: 0 = MIN, 1 = MID, 2 = MAX

  getBassLevel() {
    return this.get('main.bassstep');
  }

  async setBassLevel(value, { hasSubwoofer } = {}) {
    if (typeof hasSubwoofer !== 'boolean') {
      throw new TypeError(
        'Provide { hasSubwoofer: true } or { hasSubwoofer: false }'
      );
    }

    return this.set(
      'main.bassstep',
      hasSubwoofer
        ? integer(value, -10, 10)
        : integer(value, 0, 2)
    );
  }

  // Voice enhancer

  getVoiceEnhancer() {
    return this.get('audio.voiceenhancer');
  }

  async setVoiceEnhancer(enabled) {
    return this.set(
      'audio.voiceenhancer',
      toggle(enabled, 'upon', 'upoff')
    );
  }

  // Sound field

  getSoundField() {
    return this.get('audio.soundfield');
  }

  async setSoundField(enabled) {
    return this.set(
      'audio.soundfield',
      toggle(enabled)
    );
  }

  // Night mode

  getNightMode() {
    return this.get('audio.nightmode');
  }

  async setNightMode(enabled) {
    return this.set(
      'audio.nightmode',
      toggle(enabled)
    );
  }

  // HDMI CEC

  getHdmiCec() {
    return this.get('hdmi.cec');
  }

  async setHdmiCec(enabled) {
    return this.set('hdmi.cec', toggle(enabled));
  }

  // Auto standby

  getAutoStandby() {
    return this.get('system.autostandby');
  }

  async setAutoStandby(enabled) {
    return this.set(
      'system.autostandby',
      toggle(enabled)
    );
  }

  // Dynamic Range Compressor: 'auto', 'on', 'off'

  getDrc() {
    return this.get('audio.drangecomp');
  }

  async setDrc(value) {
    return this.set(
      'audio.drangecomp',
      choice(value, ['auto', 'on', 'off'])
    );
  }

  // Auto Volume

  getAutoVolume() {
    return this.get('audio.aav');
  }

  async setAutoVolume(enabled) {
    return this.set('audio.aav', toggle(enabled));
  }

  getMute() {
    return this.get('main.mute');
  }

  async setMute(enabled) {
    return this.set('main.mute', toggle(enabled));
  }

    // Voice Zoom 3 level: -6–6, step 1

    getVoiceZoom3Value() {
    return this.get('audio.voicezoom3value');
    }

    async setVoiceZoom3Value(value) {
    return this.set(
        'audio.voicezoom3value',
        integer(value, -6, 6)
    );
    }

}

module.exports = SonyTheatreTcp;
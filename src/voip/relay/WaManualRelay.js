import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { DtlsClient } from './dtls/handshake.js';
import { PreNegotiatedDataChannel } from './datachannel/pre-negotiated.js';
import { createNoopLogger } from '../shim/core.js';
import { toError } from '../shim/util.js';
import { TEXT_ENCODER, toArrayBuffer } from '../bytes.js';
import { buildAllocateForRelay, buildBindingRequest, buildBindingRequestWithSubs, buildRelayBindingSuccess, buildSenderSubscriptions, buildSSRCSubscriptionList, buildWhatsAppPing, parseStunResponse } from './stun.js';
import { PayloadType } from '../types.js';

const CONFIG = {
  TRUE_WEB_CLIENT_RELAY_PORT: 3480,
  CONNECTION_TIMEOUT_MS: 20_000,

  ICE_BINDING_TIMEOUTS_MS: [250, 400, 600, 1000, 1500, 2000],
  KEEPALIVE_INTERVAL_MS: 1000,
  ICE_BINDING_ENABLED: false,
  ICE_CONSENT_REFRESH_ENABLED: false,
  ICE_CONSENT_REFRESH_MS: 400,
  MAX_BUFFER_SIZE: 256 * 1024,
};

const ConnectionState = {
  None: 'None',
  Connecting: 'Connecting',
  Open: 'Open',
  Closed: 'Closed',
  Failed: 'Failed',
};

function byteLengthOf(data) {
  return data?.byteLength ?? data?.length ?? 0;
}

function randomUfrag() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export class WaManualRelay extends EventEmitter {
  logger;
  connections = new Map();
  relayMap = new Map();
  audioSsrc = 0;
  videoSsrc = 0;
  subscriptionSsrc = 0;
  selfPid = 0;
  peerPid = 0;
  rxStun = { bindReq: 0, bindAnswered: 0, allocOk: 0, allocErr: 0, pong: 0, other: 0 };
  configuring = false;
  globalBuffer = [];
  globalBufferedBytes = 0;
  stats = { sent: 0, received: 0, connected: 0 };
  retrySchedule = [1000, 2000, 4000];

  constructor(options = {}) {
    super();
    this.logger = options.logger ?? createNoopLogger();
  }

  setSsrc(ssrc) {
    this.audioSsrc = ssrc;
  }

  setParticipantIds(selfPid, peerPid) {
    this.selfPid = selfPid ?? 0;
    this.peerPid = peerPid ?? 0;
  }

  getRxStunStats() {
    return { ...this.rxStun };
  }

  setVideoSsrc(ssrc) {
    this.videoSsrc = ssrc;
  }

  setSubscriptionSsrc(ssrc) {
    this.subscriptionSsrc = ssrc;
  }

  makeConnectionId(ip, port, authTokenId) {
    const base = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
    return authTokenId ? `${base}#${authTokenId}` : base;
  }

  async configureRelays(relays) {
    this.configuring = true;
    for (const relay of relays) {
      const port = relay.port || CONFIG.TRUE_WEB_CLIENT_RELAY_PORT;
      const connectionId = this.makeConnectionId(relay.ip, port, relay.authTokenId);
      this.relayMap.set(connectionId, {
        id: connectionId,
        ip: relay.ip,
        port,
        token: relay.token,
        authToken: relay.authToken,
        rawAuthToken: relay.rawAuthToken,
        rawToken: relay.rawToken,
        key: relay.key,
        relayId: relay.relayId,
        name: relay.name || 'unknown',
        authTokenId: relay.authTokenId,
        isFna: relay.isFna
      });
    }
    const connectionPromises = [];
    for (const [, relayInfo] of this.relayMap) {
      if (!this.connections.has(relayInfo.id)) {
        connectionPromises.push(this.ensureConnection(relayInfo));
      }
    }
    await Promise.all(connectionPromises);
    this.configuring = false;
    if (this.globalBuffer.length > 0) {
      for (const item of this.globalBuffer) this.sendToRelay(item.ip, item.port, item.data);
      this.globalBuffer = [];
      this.globalBufferedBytes = 0;
    }
  }

  getOrCreateConnection(relayInfo) {
    let conn = this.connections.get(relayInfo.id);
    if (!conn) {
      conn = {
        state: ConnectionState.None,
        relayInfo,
        socket: null,
        dtlsClient: null,
        dataChannel: null,
        packetBuffer: [],
        bufferedBytes: 0,
        connectPromise: null,
        connectionTimeout: null,
        keepaliveTimer: null,
        iceConsentTimer: null,
        retryTimer: null,
        retryCount: 0,
        recovering: false,
        lastInboundAt: 0,
        localUfrag: randomUfrag(),
        stats: { sentPackets: 0, receivedPackets: 0, sentBytes: 0, receivedBytes: 0 }
      };
      this.connections.set(relayInfo.id, conn);
    }
    return conn;
  }

  ensureConnection = async (relayInfo) => {
    const conn = this.getOrCreateConnection(relayInfo);
    if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Connecting) {
      return (conn.connectPromise ?? Promise.resolve()).catch(() => {});
    }
    const promise = this.connect(conn);
    conn.connectPromise = promise;
    try {
      await promise;
    } catch { } finally {
      conn.connectPromise = null;
    }
  };

  performIceBinding(socket, relayInfo, conn) {
    return new Promise((resolve) => {
      const iceUfrag = relayInfo.authToken || relayInfo.token || '';
      const icePwd = relayInfo.key || '';

      const username = TEXT_ENCODER.encode(`${iceUfrag}:${conn.localUfrag}`);
      const hmacKey = TEXT_ENCODER.encode(icePwd);
      let attempt = 0;
      let settled = false;
      let timer = null;

      const onMessage = (datagram) => {
        if (settled || datagram.length < 2) return;

        if ((datagram[0] & 0xc0) !== 0) return;
        const info = parseStunResponse(datagram);
        if (info && info.method === 'binding' && (info.isSuccess || info.isError)) {
          settled = true;
          clearTimeout(timer);
          socket.removeListener('message', onMessage);
          resolve(info.isSuccess);
        }
      };
      socket.on('message', onMessage);

      const sendAttempt = () => {
        if (settled) return;
        if (attempt >= CONFIG.ICE_BINDING_TIMEOUTS_MS.length) {
          settled = true;
          socket.removeListener('message', onMessage);
          resolve(false);
          return;
        }
        const packet = buildBindingRequest(username, hmacKey, undefined, { iceRole: 'controlling' });
        try {
          socket.send(packet, relayInfo.port, relayInfo.ip);
        } catch { }
        const wait = CONFIG.ICE_BINDING_TIMEOUTS_MS[attempt];
        attempt += 1;
        timer = setTimeout(sendAttempt, wait);
      };
      sendAttempt();
    });
  }

  startIceConsentRefresh(socket, relayInfo, conn) {
    const iceUfrag = relayInfo.authToken || relayInfo.token || '';
    const icePwd = relayInfo.key || '';

    const username = TEXT_ENCODER.encode(`${iceUfrag}:${conn.localUfrag}`);
    const hmacKey = TEXT_ENCODER.encode(icePwd);
    if (conn.iceConsentTimer) clearInterval(conn.iceConsentTimer);
    conn.iceConsentTimer = setInterval(() => {
      if (conn.state !== ConnectionState.Open || !conn.socket) {
        clearInterval(conn.iceConsentTimer);
        conn.iceConsentTimer = null;
        return;
      }
      try {
        const packet = buildBindingRequest(username, hmacKey, undefined, { iceRole: 'controlling' });
        socket.send(packet, relayInfo.port, relayInfo.ip);
      } catch { }
    }, CONFIG.ICE_CONSENT_REFRESH_MS);
  }

  connect = async (conn) => {
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Connecting;
    const relayInfo = conn.relayInfo;
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      conn.socket = socket;
      const targetIp = relayInfo.ip;
      const targetPort = relayInfo.port;

      let settledConn = false;
      const settle = (err) => {
        if (settledConn) return;
        settledConn = true;
        if (conn.connectionTimeout) {
          clearTimeout(conn.connectionTimeout);
          conn.connectionTimeout = null;
        }
        if (err) {
          conn.state = ConnectionState.Failed;
          this.closePeerObjects(conn);
          reject(err);
        } else {
          resolve();
        }
      };

      const connLogger = this.logger.child?.({ connectionId: relayInfo.id }) ?? this.logger;

      const dtls = new DtlsClient({
        sendDatagram: (datagram) => {
          try { socket.send(datagram, targetPort, targetIp); } catch { }
        },
        logger: connLogger
      });
      conn.dtlsClient = dtls;

      const dc = new PreNegotiatedDataChannel({
        sendDtlsPayload: (plaintext) => {
          if (!dtls.isConnected) return;
          const record = dtls.encryptApplicationData(plaintext);
          try { socket.send(record, targetPort, targetIp); } catch { }
        },
        logger: connLogger
      });
      conn.dataChannel = dc;

      let iceBindingDone = false;
      socket.on('message', (datagram) => {
        if (!iceBindingDone) {
          return;
        }

        const isDtlsRecord = datagram.length >= 1 && datagram[0] >= 20 && datagram[0] <= 63;
        if (!isDtlsRecord) {
          return;
        }
        if (dtls.isConnected) {
          const payloads = dtls.decryptApplicationData(datagram);
          for (const payload of payloads) dc.handleDtlsPayload(payload);
        } else {
          try {
            dtls.handleDatagram(datagram);
          } catch { }
        }
      });
      socket.on('error', (err) => {
        if (conn.state === ConnectionState.Open) this.handleRelayLoss(conn);
        settle(err instanceof Error ? err : new Error(String(err)));
      });

      dtls.on('connected', () => {
        dc.start();
      });
      dtls.on('error', (err) => {
        settle(err);
      });
      dc.on('open', () => {
        conn.state = ConnectionState.Open;
        this.flushBufferedPackets(conn);
        conn.lastInboundAt = Date.now();
        this.startKeepalive(conn);
        if (CONFIG.ICE_CONSENT_REFRESH_ENABLED) this.startIceConsentRefresh(socket, relayInfo, conn);
        this.sendStunAllocateOnOpen(conn, relayInfo);
        for (const delayMs of [50, 150, 500, 3000]) setTimeout(() => this.sendStunAllocateOnOpen(conn, conn.relayInfo), delayMs);
        this.sendToChannel(conn, toArrayBuffer(buildWhatsAppPing()));
        this.stats.connected++;
        const wasRecovering = conn.recovering;
        if (wasRecovering) {
          conn.recovering = false;
          conn.retryCount = 0;
        }
        this.emit('relay_connected', { ip: relayInfo.ip, port: relayInfo.port });
        if (wasRecovering) this.emit('relay_recovered', { connectionId: relayInfo.id });
        settle(null);
      });
      dc.on('error', (err) => {
        settle(err);
      });
      dc.on('message', (payload) => {
        conn.lastInboundAt = Date.now();
        this.handleRelayStun(conn, relayInfo, payload);
        conn.stats.receivedPackets++;
        conn.stats.receivedBytes += byteLengthOf(payload);
        this.stats.received++;
        this.emit('relay_receive', { ip: relayInfo.ip, port: relayInfo.port, data: payload });
      });

      conn.connectionTimeout = setTimeout(() => {
        settle(new Error(`relay connect timed out after ${CONFIG.CONNECTION_TIMEOUT_MS}ms`));
      }, CONFIG.CONNECTION_TIMEOUT_MS);

      socket.bind(0, async () => {
        if (CONFIG.ICE_BINDING_ENABLED) {
          const bindingOk = await this.performIceBinding(socket, relayInfo, conn);
          if (settledConn) return;
          if (!bindingOk) {
            settle(new Error('ICE binding to relay failed or timed out'));
            return;
          }
        }

        iceBindingDone = true;
        dtls.start();
      });
    });
  };

  resendSubscriptions() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        this.sendStunAllocateOnOpen(conn, conn.relayInfo);
      }
    }
  }

  handleRelayStun(conn, relayInfo, payload) {
    const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (data.length < 20 || (data[0] & 0xc0) !== 0) return;
    const type = (data[0] << 8) | data[1];
    const cookie = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
    if (cookie !== 0x2112a442 && type !== 0x0802) return;
    if (type === 0x0001) {
      this.rxStun.bindReq++;
      if (!relayInfo.key) return;
      try {
        const response = buildRelayBindingSuccess(data.slice(8, 20), TEXT_ENCODER.encode(relayInfo.key));
        this.sendToChannel(conn, toArrayBuffer(response));
        this.rxStun.bindAnswered++;
      }
      catch (err) {
        this.logger.warn('[RELAY] binding success send failed', { message: toError(err).message });
      }
    }
    else if (type === 0x0103) {
      this.rxStun.allocOk++;
    }
    else if (type === 0x0113 || type === 0x0111) {
      if (this.rxStun.allocErr++ === 0) this.logger.warn('[RELAY] allocate/binding ERROR from relay', { connectionId: relayInfo.id, type: '0x' + type.toString(16), bytes: data.length, errorCode: parseStunResponse(data)?.errorCode });
    }
    else if (type === 0x0802) {
      this.rxStun.pong++;
    }
    else {
      this.rxStun.other++;
    }
  }

  sendStunAllocateOnOpen(conn, relayInfo) {
    if (!relayInfo.rawToken || relayInfo.rawToken.length === 0) {
      return;
    }
    if (!relayInfo.key) {
      return;
    }
    if (!this.audioSsrc) {
      return;
    }
    const hmacKey = TEXT_ENCODER.encode(relayInfo.key);
    const subs = buildSenderSubscriptions(this.subscriptionSsrc || this.audioSsrc);
    const remoteUfrag = relayInfo.authToken || relayInfo.token;
    if (remoteUfrag) {
      const username = TEXT_ENCODER.encode(`${remoteUfrag}:${conn.localUfrag}`);
      this.sendToChannel(conn, toArrayBuffer(buildBindingRequestWithSubs(username, hmacKey, subs, true, true)));
    }
    if (relayInfo.token && relayInfo.token !== remoteUfrag) {
      const username = TEXT_ENCODER.encode(`${relayInfo.token}:${conn.localUfrag}`);
      this.sendToChannel(conn, toArrayBuffer(buildBindingRequestWithSubs(username, hmacKey, subs, true, true)));
    }
    this.sendToChannel(conn, toArrayBuffer(buildBindingRequestWithSubs(undefined, undefined, subs, false, false)));

    const peerSsrcs = this.subscriptionSsrc ? [this.subscriptionSsrc] : [];
    const ssrcList = buildSSRCSubscriptionList([this.audioSsrc, this.videoSsrc], peerSsrcs, this.selfPid, this.peerPid);
    const username = remoteUfrag ? TEXT_ENCODER.encode(`${remoteUfrag}:${conn.localUfrag}`) : undefined;
    const packet = buildAllocateForRelay(relayInfo.rawToken, ssrcList, hmacKey, relayInfo.ip, relayInfo.port, username);
    conn.allocatePacket = toArrayBuffer(packet);
    this.sendToChannel(conn, conn.allocatePacket);
  }

  sendToChannel(conn, data) {
    if (conn.state !== ConnectionState.Open || !conn.dataChannel) return;
    try {
      conn.dataChannel.send(data);
      conn.stats.sentPackets++;
      conn.stats.sentBytes += byteLengthOf(data);
      this.stats.sent++;
    } catch { }
  }

  closePeerObjects(conn) {
    if (conn.keepaliveTimer) {
      clearInterval(conn.keepaliveTimer);
      conn.keepaliveTimer = null;
    }
    if (conn.iceConsentTimer) {
      clearInterval(conn.iceConsentTimer);
      conn.iceConsentTimer = null;
    }
    try { conn.dataChannel?.close?.(); } catch { }
    try { conn.dtlsClient?.close?.(); } catch { }
    try { conn.socket?.close?.(); } catch { }
    conn.socket = null;
    conn.dtlsClient = null;
    conn.dataChannel = null;
  }

  startKeepalive(conn) {
    if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer);
    conn.keepaliveTimer = setInterval(() => {
      if (conn.state !== ConnectionState.Open || !conn.dataChannel) return;
      if (Date.now() - conn.lastInboundAt > 15_000) {
        this.handleRelayLoss(conn);
        return;
      }

      if (conn.allocatePacket) this.sendToChannel(conn, conn.allocatePacket);
      this.sendToChannel(conn, toArrayBuffer(buildWhatsAppPing()));
    }, CONFIG.KEEPALIVE_INTERVAL_MS);
  }

  flushBufferedPackets(conn) {
    while (conn.packetBuffer.length > 0) {
      const packet = conn.packetBuffer.shift();
      if (!packet) continue;
      conn.bufferedBytes -= byteLengthOf(packet);
      try {
        conn.dataChannel.send(packet);
        conn.stats.sentPackets++;
        conn.stats.sentBytes += byteLengthOf(packet);
        this.stats.sent++;
      } catch { }
    }
  }

  bufferPacket(conn, packet) {
    const size = byteLengthOf(packet);
    if (size > CONFIG.MAX_BUFFER_SIZE) return false;
    while (conn.packetBuffer.length > 0 && conn.bufferedBytes + size > CONFIG.MAX_BUFFER_SIZE) {
      const dropped = conn.packetBuffer.shift();
      if (dropped) conn.bufferedBytes -= byteLengthOf(dropped);
    }
    conn.packetBuffer.push(packet);
    conn.bufferedBytes += size;
    return true;
  }

  sendToRelay(ip, port, data) {
    if (this.configuring) {
      this.globalBuffer.push({ ip, port, data });
      this.globalBufferedBytes += byteLengthOf(data);
      return;
    }
    for (const [, conn] of this.connections) {
      if (conn.relayInfo.ip !== ip || conn.relayInfo.port !== port) continue;
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        try {
          conn.dataChannel.send(data);
          conn.stats.sentPackets++;
          conn.stats.sentBytes += byteLengthOf(data);
          this.stats.sent++;
        } catch { }
      } else {
        this.bufferPacket(conn, data);
        if (!conn.recovering) void this.ensureConnection(conn.relayInfo);
      }
    }
  }

  broadcast(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const isAudio = bytes.length < 2 || (bytes[1] & 0x7f) !== PayloadType.H264;
    let sentAny = false;
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        try {
          conn.dataChannel.send(data, isAudio);
          conn.stats.sentPackets++;
          conn.stats.sentBytes += byteLengthOf(data);
          this.stats.sent++;
          sentAny = true;
        } catch { }
      }
    }
    return sentAny;
  }

  handleRelayLoss(conn) {
    if (conn.state !== ConnectionState.Open) return;
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Closed;
    if (!conn.recovering) conn.retryCount = 0;
    conn.recovering = true;
    this.emit('relay_lost', { connectionId: conn.relayInfo.id, anyOpen: this.hasConnection(), max: this.retrySchedule.length });
    this.scheduleRelayRetry(conn);
  }

  scheduleRelayRetry(conn) {
    if (conn.retryCount >= this.retrySchedule.length) {
      this.emit('relay_failed', { connectionId: conn.relayInfo.id, anyOpen: this.hasConnection(), max: this.retrySchedule.length });
      return;
    }
    const delay = this.retrySchedule[conn.retryCount];
    conn.retryCount += 1;
    conn.retryTimer = setTimeout(async () => {
      conn.retryTimer = null;
      if (this.connections.get(conn.relayInfo.id) !== conn) return;
      this.emit('relay_retrying', { connectionId: conn.relayInfo.id, attempt: conn.retryCount, anyOpen: this.hasConnection(), max: this.retrySchedule.length });
      await this.ensureConnection(conn.relayInfo);
      if (conn.state !== ConnectionState.Open) this.scheduleRelayRetry(conn);
    }, delay);
    conn.retryTimer.unref?.();
  }

  hasConnection() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open) return true;
    }
    return false;
  }

  getSendBacklog() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        return conn.dataChannel.getSendBacklog();
      }
    }
    return null;
  }

  getVideoFlushCount() {
    let total = 0;
    for (const [, conn] of this.connections) {
      const backlog = conn.dataChannel?.getSendBacklog?.();
      if (backlog) total += backlog.videoFlushes ?? 0;
    }
    return total;
  }
  getConnectedCount() {
    let count = 0;
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open) count++;
    }
    return count;
  }

  cleanup() {
    for (const [, conn] of this.connections) {
      if (conn.retryTimer) clearTimeout(conn.retryTimer);
      conn.retryTimer = null;
      this.closePeerObjects(conn);
    }
    this.connections.clear();
    this.relayMap.clear();
    this.globalBuffer = [];
    this.globalBufferedBytes = 0;
  }
}

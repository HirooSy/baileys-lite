import { EventEmitter } from "node:events";
import { createNoopLogger } from "../shim/core.js";
import { bytesToHex, toBytesView, toError } from "../shim/util.js";
import { readUInt32BE, TEXT_ENCODER, toArrayBuffer } from "../bytes.js";
import {
  buildAllocateForRelay,
  buildBindingRequestWithSubs,
  buildSenderSubscriptions,
  buildSSRCSubscriptionList,
  buildWhatsAppPing,
  classifyPacket,
  createStunTransactionId,
  formatStunResponse,
  parseStunResponse
} from "./stun.js";
import { WaRawUdpLeg } from "./WaRawUdpLeg.js";
let wrtcPromise = null;
async function loadWrtc() {
  if (!wrtcPromise) {
    wrtcPromise = import("@roamhq/wrtc").then((mod) => mod.default ?? mod).catch((err) => {
      wrtcPromise = null;
      throw new Error(
        `voip: gagal memuat @roamhq/wrtc (dependency bawaan). Coba "npm rebuild @roamhq/wrtc" atau install ulang paket. (${err?.message || err})`
      );
    });
  }
  return wrtcPromise;
}
function closeQuietly(closeable, logger) {
  try {
    closeable?.close();
  } catch (err) {
    logger.trace("close failed", { message: toError(err).message });
  }
}
const TRUE_WEB_CLIENT_RELAY_PORT = 3480;
const CONFIG = {
  TRUE_WEB_CLIENT_RELAY_PORT,
  CONNECTION_TIMEOUT: 2e4,
  KEEPALIVE_INTERVAL_MS: 1100,
  ICE_DISCONNECT_GRACE_MS: 4e3,
  FIXED_FINGERPRINT: "sha-256 F9:CA:0C:98:A3:CC:71:D6:42:CE:5A:E2:53:D2:15:20:D3:1B:BA:D8:57:A4:F0:AF:BE:0B:FB:F3:6B:0C:A0:68"
};
const REGISTRATION_RETRY_DELAYS_MS = [50, 150, 500, 3e3];
var ConnectionState =  ((ConnectionState2) => {
  ConnectionState2["None"] = "None";
  ConnectionState2["Connecting"] = "Connecting";
  ConnectionState2["Open"] = "Open";
  ConnectionState2["Closed"] = "Closed";
  ConnectionState2["Failed"] = "Failed";
  return ConnectionState2;
})(ConnectionState || {});
class WaSctpRelay extends EventEmitter {
  logger;
  useRawUdpTransport;
  connections =  new Map();
  relayMap =  new Map();
  stats = {
    sent: 0,
    received: 0,
    connected: 0
  };
  keepaliveTimers =  new Map();
  audioSsrc = 0;
  subscriptionSsrc = 0;
  selfStreamSsrcs = [];
  peerStreamSsrcs = [];
  selfPid = 0;
  peerPid = 0;
  constructor(options = {}) {
    super();
    this.logger = options.logger ?? createNoopLogger();
    this.useRawUdpTransport = options.useRawUdpTransport ?? false;
  }
  setSsrc(ssrc) {
    this.audioSsrc = ssrc;
    this.logger.debug("sctp ssrc set", { ssrc: `0x${ssrc.toString(16).padStart(8, "0")}` });
  }
  setSubscriptionSsrc(ssrc) {
    this.subscriptionSsrc = ssrc;
    this.logger.debug("sctp subscription ssrc set", {
      ssrc: `0x${ssrc.toString(16).padStart(8, "0")}`
    });
  }
  setStreamSsrcs(selfSsrcs, peerSsrcs) {
    this.selfStreamSsrcs = selfSsrcs.filter(Boolean);
    this.peerStreamSsrcs = peerSsrcs.filter(Boolean);
    this.logger.debug("sctp relay stream ssrcs set", {
      selfCount: this.selfStreamSsrcs.length,
      peerCount: this.peerStreamSsrcs.length
    });
  }
  setParticipantIds(selfPid, peerPid) {
    const nextSelfPid = selfPid ?? 0;
    const nextPeerPid = peerPid ?? 0;
    const changed = nextSelfPid !== this.selfPid || nextPeerPid !== this.peerPid;
    this.selfPid = nextSelfPid;
    this.peerPid = nextPeerPid;
    this.logger.debug("sctp participant ids set", {
      selfPid: this.selfPid,
      peerPid: this.peerPid
    });
    if (changed && this.selfPid && this.peerPid && this.hasConnection()) {
      this.resendSubscriptions();
    }
  }
  resendSubscriptions() {
    for (const conn of this.connections.values()) {
      if (conn.state !== "Open" ) continue;
      if (conn.rawLeg) {
        if (conn.rawLeg.isOpen && this.sendRawAllocate(conn, conn.relayInfo, "resend")) {
          this.logger.debug("raw udp allocate resent", { connectionId: conn.id });
        }
        continue;
      }
      if (conn.channel && conn.channel.readyState === "open") {
        this.sendStunAllocateOnOpen(conn, conn.relayInfo);
        this.logger.debug("sctp subscriptions resent", { connectionId: conn.id });
      }
    }
  }
  addRelayCandidate(sdp, ip, port) {
    const candidate = `a=candidate:2 1 udp 2122262783 ${ip} ${port} typ host generation 0 network-cost 5`;
    const endOfCandidates = "a=end-of-candidates";
    let modified = sdp.replace(/a=candidate:[^\r\n]+\r?\n/g, "");
    modified = modified.replace(/a=end-of-candidates\r?\n?/g, "");
    modified += candidate + "\r\n" + endOfCandidates + "\r\n";
    return modified;
  }

  modifySdpForRelay(sdp, relayInfo) {
    let modified = sdp;
    modified = modified.replace(/a=setup:actpass/g, "a=setup:passive");
    const iceUfrag = relayInfo.authToken || relayInfo.token || "";
    const icePwd = relayInfo.key;
    modified = modified.replace(/a=ice-ufrag:[^\r\n]+/g, `a=ice-ufrag:${iceUfrag}`);
    modified = modified.replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${icePwd}`);
    modified = modified.replace(
      /a=fingerprint:[^\r\n]+/g,
      `a=fingerprint:${CONFIG.FIXED_FINGERPRINT}`
    );
    modified = modified.replace(/a=max-message-size:[^\r\n]+/g, "a=max-message-size:1500");
    modified = modified.replace(/a=ice-options:[^\r\n]+\r?\n/g, "");
    modified = this.addRelayCandidate(modified, relayInfo.ip, relayInfo.port);
    return modified;
  }
  makeConnectionId(ip, port, authTokenId) {
    const base = ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
    return authTokenId ? `${base}#${authTokenId}` : base;
  }

  registerConnection(relayInfo) {
    const connectionId = this.makeConnectionId(
      relayInfo.ip,
      relayInfo.port,
      relayInfo.authTokenId
    );
    this.logger.debug("sctp connecting to relay", {
      connectionId,
      relayName: relayInfo.name
    });
    const conn = {
      state: "Connecting" ,
      peerConnection: null,
      channel: null,
      rawLeg: null,
      incomingChannels: [],
      buffer: [],
      bufferedBytes: 0,
      id: connectionId,
      relayInfo,
      connectionTimeout: null,
      hasReceivedFirstPacket: false,
      localUfrag: "",
      stableRoutingConnId: 0n,
      stunTransactionId: createStunTransactionId(),
      stats: { sentPackets: 0, receivedPackets: 0, sentBytes: 0, receivedBytes: 0 }
    };
    this.connections.set(connectionId, conn);
    return conn;
  }

  async startConnection(conn) {
    const connectionId = conn.id;
    const relayInfo = conn.relayInfo;
    if (this.useRawUdpTransport) {
      this.openRawUdpLeg(conn, relayInfo);
      return conn;
    }
    conn.connectionTimeout = setTimeout(() => {
      if (conn.state === "Connecting" ) {
        this.logger.warn("sctp connection timeout", { connectionId });
        this.failConnection(conn, "connection_timeout");
      }
    }, CONFIG.CONNECTION_TIMEOUT);
    try {
      const wrtc = await loadWrtc();
      const pc = new wrtc.RTCPeerConnection({ iceServers: [] });
      conn.peerConnection = pc;
      pc.oniceconnectionstatechange = () => {
        this.logger.debug("ice connection state changed", {
          connectionId,
          state: pc.iceConnectionState
        });
        if (pc.iceConnectionState === "failed") {
          this.failConnection(conn, "ice_connection_failed");
        }
        if (pc.iceConnectionState === "disconnected") {
          setTimeout(() => {
            if (conn.state !== "Failed"  && conn.state !== "Closed"  && pc.iceConnectionState === "disconnected") {
              this.failConnection(conn, "ice_disconnected_timeout");
            }
          }, CONFIG.ICE_DISCONNECT_GRACE_MS);
        }
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          this.logger.debug("ice connected", { connectionId });
          try {
            const stats = pc.getStats?.();
            if (stats) {
              stats.forEach((report) => {
                if (report.type === "candidate-pair" && report.state === "succeeded") {
                  this.logger.trace("ice candidate pair succeeded", {
                    connectionId,
                    localCandidateId: report.localCandidateId,
                    remoteCandidateId: report.remoteCandidateId
                  });
                }
              });
            }
          } catch (err) {
            this.logger.trace("getStats failed", { message: toError(err).message });
          }
        }
      };
      pc.onconnectionstatechange = () => {
        const connState = pc.connectionState;
        this.logger.debug("peer connection state changed", {
          connectionId,
          state: connState
        });
        if (connState === "connected") {
          this.logger.debug("sctp dtls fully connected", { connectionId });
        }
        if (connState === "failed") {
          this.logger.warn("sctp peer connection failed", { connectionId });
          this.failConnection(conn, "connection_state_failed");
        }
      };
      pc.onicegatheringstatechange = () => {
        this.logger.debug("ice gathering state changed", {
          connectionId,
          state: pc.iceGatheringState
        });
      };
      pc.onsignalingstatechange = () => {
        this.logger.debug("signaling state changed", {
          connectionId,
          state: pc.signalingState
        });
      };
      pc.ondatachannel = (event) => {
        const incomingChannel = event.channel;
        this.logger.debug("incoming data channel from relay", {
          connectionId,
          label: incomingChannel.label,
          channelId: incomingChannel.id
        });
        conn.incomingChannels.push(incomingChannel);
        incomingChannel.binaryType = "arraybuffer";
        incomingChannel.onmessage = (ev) => {
          const buffer = toBytesView(ev.data);
          this.logger.trace("data from incoming channel", {
            connectionId,
            size: buffer.length,
            packetKind: classifyPacket(buffer)
          });
          this.handleRelayMessage(buffer, relayInfo, conn);
        };
        incomingChannel.onopen = () => {
          this.logger.debug("incoming data channel opened", {
            connectionId,
            label: incomingChannel.label
          });
        };
        incomingChannel.onclose = () => {
          this.logger.debug("incoming data channel closed", {
            connectionId,
            label: incomingChannel.label
          });
        };
      };
      const channel = pc.createDataChannel("wa-web-call", {
        ordered: false
      });
      conn.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        this.logger.debug("sctp data channel open", { connectionId });
        conn.state = "Open" ;
        this.stats.connected++;
        if (conn.connectionTimeout) {
          clearTimeout(conn.connectionTimeout);
          conn.connectionTimeout = null;
        }
        this.sendStunAllocateOnOpen(conn, relayInfo);
        this.startKeepalive(connectionId, conn);
        this.drainBuffer(connectionId);
        this.emit("relay_connected", { ip: relayInfo.ip, port: relayInfo.port });
      };
      channel.onclose = () => {
        this.logger.debug("sctp data channel closed", { connectionId });
        this.closeConnection(connectionId);
      };
      channel.onmessage = (event) => {
        const buffer = toBytesView(event.data);
        if (conn.stats.receivedPackets === 0) {
          this.logger.trace("first message on data channel", {
            connectionId,
            size: buffer.length,
            dataType: typeof event.data
          });
        }
        this.handleRelayMessage(buffer, relayInfo, conn);
      };
      channel.onerror = () => {
        this.logger.warn("sctp data channel error", { connectionId });
        this.failConnection(conn, "data_channel_error");
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const localUfragMatch = offer.sdp.match(/a=ice-ufrag:([^\r\n]+)/);
      conn.localUfrag = localUfragMatch?.[1] || "";
      const modifiedSdp = this.modifySdpForRelay(offer.sdp, relayInfo);
      this.logger.debug("sdp relay candidate configured", {
        connectionId,
        candidate: `${relayInfo.ip}:${relayInfo.port}`,
        authTokenSize: relayInfo.rawAuthToken?.length ?? 0
      });
      await pc.setRemoteDescription({
        type: "answer",
        sdp: modifiedSdp
      });
      this.logger.debug("sctp relay configured, waiting for ice", { connectionId });
      return conn;
    } catch (err) {
      this.logger.error("sctp relay connect failed", {
        connectionId,
        message: toError(err).message
      });
      this.failConnection(conn, "connection_error");
      return null;
    }
  }
  failConnection(conn, reason) {
    if (!conn || conn.state === "Failed" ) return;
    this.logger.warn("sctp connection failed", { connectionId: conn.id, reason });
    this.releaseConnected(conn);
    conn.state = "Failed" ;
    this.stopKeepalive(conn.id);
    if (conn.connectionTimeout) clearTimeout(conn.connectionTimeout);
    closeQuietly(conn.channel, this.logger);
    for (const ch of conn.incomingChannels) closeQuietly(ch, this.logger);
    closeQuietly(conn.peerConnection, this.logger);
    closeQuietly(conn.rawLeg, this.logger);
    this.connections.delete(conn.id);
    this.announceLastLegLost(reason);
  }

  releaseConnected(conn) {
    if (conn.state !== "Open" ) return;
    this.stats.connected = Math.max(0, this.stats.connected - 1);
  }

  hasLiveLeg() {
    for (const conn of this.connections.values()) {
      if (conn.state === "Open"  || conn.state === "Connecting" ) {
        return true;
      }
    }
    return false;
  }

  announceLastLegLost(reason) {
    if (this.hasLiveLeg()) return;
    this.logger.warn("relay has no leg left, open or dialling", { reason });
    this.emit("relay_lost", { reason });
  }
  isConnOpen(conn) {
    if (conn.state !== "Open" ) return false;
    if (conn.rawLeg) return conn.rawLeg.isOpen;
    return conn.channel?.readyState === "open";
  }

  openRawUdpLeg(conn, relayInfo) {
    const connectionId = conn.id;
    conn.rawLeg = new WaRawUdpLeg({
      ip: relayInfo.ip,
      port: relayInfo.port,
      logger: this.logger.child({ connectionId }),
      onOpen: () => {
        if (conn.state !== "Connecting" ) return;
        conn.state = "Open" ;
        this.stats.connected++;
        if (conn.connectionTimeout) {
          clearTimeout(conn.connectionTimeout);
          conn.connectionTimeout = null;
        }
        this.logger.debug("raw udp relay leg open", {
          connectionId,
          ip: relayInfo.ip,
          port: relayInfo.port
        });
        this.sendRawAllocate(conn, relayInfo, "initial");
        for (const delayMs of REGISTRATION_RETRY_DELAYS_MS) {
          setTimeout(
            () => this.sendRawAllocate(conn, relayInfo, "retry"),
            delayMs
          ).unref();
        }
        this.startKeepalive(connectionId, conn);
        this.drainBuffer(connectionId);
        this.emit("relay_connected", { ip: relayInfo.ip, port: relayInfo.port });
      },
      onMessage: (data) => {
        this.handleRelayMessage(data, relayInfo, conn);
      },
      onFailure: (reason) => {
        this.failConnection(conn, reason);
      }
    });
    conn.connectionTimeout = setTimeout(() => {
      if (conn.state === "Connecting" ) {
        this.logger.warn("raw udp relay leg timeout", { connectionId });
        this.failConnection(conn, "raw_udp_open_timeout");
      }
    }, CONFIG.CONNECTION_TIMEOUT);
    conn.rawLeg.open();
  }

  sendRawAllocate(conn, relayInfo, label) {
    if (!this.isConnOpen(conn)) return false;
    if (!relayInfo.rawToken || relayInfo.rawToken.length === 0) {
      this.logger.debug("raw udp allocate skipped, no relay token", {
        connectionId: conn.id,
        label
      });
      return false;
    }
    const allocate = buildAllocateForRelay(
      relayInfo.rawToken,
      this.buildAllocateSsrcList(),
      TEXT_ENCODER.encode(relayInfo.key),
      relayInfo.ip,
      relayInfo.port,
      conn.stunTransactionId
    );
    const sent = this.sendToChannel(conn, toArrayBuffer(allocate));
    this.logger.trace("raw udp allocate sent", {
      connectionId: conn.id,
      label,
      size: allocate.length,
      sent
    });
    return sent;
  }

  buildAllocateSsrcList() {
    const selfSsrcs = this.selfStreamSsrcs.length ? this.selfStreamSsrcs : [this.audioSsrc];
    const peerSsrcs = this.peerStreamSsrcs.length ? this.peerStreamSsrcs : this.subscriptionSsrc ? [this.subscriptionSsrc] : [];
    return buildSSRCSubscriptionList(selfSsrcs, peerSsrcs, this.selfPid, this.peerPid);
  }
  sendStunAllocateOnOpen(conn, relayInfo) {
    const connectionId = `${relayInfo.ip}:${relayInfo.port}`;
    const remoteUfrag = relayInfo.authToken || relayInfo.token;
    if (!remoteUfrag) {
      this.logger.debug("stun registration skipped, no ufrag", { connectionId });
      return;
    }
    const localUfrag = conn.localUfrag;
    const hmacKey = TEXT_ENCODER.encode(relayInfo.key);
    const transactionId = conn.stunTransactionId;
    const sendRegistration = (label) => {
      if (!this.isConnOpen(conn)) {
        return;
      }
      const selfSsrc = this.audioSsrc;
      const peerSsrc = this.subscriptionSsrc;
      const ssrc = peerSsrc || selfSsrc;
      if (!ssrc) {
        this.logger.debug("stun registration skipped, no ssrc", { connectionId, label });
        return;
      }
      const subs = buildSenderSubscriptions(ssrc);
      if (localUfrag) {
        const username = TEXT_ENCODER.encode(`${remoteUfrag}:${localUfrag}`);
        const v1 = buildBindingRequestWithSubs(
          username,
          hmacKey,
          subs,
          true,
          true,
          transactionId
        );
        this.sendToChannel(conn, toArrayBuffer(v1));
        this.logger.trace("stun v1 auth token ufrag sent", {
          connectionId,
          label,
          size: v1.length,
          ssrc: `0x${ssrc.toString(16)}`
        });
      }
      if (relayInfo.token && relayInfo.token !== remoteUfrag && localUfrag) {
        const username = TEXT_ENCODER.encode(`${relayInfo.token}:${localUfrag}`);
        const v2 = buildBindingRequestWithSubs(
          username,
          hmacKey,
          subs,
          true,
          true,
          transactionId
        );
        this.sendToChannel(conn, toArrayBuffer(v2));
        this.logger.trace("stun v2 token ufrag sent", {
          connectionId,
          label,
          size: v2.length
        });
      }
      const v3 = buildBindingRequestWithSubs(
        void 0,
        void 0,
        subs,
        false,
        false,
        transactionId
      );
      this.sendToChannel(conn, toArrayBuffer(v3));
      this.logger.trace("stun v3 no-mi sent", { connectionId, label, size: v3.length });
      if (relayInfo.rawToken && relayInfo.rawToken.length > 0) {
        const v4 = buildAllocateForRelay(
          relayInfo.rawToken,
          this.buildAllocateSsrcList(),
          hmacKey,
          relayInfo.ip,
          relayInfo.port,
          transactionId
        );
        this.sendToChannel(conn, toArrayBuffer(v4));
        this.logger.trace("stun v4 allocate sent", { connectionId, label, size: v4.length });
      }
    };
    sendRegistration("initial");
    for (const delayMs of REGISTRATION_RETRY_DELAYS_MS) {
      setTimeout(() => sendRegistration(`retry-${delayMs}ms`), delayMs);
    }
  }
  startKeepalive(connectionId, conn) {
    this.stopKeepalive(connectionId);
    const firstPing = buildWhatsAppPing(conn.stunTransactionId);
    this.sendToChannel(conn, toArrayBuffer(firstPing));
    this.logger.debug("keepalive first ping sent", { connectionId });
    let keepaliveCount = 0;
    const timer = setInterval(() => {
      if (!this.isConnOpen(conn)) {
        this.stopKeepalive(connectionId);
        return;
      }
      const ping = buildWhatsAppPing(conn.stunTransactionId);
      this.sendToChannel(conn, toArrayBuffer(ping));
      keepaliveCount++;
      if (keepaliveCount % 3 === 0) {
        const pc = conn.peerConnection;
        const dcState = conn.channel?.readyState || "unknown";
        const iceState = pc?.iceConnectionState || "unknown";
        const connState = pc?.connectionState || "unknown";
        let bufferedAmount;
        try {
          const buffered = conn.channel?.bufferedAmount;
          if (buffered !== void 0) {
            bufferedAmount = buffered;
          }
        } catch (err) {
          this.logger.trace("bufferedAmount unavailable", {
            message: toError(err).message
          });
        }
        this.logger.debug("sctp relay diagnostics", {
          connectionId,
          dcState,
          iceState,
          connState,
          sentPackets: conn.stats.sentPackets,
          sentBytes: conn.stats.sentBytes,
          receivedPackets: conn.stats.receivedPackets,
          receivedBytes: conn.stats.receivedBytes,
          pongs: this.pongCount,
          rtpRecv: this.rtpRecvCount,
          keepalives: keepaliveCount,
          globalSend: this.sendCount,
          bufferedAmount
        });
      }
    }, CONFIG.KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimers.set(connectionId, timer);
    this.logger.debug("keepalive started", {
      connectionId,
      intervalMs: CONFIG.KEEPALIVE_INTERVAL_MS
    });
  }
  stopKeepalive(connectionId) {
    const timer = this.keepaliveTimers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.keepaliveTimers.delete(connectionId);
    }
  }
  closeConnection(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.releaseConnected(conn);
    conn.state = "Closed" ;
    this.stopKeepalive(connectionId);
    if (conn.connectionTimeout) clearTimeout(conn.connectionTimeout);
    for (const ch of conn.incomingChannels) closeQuietly(ch, this.logger);
    closeQuietly(conn.peerConnection, this.logger);
    closeQuietly(conn.rawLeg, this.logger);
    this.connections.delete(connectionId);
    this.announceLastLegLost("closed");
  }
  drainBuffer(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.state !== "Open"  || !conn.channel) return;
    while (conn.buffer.length > 0 && conn.channel.readyState === "open") {
      const data = conn.buffer.shift();
      if (data) {
        conn.bufferedBytes -= data.byteLength;
        this.sendToChannel(conn, data);
      }
    }
  }
  sendCount = 0;
  sendToChannel(conn, data) {
    try {
      if (conn.rawLeg) {
        if (!this.isConnOpen(conn)) return false;
        if (!conn.rawLeg.send(new Uint8Array(data))) return false;
        conn.stats.sentPackets++;
        conn.stats.sentBytes += data.byteLength;
        this.stats.sent++;
        this.sendCount++;
        return true;
      }
      if (!conn.channel || conn.channel.readyState !== "open") {
        return false;
      }
      let arrayBufferToSend;
      if (data.constructor.name === "SharedArrayBuffer") {
        const uint8 = new Uint8Array(data);
        const copied = new Uint8Array(uint8);
        arrayBufferToSend = copied.buffer;
      } else {
        arrayBufferToSend = data;
      }
      conn.channel.send(arrayBufferToSend);
      conn.stats.sentPackets++;
      conn.stats.sentBytes += data.byteLength;
      this.stats.sent++;
      this.sendCount++;
      if (this.sendCount <= 10 || this.sendCount % 100 === 0) {
        const buf = new Uint8Array(data);
        const firstByte = buf[0] || 0;
        const twoBits = (firstByte & 192) >> 6;
        const pktType = twoBits === 0 ? "STUN" : twoBits === 2 ? "RTP/SRTP" : "OTHER";
        this.logger.trace("sctp relay send", {
          count: this.sendCount,
          packetType: pktType,
          size: data.byteLength,
          connectionId: conn.id,
          hexPrefix: bytesToHex(buf.subarray(0, 20))
        });
      }
      return true;
    } catch (err) {
      this.logger.warn("sctp relay send failed", {
        connectionId: conn.id,
        message: toError(err).message
      });
      return false;
    }
  }
  pongCount = 0;
  rtpRecvCount = 0;
  unknownRecvCount = 0;
  handleRelayMessage(data, relayInfo, conn) {
    conn.stats.receivedPackets++;
    conn.stats.receivedBytes += data.length;
    this.stats.received++;
    const firstByte = data[0];
    const twoBits = (firstByte & 192) >> 6;
    const hexPreview = bytesToHex(data.subarray(0, Math.min(24, data.length)));
    const pktType = twoBits === 0 ? "STUN" : twoBits === 2 ? "RTP/SRTP" : twoBits === 1 ? "DTLS" : "UNKNOWN";
    if (!conn.hasReceivedFirstPacket) {
      conn.hasReceivedFirstPacket = true;
      this.logger.trace("first packet received from relay", { connectionId: conn.id });
    }
    const shouldLog = conn.stats.receivedPackets <= 50 || conn.stats.receivedPackets % 25 === 0 || twoBits === 2 || twoBits === 0 && data.length >= 20 && !this.isPong(data);
    if (shouldLog) {
      this.logger.trace("sctp relay receive", {
        count: conn.stats.receivedPackets,
        packetType: pktType,
        size: data.length,
        connectionId: conn.id,
        hexPreview
      });
    }
    if (twoBits === 0) {
      const stunInfo = parseStunResponse(data);
      if (stunInfo) {
        if (stunInfo.method === "wa-pong") {
          this.pongCount++;
          if (this.pongCount <= 3 || this.pongCount % 20 === 0) {
            this.logger.trace("stun pong received", {
              count: this.pongCount,
              connectionId: conn.id,
              size: data.length
            });
          }
        } else {
          this.logger.trace("stun response received", {
            connectionId: conn.id,
            summary: formatStunResponse(stunInfo),
            hex: bytesToHex(data)
          });
          if (stunInfo.isSuccess && (stunInfo.method === "binding" || stunInfo.method === "allocate")) {
            this.logger.debug("stun binding or allocate success", {
              connectionId: conn.id,
              method: stunInfo.method
            });
          }
          if (stunInfo.stableRoutingConnId && conn.stableRoutingConnId === 0n) {
            conn.stableRoutingConnId = stunInfo.stableRoutingConnId;
            this.logger.debug("stun stable routing latched", {
              connectionId: conn.id,
              connId: `0x${stunInfo.stableRoutingConnId.toString(16)}`
            });
          }
          if (stunInfo.isError) {
            this.logger.warn("stun error response", {
              connectionId: conn.id,
              errorCode: stunInfo.errorCode,
              errorReason: stunInfo.errorReason || ""
            });
          }
          for (const attr of stunInfo.attributes) {
            this.logger.trace("stun attribute", {
              connectionId: conn.id,
              typeName: attr.typeName,
              type: `0x${attr.type.toString(16)}`,
              length: attr.length,
              data: bytesToHex(attr.data.subarray(0, Math.min(32, attr.data.length)))
            });
          }
        }
      } else {
        this.logger.trace("unparseable stun-like packet", {
          connectionId: conn.id,
          size: data.length,
          hex: bytesToHex(data.subarray(0, 80))
        });
      }
    }
    if (twoBits === 2) {
      this.rtpRecvCount++;
      const pt = data[1] & 127;
      const seq = data.length >= 4 ? data[2] << 8 | data[3] : 0;
      const ssrc = data.length >= 12 ? readUInt32BE(data, 8) : 0;
      this.logger.trace("rtp packet received", {
        count: this.rtpRecvCount,
        payloadType: pt,
        sequence: seq,
        ssrc: `0x${ssrc.toString(16)}`,
        size: data.length,
        connectionId: conn.id
      });
      if (this.rtpRecvCount <= 3) {
        this.logger.trace("rtp packet hex preview", {
          connectionId: conn.id,
          hex: bytesToHex(data.subarray(0, 160))
        });
      }
    }
    if (twoBits !== 0 && twoBits !== 2) {
      this.unknownRecvCount++;
      this.logger.trace("unknown relay packet type", {
        count: this.unknownRecvCount,
        firstByte: `0x${firstByte.toString(16)}`,
        size: data.length,
        connectionId: conn.id,
        hex: bytesToHex(data.subarray(0, 80))
      });
    }
    this.emit("relay_receive", {
      ip: relayInfo.ip,
      port: relayInfo.port,
      data
    });
  }
  isPong(data) {
    if (data.length < 2) return false;
    const msgType = data[0] << 8 | data[1];
    return msgType === 2050;
  }
  async configureRelays(relays) {
    this.logger.debug("sctp configuring relays", { count: relays.length });
    for (const relay of relays) {
      const webClientPort = relay.port || CONFIG.TRUE_WEB_CLIENT_RELAY_PORT;
      const port = this.useRawUdpTransport ? relay.originalPort ?? webClientPort : webClientPort;
      const connectionId = this.makeConnectionId(relay.ip, port, relay.authTokenId);
      const relayInfo = {
        id: connectionId,
        ip: relay.ip,
        port,
        token: relay.token,
        authToken: relay.authToken,
        rawAuthToken: relay.rawAuthToken,
        rawToken: relay.rawToken,
        key: relay.key,
        relayId: relay.relayId,
        name: relay.name || "unknown",
        authTokenId: relay.authTokenId
      };
      this.relayMap.set(connectionId, relayInfo);
    }
    this.logger.debug("sctp relays registered", { count: this.relayMap.size });
    const legs = [];
    for (const [, relayInfo] of this.relayMap) {
      const connId = this.makeConnectionId(
        relayInfo.ip,
        relayInfo.port,
        relayInfo.authTokenId
      );
      if (!this.connections.has(connId)) {
        legs.push(this.registerConnection(relayInfo));
      }
    }
    await Promise.all(legs.map((conn) => this.startConnection(conn)));
    this.logger.debug("sctp relay configuration done", { connected: this.stats.connected });
  }

  broadcast(data) {
    let sent = false;
    for (const conn of this.connections.values()) {
      if (this.isConnOpen(conn) && this.sendToChannel(conn, data)) {
        sent = true;
      }
    }
    return sent;
  }
  hasConnection() {
    for (const conn of this.connections.values()) {
      if (conn.state === "Open" ) return true;
    }
    return false;
  }
  getConnectedCount() {
    return this.stats.connected;
  }
  cleanup() {
    this.logger.debug("sctp cleaning up connections", { count: this.connections.size });
    for (const [id] of this.keepaliveTimers) {
      this.stopKeepalive(id);
    }
    const closing = [...this.connections.values()];
    this.connections.clear();
    for (const conn of closing) {
      if (conn.connectionTimeout) clearTimeout(conn.connectionTimeout);
      closeQuietly(conn.channel, this.logger);
      for (const ch of conn.incomingChannels) closeQuietly(ch, this.logger);
      closeQuietly(conn.peerConnection, this.logger);
      closeQuietly(conn.rawLeg, this.logger);
    }
    this.relayMap.clear();
    this.stats.connected = 0;
    this.audioSsrc = 0;
    this.subscriptionSsrc = 0;
    this.selfStreamSsrcs = [];
    this.peerStreamSsrcs = [];
    this.selfPid = 0;
    this.peerPid = 0;
    this.pongCount = 0;
    this.rtpRecvCount = 0;
    this.unknownRecvCount = 0;
    this.sendCount = 0;
    this.logger.debug("sctp all connections cleaned");
  }
}
export {
  TRUE_WEB_CLIENT_RELAY_PORT,
  WaSctpRelay
};

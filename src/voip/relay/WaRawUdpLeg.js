import dgram from "node:dgram";
import { isIPv6 } from "node:net";
import { performance } from "node:perf_hooks";
import { toBytesView, toError } from "../shim/util.js";
import { isStunPacket } from "./stun.js";
const RAW_UDP_RETURN_PATH_TIMEOUT_MS = 5e3;
const RAW_UDP_RETURN_PATH_STALL_MS = 1e4;
const RAW_UDP_NO_RETURN_PATH = "raw_udp_no_return_path";
class WaRawUdpLeg {
  options;
  logger;
  returnPathTimeoutMs;
  stallTimeoutMs;
  socket = null;
  opened = false;
  closed = false;
  returnPathTimer = null;
  returnPathSeen = false;

  lastInboundAt = 0;
  constructor(options) {
    this.options = options;
    this.logger = options.logger;
    this.returnPathTimeoutMs = options.returnPathTimeoutMs ?? RAW_UDP_RETURN_PATH_TIMEOUT_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? RAW_UDP_RETURN_PATH_STALL_MS;
  }

  get isOpen() {
    return this.opened && !this.closed;
  }

  get hasReturnPath() {
    return this.returnPathSeen;
  }

  open() {
    if (this.socket || this.closed) return;
    try {
      const socket = dgram.createSocket(isIPv6(this.options.ip) ? "udp6" : "udp4");
      this.socket = socket;
      socket.on("message", (msg) => {
        if (this.closed) return;
        const data = toBytesView(msg);
        if (!isStunPacket(data)) {
          this.lastInboundAt = performance.now();
          if (!this.returnPathSeen) {
            this.returnPathSeen = true;
            this.logger.debug("raw udp leg return path confirmed", {
              bytes: data.length
            });
            if (!this.returnPathTimer) this.armReturnPathTimer(this.stallTimeoutMs);
          }
        }
        this.options.onMessage(data);
      });
      socket.on("error", (err) => {
        if (this.closed) return;
        this.logger.warn("raw udp leg socket error", { message: err.message });
        this.fail("raw_udp_socket_error");
      });
      socket.connect(this.options.port, this.options.ip, (err) => {
        if (this.closed) return;
        if (err) {
          this.logger.warn("raw udp leg connect failed", { message: err.message });
          this.fail("raw_udp_connect_failed");
          return;
        }
        this.opened = true;
        this.options.onOpen();
      });
    } catch (err) {
      this.logger.warn("raw udp leg open failed", { message: toError(err).message });
      this.fail("raw_udp_open_failed");
    }
  }

  send(data) {
    const socket = this.socket;
    if (!socket || !this.isOpen) return false;
    try {
      socket.send(data);
    } catch (err) {
      this.logger.trace("raw udp leg send failed", { message: toError(err).message });
      return false;
    }
    if (!this.returnPathSeen && !this.returnPathTimer && !isStunPacket(data)) {
      this.armReturnPathTimer(this.returnPathTimeoutMs);
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    this.clearReturnPathTimer();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch (err) {
      this.logger.trace("raw udp leg close failed", { message: toError(err).message });
    }
  }

  armReturnPathTimer(timeoutMs) {
    this.clearReturnPathTimer();
    this.returnPathTimer = setTimeout(() => {
      this.returnPathTimer = null;
      if (this.closed) return;
      const idleMs = performance.now() - this.lastInboundAt;
      if (this.returnPathSeen && idleMs < this.stallTimeoutMs) {
        this.armReturnPathTimer(this.stallTimeoutMs - idleMs);
        return;
      }
      this.logger.warn("raw udp leg rolled back, no media on the return path", {
        ip: this.options.ip,
        port: this.options.port,
        confirmed: this.returnPathSeen,
        idleMs
      });
      this.fail(RAW_UDP_NO_RETURN_PATH);
    }, timeoutMs);
  }
  clearReturnPathTimer() {
    if (!this.returnPathTimer) return;
    clearTimeout(this.returnPathTimer);
    this.returnPathTimer = null;
  }
  fail(reason) {
    if (this.closed) return;
    this.close();
    this.options.onFailure(reason);
  }
}
export {
  RAW_UDP_NO_RETURN_PATH,
  RAW_UDP_RETURN_PATH_STALL_MS,
  RAW_UDP_RETURN_PATH_TIMEOUT_MS,
  WaRawUdpLeg
};

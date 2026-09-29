import { bytesToHex } from "../shim/util.js";
import {
  concatBytes,
  readBigUInt64BE,
  readUInt16BE,
  readUInt32BE,
  TEXT_DECODER,
  writeUInt16BE,
  writeUInt32BE
} from "../bytes.js";
import { hmacSha1, randomBytes } from "../crypto/primitives.js";
import { encodeProtoLengthDelimited, encodeProtoVarintField } from "../protobuf.js";
const STUN_MAGIC_COOKIE = 554869826;
const STUN_FINGERPRINT_XOR = 1398035790;
const STUN_BINDING_REQUEST = 1;
const STUN_ALLOCATE_REQUEST = 3;
const WHATSAPP_PING = 2049;
const WHATSAPP_PONG = 2050;
const ATTR_USERNAME = 6;
const ATTR_MESSAGE_INTEGRITY = 8;
const ATTR_XOR_RELAYED_ADDRESS = 22;
const ATTR_PRIORITY = 36;
const ATTR_RELAY_CREDENTIAL = 16384;
const ATTR_SSRC_LIST = 16420;
const ATTR_ICE_CONTROLLING = 32810;
const ATTR_FINGERPRINT = 32808;
const DEFAULT_ICE_PRIORITY = 16777215;
const TRANSACTION_ID_LENGTH = 12;
const RELAY_KEY_WORD_BYTES = 4;
const STUN_ADDRESS_FAMILY_IPV4 = 1;
const STUN_ADDRESS_FAMILY_IPV6 = 2;
const IPV4_ADDRESS_BYTES = 4;
const IPV6_ADDRESS_BYTES = 16;
const XOR_RELAYED_IPV4_BYTES = 4 + IPV4_ADDRESS_BYTES;
const XOR_RELAYED_IPV6_BYTES = 4 + IPV6_ADDRESS_BYTES;
function createStunTransactionId() {
  return randomBytes(TRANSACTION_ID_LENGTH);
}
function encodeAttribute(attrType, data) {
  const header = new Uint8Array(4);
  writeUInt16BE(header, attrType, 0);
  writeUInt16BE(header, data.length, 2);
  const padding = (4 - data.length % 4) % 4;
  const pad = new Uint8Array(padding);
  return concatBytes([header, data, pad]);
}
function crc32(data) {
  let crc = 4294967295;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = crc >>> 1 ^ 3988292384;
      } else {
        crc >>>= 1;
      }
    }
  }
  return (crc ^ 4294967295) >>> 0;
}
function buildStunMessage(msgType, attrs, transactionId, integrityKey, includeFingerprint = true) {
  let attrsData = attrs;
  if (integrityKey) {
    const msgLenForHmac = attrsData.length + 24;
    const hmacHeader = new Uint8Array(20);
    writeUInt16BE(hmacHeader, msgType, 0);
    writeUInt16BE(hmacHeader, msgLenForHmac, 2);
    writeUInt32BE(hmacHeader, STUN_MAGIC_COOKIE, 4);
    hmacHeader.set(transactionId, 8);
    const hmacInput = concatBytes([hmacHeader, attrsData]);
    const hmac = hmacSha1(integrityKey, hmacInput);
    const miAttr = encodeAttribute(ATTR_MESSAGE_INTEGRITY, hmac);
    attrsData = concatBytes([attrsData, miAttr]);
  }
  if (includeFingerprint) {
    const msgLenForCrc = attrsData.length + 8;
    const crcHeader = new Uint8Array(20);
    writeUInt16BE(crcHeader, msgType, 0);
    writeUInt16BE(crcHeader, msgLenForCrc, 2);
    writeUInt32BE(crcHeader, STUN_MAGIC_COOKIE, 4);
    crcHeader.set(transactionId, 8);
    const crcInput = concatBytes([crcHeader, attrsData]);
    const fingerprint = (crc32(crcInput) ^ STUN_FINGERPRINT_XOR) >>> 0;
    const fpBuf = new Uint8Array(4);
    writeUInt32BE(fpBuf, fingerprint, 0);
    const fpAttr = encodeAttribute(ATTR_FINGERPRINT, fpBuf);
    attrsData = concatBytes([attrsData, fpAttr]);
  }
  const header = new Uint8Array(20);
  writeUInt16BE(header, msgType, 0);
  writeUInt16BE(header, attrsData.length, 2);
  writeUInt32BE(header, STUN_MAGIC_COOKIE, 4);
  header.set(transactionId, 8);
  return concatBytes([header, attrsData]);
}
function encodeProtoUint32Field(fieldNumber, value) {
  return encodeProtoVarintField(fieldNumber, BigInt(value >>> 0));
}
function buildSenderSubscriptions(ssrc) {
  const inner = concatBytes([
    encodeProtoUint32Field(3, ssrc),
    encodeProtoUint32Field(5, 0),
    encodeProtoUint32Field(6, 0)
  ]);
  return encodeProtoLengthDelimited(1, inner);
}
function buildSSRCSubscriptionList(selfSsrcs, peerSsrcs, selfPid, peerPid) {
  const entries = [];
  for (const ssrc of selfSsrcs) {
    if (ssrc === 0) continue;
    const inner = concatBytes([
      encodeProtoUint32Field(1, selfPid),
      encodeProtoUint32Field(2, 1),
      encodeProtoUint32Field(3, ssrc)
    ]);
    entries.push(encodeProtoLengthDelimited(1, inner));
  }
  for (const peerSsrc of peerSsrcs) {
    if (peerSsrc === 0) continue;
    const inner = concatBytes([
      encodeProtoUint32Field(1, peerPid),
      encodeProtoUint32Field(2, 1),
      encodeProtoUint32Field(3, peerSsrc)
    ]);
    entries.push(encodeProtoLengthDelimited(1, inner));
  }
  return concatBytes(entries);
}
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_F = 70;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_F = 102;
const CHAR_DOT = 46;
const CHAR_COLON = 58;
const CHAR_PERCENT = 37;
function hexDigit(code) {
  if (code >= CHAR_ZERO && code <= CHAR_NINE) return code - CHAR_ZERO;
  if (code >= CHAR_LOWER_A && code <= CHAR_LOWER_F) return code - CHAR_LOWER_A + 10;
  if (code >= CHAR_UPPER_A && code <= CHAR_UPPER_F) return code - CHAR_UPPER_A + 10;
  return -1;
}
function writeIpv4Address(text, start, end, out, offset) {
  let octets = 0;
  let value = 0;
  let digits = 0;
  for (let i = start; i <= end; i++) {
    const code = i < end ? text.charCodeAt(i) : CHAR_DOT;
    if (code === CHAR_DOT) {
      if (digits === 0 || digits > 3 || value > 255 || octets === IPV4_ADDRESS_BYTES) {
        return false;
      }
      out[offset + octets] = value;
      octets++;
      value = 0;
      digits = 0;
      continue;
    }
    if (code < CHAR_ZERO || code > CHAR_NINE) return false;
    value = value * 10 + (code - CHAR_ZERO);
    digits++;
  }
  return octets === IPV4_ADDRESS_BYTES;
}
function writeIpv6Address(text, out, offset) {
  let end = text.length;
  for (let i2 = 0; i2 < text.length; i2++) {
    if (text.charCodeAt(i2) === CHAR_PERCENT) {
      end = i2;
      break;
    }
  }
  let hexEnd = end;
  let v4Start = -1;
  for (let i2 = 0; i2 < end; i2++) {
    if (text.charCodeAt(i2) === CHAR_DOT) {
      v4Start = text.lastIndexOf(":", i2) + 1;
      if (v4Start === 0) return false;
      hexEnd = v4Start;
      break;
    }
  }
  let written = 0;
  let gapAt = -1;
  let value = 0;
  let digits = 0;
  let i = 0;
  if (end > 0 && text.charCodeAt(0) === CHAR_COLON) {
    if (end < 2 || text.charCodeAt(1) !== CHAR_COLON) return false;
    gapAt = 0;
    i = 2;
  }
  for (; i < hexEnd; i++) {
    const code = text.charCodeAt(i);
    if (code === CHAR_COLON) {
      if (digits === 0 || written + 2 > IPV6_ADDRESS_BYTES) return false;
      out[offset + written] = value >>> 8;
      out[offset + written + 1] = value & 255;
      written += 2;
      value = 0;
      digits = 0;
      if (i + 1 < hexEnd && text.charCodeAt(i + 1) === CHAR_COLON) {
        if (gapAt >= 0) return false;
        gapAt = written;
        i++;
        continue;
      }
      if (v4Start < 0 && i + 1 === hexEnd) return false;
      continue;
    }
    const digit = hexDigit(code);
    if (digit < 0) return false;
    value = value << 4 | digit;
    digits++;
    if (digits > 4) return false;
  }
  if (digits > 0) {
    if (written + 2 > IPV6_ADDRESS_BYTES) return false;
    out[offset + written] = value >>> 8;
    out[offset + written + 1] = value & 255;
    written += 2;
  }
  if (v4Start >= 0) {
    if (written + IPV4_ADDRESS_BYTES > IPV6_ADDRESS_BYTES) return false;
    if (!writeIpv4Address(text, v4Start, end, out, offset + written)) return false;
    written += IPV4_ADDRESS_BYTES;
  }
  if (gapAt < 0) return written === IPV6_ADDRESS_BYTES;
  if (written >= IPV6_ADDRESS_BYTES) return false;
  const tail = written - gapAt;
  const tailAt = IPV6_ADDRESS_BYTES - tail;
  out.copyWithin(offset + tailAt, offset + gapAt, offset + written);
  out.fill(0, offset + gapAt, offset + tailAt);
  return true;
}
function xorWithRelayKeyByteOrder(data, offset, transactionId) {
  for (let word = 0; word < TRANSACTION_ID_LENGTH; word += RELAY_KEY_WORD_BYTES) {
    for (let i = 0; i < RELAY_KEY_WORD_BYTES; i++) {
      data[offset + word + i] ^= transactionId[word + RELAY_KEY_WORD_BYTES - 1 - i];
    }
  }
}
function encodeXorRelayedAddress(ip, port, transactionId) {
  const isIpv6 = ip.includes(":");
  const data = new Uint8Array(isIpv6 ? XOR_RELAYED_IPV6_BYTES : XOR_RELAYED_IPV4_BYTES);
  data[0] = 0;
  data[1] = isIpv6 ? STUN_ADDRESS_FAMILY_IPV6 : STUN_ADDRESS_FAMILY_IPV4;
  writeUInt16BE(data, port ^ STUN_MAGIC_COOKIE >>> 16, 2);
  if (isIpv6) {
    if (!writeIpv6Address(ip, data, 4)) return void 0;
  } else if (!writeIpv4Address(ip, 0, ip.length, data, 4)) {
    return void 0;
  }
  for (let i = 0; i < 4; i++) {
    data[4 + i] ^= STUN_MAGIC_COOKIE >>> 24 - i * 8 & 255;
  }
  if (isIpv6) {
    xorWithRelayKeyByteOrder(data, 8, transactionId);
  }
  return data;
}
function buildAllocateForRelay(relayCredential, ssrcList, hmacKey, relayIp, relayPort, transactionId = createStunTransactionId()) {
  const parts = [];
  parts.push(encodeAttribute(ATTR_RELAY_CREDENTIAL, relayCredential));
  parts.push(encodeAttribute(ATTR_SSRC_LIST, ssrcList));
  if (relayIp && relayPort) {
    const xorRelayedAddress = encodeXorRelayedAddress(relayIp, relayPort, transactionId);
    if (xorRelayedAddress) {
      parts.push(encodeAttribute(ATTR_XOR_RELAYED_ADDRESS, xorRelayedAddress));
    }
  }
  const attrs = concatBytes(parts);
  return buildStunMessage(STUN_ALLOCATE_REQUEST, attrs, transactionId, hmacKey, false);
}
function buildBindingRequestWithSubs(username, hmacKey, senderSubscriptions, includeIceControlling, includeFingerprint, transactionId = createStunTransactionId()) {
  const parts = [];
  if (username && username.length > 0) {
    parts.push(encodeAttribute(ATTR_USERNAME, username));
  }
  const priorityBuf = new Uint8Array(4);
  writeUInt32BE(priorityBuf, DEFAULT_ICE_PRIORITY, 0);
  parts.push(encodeAttribute(ATTR_PRIORITY, priorityBuf));
  if (includeIceControlling) {
    const tieBreaker = randomBytes(8);
    parts.push(encodeAttribute(ATTR_ICE_CONTROLLING, tieBreaker));
  }
  if (senderSubscriptions && senderSubscriptions.length > 0) {
    parts.push(encodeAttribute(ATTR_RELAY_CREDENTIAL, senderSubscriptions));
  }
  const attrs = concatBytes(parts);
  return buildStunMessage(STUN_BINDING_REQUEST, attrs, transactionId, hmacKey, includeFingerprint);
}
function buildWhatsAppPing(transactionId = createStunTransactionId()) {
  const header = new Uint8Array(20);
  writeUInt16BE(header, WHATSAPP_PING, 0);
  writeUInt16BE(header, 0, 2);
  writeUInt32BE(header, STUN_MAGIC_COOKIE, 4);
  header.set(transactionId, 8);
  return header;
}
function isStunPacket(data) {
  if (data.length < 2) return false;
  if ((data[0] & 192) !== 0) return false;
  const type = readUInt16BE(data, 0);
  if (type === WHATSAPP_PING || type === WHATSAPP_PONG) return true;
  return data.length >= 8 && readUInt32BE(data, 4) === STUN_MAGIC_COOKIE;
}
function isRtpPacket(data) {
  if (data.length < 2) return false;
  return (data[0] & 192) === 128;
}
function isRtcpPacket(data) {
  if (data.length < 8 || (data[0] & 192) !== 128) return false;
  return data[1] >= 192 && data[1] <= 223;
}
const STUN_ATTR_NAMES = {
  1: "MAPPED-ADDRESS",
  6: "USERNAME",
  8: "MESSAGE-INTEGRITY",
  9: "ERROR-CODE",
  10: "UNKNOWN-ATTRIBUTES",
  20: "REALM",
  21: "NONCE",
  25: "REQUESTED-TRANSPORT",
  32: "XOR-MAPPED-ADDRESS",
  36: "PRIORITY",
  37: "USE-CANDIDATE",
  16384: "RELAY-CREDENTIAL",
  16417: "RECEIVER-SUBSCRIPTION",
  16421: "SENDER-SUBSCRIPTIONS",
  32802: "SOFTWARE",
  32808: "FINGERPRINT",
  32809: "ICE-CONTROLLED",
  32810: "ICE-CONTROLLING",
  16435: "STABLE-ROUTING-CONN-ID"
};
function parseStunResponse(data) {
  if (data.length < 20) return null;
  const cookie = readUInt32BE(data, 4);
  if (cookie !== STUN_MAGIC_COOKIE) {
    const msgType = readUInt16BE(data, 0);
    if (msgType === 2049 || msgType === 2050) {
      return {
        rawType: msgType,
        method: msgType === 2049 ? "wa-ping" : "wa-pong",
        stunClass: "indication",
        isSuccess: false,
        isError: false,
        transactionId: bytesToHex(data.subarray(8, 20)),
        length: data.length,
        attributes: []
      };
    }
    return null;
  }
  const rawType = readUInt16BE(data, 0);
  const msgLength = readUInt16BE(data, 2);
  const transactionId = bytesToHex(data.subarray(8, 20));
  const c0 = rawType >> 4 & 1;
  const c1 = rawType >> 8 & 1;
  const stunClassNum = c1 << 1 | c0;
  const stunClass = ["request", "indication", "success", "error"][stunClassNum] || "unknown";
  const method_bits = (rawType & 15872) >> 2 | (rawType & 224) >> 1 | rawType & 15;
  let method = "unknown";
  switch (method_bits) {
    case 1:
      method = "binding";
      break;
    case 3:
      method = "allocate";
      break;
    case 4:
      method = "refresh";
      break;
    case 6:
      method = "send";
      break;
    case 7:
      method = "data";
      break;
    case 8:
      method = "create-permission";
      break;
    case 9:
      method = "channel-bind";
      break;
  }
  if (rawType === 2049) method = "wa-ping";
  if (rawType === 2050) method = "wa-pong";
  const attributes = [];
  let errorCode;
  let errorReason;
  let stableRoutingConnId;
  let offset = 20;
  while (offset + 4 <= 20 + msgLength && offset + 4 <= data.length) {
    const attrType = readUInt16BE(data, offset);
    const attrLength = readUInt16BE(data, offset + 2);
    const attrEnd = offset + 4 + attrLength;
    if (attrEnd > data.length) break;
    const attrData = data.subarray(offset + 4, attrEnd);
    attributes.push({
      type: attrType,
      typeName: STUN_ATTR_NAMES[attrType] || `0x${attrType.toString(16).padStart(4, "0")}`,
      length: attrLength,
      data: attrData
    });
    if (attrType === 9 && attrLength >= 4) {
      const errorClass = attrData[2] & 7;
      const errorNumber = attrData[3];
      errorCode = errorClass * 100 + errorNumber;
      if (attrLength > 4) {
        errorReason = TEXT_DECODER.decode(attrData.subarray(4));
      }
    }
    if (attrType === 16435 && stunClass === "success" && attrLength === 8) {
      stableRoutingConnId = readBigUInt64BE(attrData, 0);
    }
    offset = attrEnd + (4 - attrLength % 4) % 4;
  }
  return {
    rawType,
    method,
    stunClass,
    isSuccess: stunClass === "success",
    isError: stunClass === "error",
    errorCode,
    errorReason,
    stableRoutingConnId,
    transactionId,
    length: data.length,
    attributes
  };
}
function formatStunResponse(info) {
  let result = `STUN ${info.method} ${info.stunClass} (0x${info.rawType.toString(16).padStart(4, "0")}, ${info.length}B)`;
  if (info.isError && info.errorCode) {
    result += ` ERROR ${info.errorCode}`;
    if (info.errorReason) result += `: ${info.errorReason}`;
  }
  if (info.attributes.length > 0) {
    const attrNames = info.attributes.map((a) => a.typeName).join(", ");
    result += ` [${attrNames}]`;
  }
  return result;
}
function classifyPacket(data) {
  if (data.length < 2) return `tiny(${data.length}B)`;
  const firstByte = data[0];
  const twoBits = (firstByte & 192) >> 6;
  if (twoBits === 0) {
    const info = parseStunResponse(data);
    if (info) return formatStunResponse(info);
    const msgType = data[0] << 8 | data[1];
    return `STUN? 0x${msgType.toString(16)} (${data.length}B)`;
  }
  if (twoBits === 2) {
    const pt = data[1] & 127;
    const marker = data[1] >> 7 & 1;
    const seq = data.length >= 4 ? data[2] << 8 | data[3] : 0;
    return `RTP/SRTP PT=${pt} M=${marker} seq=${seq} (${data.length}B)`;
  }
  if (twoBits === 1) {
    return `DTLS? 0x${firstByte.toString(16)} (${data.length}B)`;
  }
  return `unknown 0x${firstByte.toString(16)} (${data.length}B)`;
}
export {
  buildAllocateForRelay,
  buildBindingRequestWithSubs,
  buildSSRCSubscriptionList,
  buildSenderSubscriptions,
  buildWhatsAppPing,
  classifyPacket,
  createStunTransactionId,
  formatStunResponse,
  isRtcpPacket,
  isRtpPacket,
  isStunPacket,
  parseStunResponse
};

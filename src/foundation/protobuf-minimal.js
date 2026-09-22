/**
 * Native replacement for `protobufjs/minimal` (+ @protobufjs/* + long), Node-only.
 *
 * Provides exactly the surface the generated WAProto/index.js consumes:
 *   Reader (BufferReader semantics), Writer (BufferWriter semantics), util, roots.
 * Wire output and decode results are byte/shape-identical to protobufjs 7.5.x —
 * verified by test/native-protobuf.mjs (differential + fuzz against the original).
 *
 * Intentionally NOT supported (unused by WAProto, browser-only in protobufjs):
 * plain-Array buffers, Uint8Array pool, rpc, reflection, eventemitter, float polyfill.
 */
import { Long } from './long.js'

/* ------------------------------------------------------------------ */
/* LongBits (lo/hi as unsigned 32-bit) — port of protobufjs util/longbits */
/* ------------------------------------------------------------------ */

export class LongBits {
	constructor(lo, hi) {
		this.lo = lo >>> 0
		this.hi = hi >>> 0
	}
	static fromNumber(value) {
		if (value === 0) return LongBits.zero
		const sign = value < 0
		if (sign) value = -value
		let lo = value >>> 0
		let hi = ((value - lo) / 4294967296) >>> 0
		if (sign) {
			hi = ~hi >>> 0
			lo = ~lo >>> 0
			if (++lo > 4294967295) {
				lo = 0
				if (++hi > 4294967295) hi = 0
			}
		}
		return new LongBits(lo, hi)
	}
	static from(value) {
		if (typeof value === 'number') return LongBits.fromNumber(value)
		if (typeof value === 'string' || value instanceof String) return LongBits.from(Long.fromString(String(value)))
		return value.low || value.high ? new LongBits(value.low >>> 0, value.high >>> 0) : LongBits.zero
	}
	toNumber(unsigned) {
		if (!unsigned && this.hi >>> 31) {
			const lo = ~this.lo + 1 >>> 0
			let hi = ~this.hi >>> 0
			if (!lo) hi = (hi + 1) >>> 0
			return -(lo + hi * 4294967296)
		}
		return this.lo + this.hi * 4294967296
	}
	toLong(unsigned) {
		return new Long(this.lo | 0, this.hi | 0, Boolean(unsigned))
	}
	zzEncode() {
		const mask = this.hi >> 31
		this.hi = (((this.hi << 1) | (this.lo >>> 31)) ^ mask) >>> 0
		this.lo = ((this.lo << 1) ^ mask) >>> 0
		return this
	}
	zzDecode() {
		const mask = -(this.lo & 1)
		this.lo = (((this.lo >>> 1) | (this.hi << 31)) ^ mask) >>> 0
		this.hi = ((this.hi >>> 1) ^ mask) >>> 0
		return this
	}
	length() {
		const part0 = this.lo
		const part1 = ((this.lo >>> 28) | (this.hi << 4)) >>> 0
		const part2 = this.hi >>> 24
		return part2 === 0
			? part1 === 0
				? part0 < 16384
					? part0 < 128
						? 1
						: 2
					: part0 < 2097152
						? 3
						: 4
				: part1 < 16384
					? part1 < 128
						? 5
						: 6
					: part1 < 2097152
						? 7
						: 8
			: part2 < 128
				? 9
				: 10
	}
}
LongBits.zero = new LongBits(0, 0)
// the shared zero instance must stay immutable-in-effect (zz* return `this`, as in protobufjs)
LongBits.zero.toNumber = () => 0
LongBits.zero.zzEncode = LongBits.zero.zzDecode = function () {
	return this
}
LongBits.zero.length = () => 1

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

const indexOutOfRange = (reader, writeLength) =>
	RangeError('index out of range: ' + reader.pos + ' + ' + (writeLength || 1) + ' > ' + reader.len)

function readVarint32NearEnd(reader) {
	// Safely read up to four bytes of a varint32 near the reader limit
	let value = 0
	for (let i = 0; i < 4; ++i) {
		if (reader.pos >= reader.len) throw indexOutOfRange(reader)
		const b = reader.buf[reader.pos++]
		value = (value | ((b & 127) << (i * 7))) >>> 0
		if (b < 128) return value
	}
	throw indexOutOfRange(reader)
}

function readLongVarint(reader) {
	const bits = new LongBits(0, 0)
	let i = 0
	if (reader.len - reader.pos > 4) {
		// fast route (lo)
		for (; i < 4; ++i) {
			bits.lo = (bits.lo | ((reader.buf[reader.pos] & 127) << (i * 7))) >>> 0
			if (reader.buf[reader.pos++] < 128) return bits
		}
		// 5th
		bits.lo = (bits.lo | ((reader.buf[reader.pos] & 127) << 28)) >>> 0
		bits.hi = (bits.hi | ((reader.buf[reader.pos] & 127) >> 4)) >>> 0
		if (reader.buf[reader.pos++] < 128) return bits
		i = 0
	} else {
		for (; i < 3; ++i) {
			if (reader.pos >= reader.len) throw indexOutOfRange(reader)
			bits.lo = (bits.lo | ((reader.buf[reader.pos] & 127) << (i * 7))) >>> 0
			if (reader.buf[reader.pos++] < 128) return bits
		}
		// 4th — protobufjs reads this byte unchecked and returns regardless of its continuation bit
		bits.lo = (bits.lo | ((reader.buf[reader.pos++] & 127) << (i * 7))) >>> 0
		return bits
	}
	if (reader.len - reader.pos > 4) {
		// fast route (hi)
		for (; i < 5; ++i) {
			bits.hi = (bits.hi | ((reader.buf[reader.pos] & 127) << (i * 7 + 3))) >>> 0
			if (reader.buf[reader.pos++] < 128) return bits
		}
	} else {
		for (; i < 5; ++i) {
			if (reader.pos >= reader.len) throw indexOutOfRange(reader)
			bits.hi = (bits.hi | ((reader.buf[reader.pos] & 127) << (i * 7 + 3))) >>> 0
			if (reader.buf[reader.pos++] < 128) return bits
		}
	}
	throw Error('invalid varint encoding')
}

const readFixed32End = (buf, end) => (buf[end - 4] | (buf[end - 3] << 8) | (buf[end - 2] << 16) | (buf[end - 1] << 24)) >>> 0

export class Reader {
	constructor(buffer) {
		this.buf = buffer
		this.pos = 0
		this.len = buffer.length
	}

	/** @returns {Reader} BufferReader-equivalent for Buffers; accepts Uint8Array too (like protobufjs) */
	static create(buffer) {
		if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array || Array.isArray(buffer)) return new Reader(buffer)
		throw Error('illegal buffer')
	}

	uint32() {
		if (this.len - this.pos < 5) {
			if (this.pos >= this.len) throw indexOutOfRange(this)
			if (this.buf[this.pos] >= 128) return readVarint32NearEnd(this)
		}
		let value = (this.buf[this.pos] & 127) >>> 0
		if (this.buf[this.pos++] < 128) return value
		value = (value | ((this.buf[this.pos] & 127) << 7)) >>> 0
		if (this.buf[this.pos++] < 128) return value
		value = (value | ((this.buf[this.pos] & 127) << 14)) >>> 0
		if (this.buf[this.pos++] < 128) return value
		value = (value | ((this.buf[this.pos] & 127) << 21)) >>> 0
		if (this.buf[this.pos++] < 128) return value
		value = (value | ((this.buf[this.pos] & 15) << 28)) >>> 0
		if (this.buf[this.pos++] < 128) return value
		if ((this.pos += 5) > this.len) {
			this.pos = this.len
			throw indexOutOfRange(this, 10)
		}
		return value
	}
	int32() {
		return this.uint32() | 0
	}
	sint32() {
		const value = this.uint32()
		return ((value >>> 1) ^ -(value & 1)) | 0
	}
	int64() {
		return readLongVarint(this).toLong(false)
	}
	uint64() {
		return readLongVarint(this).toLong(true)
	}
	sint64() {
		return readLongVarint(this).zzDecode().toLong(false)
	}
	bool() {
		return this.uint32() !== 0
	}
	fixed32() {
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4)
		return readFixed32End(this.buf, (this.pos += 4))
	}
	sfixed32() {
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4)
		return readFixed32End(this.buf, (this.pos += 4)) | 0
	}
	_fixed64() {
		if (this.pos + 8 > this.len) throw indexOutOfRange(this, 8)
		return new LongBits(readFixed32End(this.buf, (this.pos += 4)), readFixed32End(this.buf, (this.pos += 4)))
	}
	fixed64() {
		return this._fixed64().toLong(true)
	}
	sfixed64() {
		return this._fixed64().toLong(false)
	}
	float() {
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4)
		const value = Buffer.prototype.readFloatLE.call(this.buf, this.pos)
		this.pos += 4
		return value
	}
	double() {
		if (this.pos + 8 > this.len) throw indexOutOfRange(this, 4)
		const value = Buffer.prototype.readDoubleLE.call(this.buf, this.pos)
		this.pos += 8
		return value
	}
	bytes() {
		const length = this.uint32()
		const start = this.pos
		const end = this.pos + length
		if (end > this.len) throw indexOutOfRange(this, length)
		this.pos += length
		if (Array.isArray(this.buf)) return this.buf.slice(start, end)
		if (start === end) return Buffer.alloc(0)
		// Buffer#slice = zero-copy VIEW (same as protobufjs BufferReader); Uint8Array input -> subarray
		return Buffer.isBuffer(this.buf) ? this.buf.slice(start, end) : this.buf.subarray(start, end)
	}
	string() {
		if (Buffer.isBuffer(this.buf)) {
			const len = this.uint32() // modifies pos
			// BufferReader: clamps to buffer end instead of throwing
			return this.buf.utf8Slice(this.pos, (this.pos = Math.min(this.pos + len, this.len)))
		}
		const b = this.bytes()
		return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8')
	}
	skip(length) {
		if (typeof length === 'number') {
			if (this.pos + length > this.len) throw indexOutOfRange(this, length)
			this.pos += length
		} else {
			do {
				if (this.pos >= this.len) throw indexOutOfRange(this)
			} while (this.buf[this.pos++] & 128)
		}
		return this
	}
	skipType(wireType, depth) {
		if (depth === undefined) depth = 0
		if (depth > Reader.recursionLimit) throw Error('maximum nesting depth exceeded')
		switch (wireType) {
			case 0:
				this.skip()
				break
			case 1:
				this.skip(8)
				break
			case 2:
				this.skip(this.uint32())
				break
			case 3:
				while ((wireType = this.uint32() & 7) !== 4) this.skipType(wireType, depth + 1)
				break
			case 5:
				this.skip(4)
				break
			default:
				throw Error('invalid wire type ' + wireType + ' at offset ' + this.pos)
		}
		return this
	}
}
Reader.recursionLimit = 100 // protoc: CodedInputStream::default_recursion_limit_

/* ------------------------------------------------------------------ */
/* Writer (linked list of ops, like protobufjs; needed for fork/ldelim) */
/* ------------------------------------------------------------------ */

class Op {
	constructor(fn, len, val) {
		this.fn = fn
		this.len = len
		this.next = undefined
		this.val = val
	}
}
const noop = () => {}

class State {
	constructor(writer) {
		this.head = writer.head
		this.tail = writer.tail
		this.len = writer.len
		this.next = writer.states
	}
}

const writeByte = (val, buf, pos) => {
	buf[pos] = val & 255
}
const writeVarint32 = (val, buf, pos) => {
	while (val > 127) {
		buf[pos++] = (val & 127) | 128
		val >>>= 7
	}
	buf[pos] = val
}
const writeVarint64 = (val, buf, pos) => {
	let lo = val.lo
	let hi = val.hi
	while (hi) {
		buf[pos++] = (lo & 127) | 128
		lo = ((lo >>> 7) | (hi << 25)) >>> 0
		hi >>>= 7
	}
	while (lo > 127) {
		buf[pos++] = (lo & 127) | 128
		lo = lo >>> 7
	}
	buf[pos++] = lo
}
const writeFixed32 = (val, buf, pos) => {
	buf[pos] = val & 255
	buf[pos + 1] = (val >>> 8) & 255
	buf[pos + 2] = (val >>> 16) & 255
	buf[pos + 3] = val >>> 24
}
const writeFloat = (val, buf, pos) => {
	Buffer.prototype.writeFloatLE.call(buf, val, pos)
}
const writeDouble = (val, buf, pos) => {
	Buffer.prototype.writeDoubleLE.call(buf, val, pos)
}
const writeBytes = (val, buf, pos) => {
	buf.set(val, pos) // also works for plain array values
}
const writeString = (val, buf, pos) => {
	buf.utf8Write(val, pos)
}

export class Writer {
	constructor() {
		this.len = 0
		this.head = new Op(noop, 0, 0)
		this.tail = this.head
		this.states = null
	}
	static create() {
		return new Writer()
	}
	static alloc(size) {
		return Buffer.allocUnsafe(size)
	}
	_push(fn, len, val) {
		this.tail = this.tail.next = new Op(fn, len, val)
		this.len += len
		return this
	}
	uint32(value) {
		value = value >>> 0
		return this._push(writeVarint32, value < 128 ? 1 : value < 16384 ? 2 : value < 2097152 ? 3 : value < 268435456 ? 4 : 5, value)
	}
	int32(value) {
		return (value |= 0) < 0
			? this._push(writeVarint64, 10, LongBits.fromNumber(value)) // 10 bytes per spec
			: this.uint32(value)
	}
	sint32(value) {
		return this.uint32(((value << 1) ^ (value >> 31)) >>> 0)
	}
	uint64(value) {
		const bits = LongBits.from(value)
		return this._push(writeVarint64, bits.length(), bits)
	}
	int64(value) {
		return this.uint64(value)
	}
	sint64(value) {
		const bits = LongBits.from(value).zzEncode()
		return this._push(writeVarint64, bits.length(), bits)
	}
	bool(value) {
		return this._push(writeByte, 1, value ? 1 : 0)
	}
	fixed32(value) {
		return this._push(writeFixed32, 4, value >>> 0)
	}
	sfixed32(value) {
		return this.fixed32(value)
	}
	fixed64(value) {
		const bits = LongBits.from(value)
		return this._push(writeFixed32, 4, bits.lo)._push(writeFixed32, 4, bits.hi)
	}
	sfixed64(value) {
		return this.fixed64(value)
	}
	float(value) {
		return this._push(writeFloat, 4, value)
	}
	double(value) {
		return this._push(writeDouble, 8, value)
	}
	bytes(value) {
		// BufferWriter semantics: base64 strings are decoded
		if (typeof value === 'string' || value instanceof String) value = Buffer.from(value, 'base64')
		const len = value.length >>> 0
		this.uint32(len)
		if (len) this._push(writeBytes, len, value)
		return this
	}
	string(value) {
		const len = Buffer.byteLength(value)
		this.uint32(len)
		if (len) this._push(writeString, len, value)
		return this
	}
	fork() {
		this.states = new State(this)
		this.head = this.tail = new Op(noop, 0, 0)
		this.len = 0
		return this
	}
	reset() {
		if (this.states) {
			this.head = this.states.head
			this.tail = this.states.tail
			this.len = this.states.len
			this.states = this.states.next
		} else {
			this.head = this.tail = new Op(noop, 0, 0)
			this.len = 0
		}
		return this
	}
	ldelim() {
		const head = this.head
		const tail = this.tail
		const len = this.len
		this.reset().uint32(len)
		if (len) {
			this.tail.next = head.next // skip noop
			this.tail = tail
			this.len += len
		}
		return this
	}
	finish() {
		let head = this.head.next // skip noop
		const buf = Writer.alloc(this.len)
		let pos = 0
		while (head) {
			head.fn(head.val, buf, pos)
			pos += head.len
			head = head.next
		}
		return buf
	}
}

/* ------------------------------------------------------------------ */
/* util                                                                */
/* ------------------------------------------------------------------ */

// base64 tables (same construction as @protobufjs/base64): B64 = index -> char code, S64 = char code -> index (sparse)
const B64 = new Array(64)
const S64 = new Array(123)
for (let i = 0; i < 64; ) S64[(B64[i] = i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : (i - 59) | 43)] = i++

const isUnsafeProperty = key => key === '__proto__' || key === 'prototype' || key === 'constructor'

export const util = {
	Long,
	LongBits,
	isUnsafeProperty,
	emptyArray: Object.freeze([]),
	emptyObject: Object.freeze({}),
	recursionLimit: 100,
	nestingLimit: 32,
	toJSONOptions: { longs: String, enums: String, bytes: String, json: true },
	newBuffer: sizeOrArray => (typeof sizeOrArray === 'number' ? Buffer.allocUnsafe(sizeOrArray) : Buffer.from(sizeOrArray)),
	base64: {
		/** byte length of the decoded content (tolerates missing padding) — port of @protobufjs/base64 */
		length(string) {
			let p = string.length
			if (!p) return 0
			let n = 0
			while (--p % 4 > 1 && string.charAt(p) === '=') ++n
			return Math.ceil(string.length * 3) / 4 - n
		},
		/** Standard base64 (with '=' padding) of buffer[start, end) — port of @protobufjs/base64 encode. */
		encode(buffer, start, end) {
			let parts = null
			let chunk = []
			let i = 0 // output index
			let j = 0 // goto index
			let t // temporary
			while (start < end) {
				const b = buffer[start++]
				switch (j) {
					case 0:
						chunk[i++] = B64[b >> 2]
						t = (b & 3) << 4
						j = 1
						break
					case 1:
						chunk[i++] = B64[t | (b >> 4)]
						t = (b & 15) << 2
						j = 2
						break
					case 2:
						chunk[i++] = B64[t | (b >> 6)]
						chunk[i++] = B64[b & 63]
						j = 0
						break
				}
				if (i > 8191) {
					;(parts || (parts = [])).push(String.fromCharCode.apply(String, chunk))
					i = 0
				}
			}
			if (j) {
				chunk[i++] = B64[t]
				chunk[i++] = 61
				if (j === 1) chunk[i++] = 61
			}
			if (parts) {
				if (i) parts.push(String.fromCharCode.apply(String, chunk.slice(0, i)))
				return parts.join('')
			}
			return String.fromCharCode.apply(String, chunk.slice(0, i))
		},
		/**
		 * Strict standard-alphabet decode. Throws 'invalid encoding' on any character outside
		 * A-Za-z0-9+/ (so URL-safe '-'/'_', whitespace etc. are REJECTED — unlike Buffer.from(...,'base64')).
		 */
		decode(string, buffer, offset) {
			const start = offset
			let j = 0
			let t
			for (let i = 0; i < string.length; ) {
				let c = string.charCodeAt(i++)
				if (c === 61 && j > 1) break
				c = S64[c]
				if (c === undefined) throw Error('invalid encoding')
				switch (j) {
					case 0:
						t = c
						j = 1
						break
					case 1:
						buffer[offset++] = (t << 2) | ((c & 48) >> 4)
						t = c
						j = 2
						break
					case 2:
						buffer[offset++] = ((t & 15) << 4) | ((c & 60) >> 2)
						t = c
						j = 3
						break
					case 3:
						buffer[offset++] = ((t & 3) << 6) | c
						j = 0
						break
				}
			}
			if (j === 1) throw Error('invalid encoding')
			return offset - start
		}
	},
	makeProp(obj, key) {
		Object.defineProperty(obj, key, { enumerable: true, configurable: true, writable: true })
	},
	oneOfGetter(fieldNames) {
		const fieldMap = {}
		for (let i = 0; i < fieldNames.length; ++i) fieldMap[fieldNames[i]] = 1
		return function () {
			for (let keys = Object.keys(this), i = keys.length - 1; i > -1; --i)
				if (fieldMap[keys[i]] === 1 && this[keys[i]] !== undefined && this[keys[i]] !== null) return keys[i]
		}
	},
	oneOfSetter(fieldNames) {
		return function (name) {
			for (let i = 0; i < fieldNames.length; ++i) if (fieldNames[i] !== name) delete this[fieldNames[i]]
		}
	}
}

export const roots = {}

export default { Reader, Writer, util, roots, LongBits }

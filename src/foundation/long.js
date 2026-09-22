/**
 * Minimal 64-bit integer, API-compatible with the subset of `long` (long.js 5.x)
 * that protobufjs and WAProto actually use. Replaces the `long` package.
 *
 * Shape is intentionally the same as long.js so consumers keep working:
 *   { low, high, unsigned }  (low/high are signed 32-bit ints)
 *   toNumber(), toString(), toJSON-free, isLong via __isLong__
 * Arithmetic is done with BigInt instead of long.js's emulated 32-bit math.
 */
const TWO_64 = 1n << 64n
const MASK64 = TWO_64 - 1n

const isLong = obj => (obj && obj.__isLong__) === true

export class Long {
	constructor(low, high, unsigned) {
		this.low = low | 0
		this.high = high | 0
		this.unsigned = !!unsigned
	}

	/** Underlying 64 bits as an unsigned BigInt. */
	_bits() {
		return (BigInt(this.high >>> 0) << 32n) | BigInt(this.low >>> 0)
	}
	/** Value as BigInt honoring signedness. */
	toBigInt() {
		const b = this._bits()
		return this.unsigned ? b : BigInt.asIntN(64, b)
	}
	toNumber() {
		if (this.unsigned) return (this.high >>> 0) * 4294967296 + (this.low >>> 0)
		return this.high * 4294967296 + (this.low >>> 0)
	}
	toInt() {
		return this.unsigned ? this.low >>> 0 : this.low
	}
	toString(radix) {
		return this.toBigInt().toString(radix || 10)
	}
	isZero() {
		return this.high === 0 && this.low === 0
	}
	isNegative() {
		return !this.unsigned && this.high < 0
	}
	equals(other) {
		if (!isLong(other)) other = Long.fromValue(other)
		if (this.unsigned !== other.unsigned && this.high >>> 31 === 1 && other.high >>> 31 === 1) return false
		return this.high === other.high && this.low === other.low
	}
	eq(other) {
		return this.equals(other)
	}
	getHighBits() {
		return this.high
	}
	getHighBitsUnsigned() {
		return this.high >>> 0
	}
	getLowBits() {
		return this.low
	}
	getLowBitsUnsigned() {
		return this.low >>> 0
	}
	toSigned() {
		return this.unsigned ? new Long(this.low, this.high, false) : this
	}
	toUnsigned() {
		return this.unsigned ? this : new Long(this.low, this.high, true)
	}

	static fromBits(low, high, unsigned) {
		return new Long(low, high, unsigned)
	}

	static fromBigInt(value, unsigned) {
		const b = BigInt.asUintN(64, value)
		return new Long(Number(BigInt.asIntN(32, b)), Number(BigInt.asIntN(32, b >> 32n)), unsigned)
	}

	static fromNumber(value, unsigned) {
		if (Number.isNaN(value)) return new Long(0, 0, unsigned)
		if (unsigned) {
			if (value < 0) return new Long(0, 0, true)
			if (value >= 18446744073709551616) return new Long(-1, -1, true) // saturate, like long.js
		} else {
			if (value <= -9223372036854775808) return new Long(0, -2147483648, false)
			if (value + 1 >= 9223372036854775808) return new Long(-1, 2147483647, false)
		}
		return Long.fromBigInt(BigInt(Math.trunc(value)), unsigned)
	}

	static fromString(str, unsigned, radix) {
		if (str.length === 0) throw Error('empty string')
		if (typeof unsigned === 'number') {
			radix = unsigned
			unsigned = false
		} else {
			unsigned = !!unsigned
		}
		if (str === 'NaN' || str === 'Infinity' || str === '+Infinity' || str === '-Infinity') return new Long(0, 0, unsigned)
		radix = radix || 10
		if (radix < 2 || radix > 36) throw RangeError('radix')
		const p = str.indexOf('-')
		if (p > 0) throw Error('interior hyphen')
		const neg = p === 0
		const digits = neg ? str.substring(1) : str
		// same parse as long.js: parseInt per 8-digit block, so garbage digits become NaN -> 0 rather than throwing
		let result = 0n
		const R = BigInt(radix)
		for (let i = 0; i < digits.length; i += 8) {
			const size = Math.min(8, digits.length - i)
			const value = parseInt(digits.substring(i, i + size), radix)
			result = result * R ** BigInt(size) + BigInt(Number.isNaN(value) ? 0 : value)
		}
		if (neg) result = -result
		return Long.fromBigInt(result, unsigned)
	}

	static fromValue(val, unsigned) {
		if (typeof val === 'number') return Long.fromNumber(val, unsigned)
		if (typeof val === 'string') return Long.fromString(val, unsigned)
		if (typeof val === 'bigint') return Long.fromBigInt(val, unsigned)
		// throws for non-objects, converts non-instanceof Long (same as long.js)
		return new Long(val.low, val.high, typeof unsigned === 'boolean' ? unsigned : val.unsigned)
	}

	static isLong(obj) {
		return isLong(obj)
	}
}

Object.defineProperty(Long.prototype, '__isLong__', { value: true })

export const ZERO = new Long(0, 0, false)
export const UZERO = new Long(0, 0, true)
export { MASK64 }
export default Long

/**
 * Native PCM decoders for waveform generation (replaces `audio-decode` for the formats that can be decoded exactly
 * without a codec library): WAV (PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) and FLAC.
 *
 * `decodeChannel0(buffer)` returns the FIRST channel as a Float32Array in [-1, 1], or `undefined` when the container
 * is not one of the above (Ogg Opus/Vorbis, MP3, AAC, ... need a real codec: see getAudioWaveform's ffmpeg fallback).
 * Values are exactly sample / 2^(bits-1), i.e. what a bit-exact decoder produces.
 */

/* ------------------------------ WAV ------------------------------ */

function decodeWav(buf) {
	if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return undefined
	let pos = 12
	let fmt
	while (pos + 8 <= buf.length) {
		const id = buf.toString('latin1', pos, pos + 4)
		const size = buf.readUInt32LE(pos + 4)
		const body = pos + 8
		if (id === 'fmt ') {
			let tag = buf.readUInt16LE(body)
			const bits = buf.readUInt16LE(body + 14)
			if (tag === 0xfffe && size >= 26) tag = buf.readUInt16LE(body + 24) // extensible: real format = first 2 bytes of SubFormat
			fmt = { tag, channels: buf.readUInt16LE(body + 2), blockAlign: buf.readUInt16LE(body + 12), bits }
		} else if (id === 'data') {
			if (!fmt || !fmt.channels || !fmt.blockAlign) return undefined
			const end = Math.min(buf.length, size === 0xffffffff ? buf.length : body + size)
			const frames = Math.floor((end - body) / fmt.blockAlign)
			const bytes = fmt.bits >> 3
			const out = new Float32Array(frames)
			for (let i = 0; i < frames; i++) {
				const o = body + i * fmt.blockAlign // channel 0 is the first sample of each frame
				let v
				if (fmt.tag === 1) {
					if (fmt.bits === 8) v = (buf[o] - 128) / 128
					else if (fmt.bits === 16) v = buf.readInt16LE(o) / 32768
					else if (fmt.bits === 24) v = buf.readIntLE(o, 3) / 8388608
					else if (fmt.bits === 32) v = buf.readInt32LE(o) / 2147483648
					else return undefined
				} else if (fmt.tag === 3) {
					if (bytes === 4) v = buf.readFloatLE(o)
					else if (bytes === 8) v = buf.readDoubleLE(o)
					else return undefined
				} else return undefined // ADPCM, A-law, mu-law, MP3-in-WAV, ...
				out[i] = v
			}
			return out
		}
		pos = body + size + (size & 1)
	}
	return undefined
}

/* ------------------------------ FLAC ------------------------------ */

class Bits {
	constructor(buf, pos) {
		this.buf = buf
		this.pos = pos * 8 // bit position
	}
	get bytePos() {
		return this.pos >> 3
	}
	read(n) {
		// up to 32 bits, unsigned
		let v = 0
		while (n > 0) {
			const byte = this.buf[this.pos >> 3]
			if (byte === undefined) throw new Error('FLAC: unexpected end of data')
			const avail = 8 - (this.pos & 7)
			const take = Math.min(avail, n)
			v = v * (1 << take) + ((byte >> (avail - take)) & ((1 << take) - 1))
			this.pos += take
			n -= take
		}
		return v
	}
	readSigned(n) {
		const v = this.read(n)
		return v >= 2 ** (n - 1) ? v - 2 ** n : v
	}
	unary() {
		let n = 0
		while (this.read(1) === 0) n++
		return n
	}
	align() {
		this.pos = (this.pos + 7) & ~7
	}
}

const FIXED = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]]
const BLOCK_SIZES = { 1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608, 8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192, 14: 16384, 15: 32768 }
const SAMPLE_BITS = { 1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32 }

function readResidual(br, out, offset, blockSize, order) {
	const method = br.read(2)
	if (method > 1) throw new Error('FLAC: bad residual coding method')
	const paramBits = method === 0 ? 4 : 5
	const escape = method === 0 ? 15 : 31
	const partOrder = br.read(4)
	const parts = 1 << partOrder
	let n = offset + order
	for (let p = 0; p < parts; p++) {
		const count = (blockSize >> partOrder) - (p === 0 ? order : 0)
		const param = br.read(paramBits)
		if (param === escape) {
			const bits = br.read(5)
			for (let i = 0; i < count; i++) out[n++] = bits ? br.readSigned(bits) : 0
		} else {
			for (let i = 0; i < count; i++) {
				const q = br.unary()
				const r = param ? br.read(param) : 0
				const u = q * 2 ** param + r
				out[n++] = u % 2 === 0 ? u / 2 : -(u + 1) / 2 // zig-zag
			}
		}
	}
}

function readSubframe(br, blockSize, bps) {
	br.read(1) // padding
	const type = br.read(6)
	let wasted = 0
	if (br.read(1)) wasted = br.unary() + 1
	const bits = bps - wasted
	const s = new Float64Array(blockSize)
	if (type === 0) {
		const v = br.readSigned(bits)
		s.fill(v)
	} else if (type === 1) {
		for (let i = 0; i < blockSize; i++) s[i] = br.readSigned(bits)
	} else if (type >= 8 && type <= 12) {
		const order = type - 8
		for (let i = 0; i < order; i++) s[i] = br.readSigned(bits)
		readResidual(br, s, 0, blockSize, order)
		const c = FIXED[order]
		for (let i = order; i < blockSize; i++) {
			let pred = 0
			for (let j = 0; j < order; j++) pred += c[j] * s[i - 1 - j]
			s[i] += pred
		}
	} else if (type >= 32) {
		const order = type - 31
		for (let i = 0; i < order; i++) s[i] = br.readSigned(bits)
		const precision = br.read(4) + 1
		if (precision === 16) throw new Error('FLAC: invalid LPC precision')
		const shift = br.readSigned(5)
		const coefs = []
		for (let i = 0; i < order; i++) coefs.push(br.readSigned(precision))
		readResidual(br, s, 0, blockSize, order)
		const div = 2 ** shift
		for (let i = order; i < blockSize; i++) {
			let sum = 0
			for (let j = 0; j < order; j++) sum += coefs[j] * s[i - 1 - j]
			s[i] += shift >= 0 ? Math.floor(sum / div) : sum * 2 ** -shift // arithmetic right shift == floor division
		}
	} else throw new Error('FLAC: reserved subframe type')
	if (wasted) for (let i = 0; i < blockSize; i++) s[i] *= 2 ** wasted
	return s
}

function decodeFlac(buf) {
	if (buf.toString('latin1', 0, 4) !== 'fLaC') return undefined
	let pos = 4
	let streamBps = 0
	let total = 0
	while (pos + 4 <= buf.length) {
		const h = buf[pos]
		const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]
		if ((h & 0x7f) === 0 && len === 34) {
			streamBps = ((buf[pos + 4 + 12] & 1) << 4) + (buf[pos + 4 + 13] >> 4) + 1
			total = (buf[pos + 4 + 13] & 15) * 2 ** 32 + buf.readUInt32BE(pos + 4 + 14)
		}
		pos += 4 + len
		if (h & 0x80) break
	}
	if (!streamBps) return undefined
	const chunks = []
	let count = 0
	const br = new Bits(buf, pos)
	while (br.bytePos + 6 < buf.length) {
		const sync = br.read(14)
		if (sync !== 0x3ffe) break // trailing garbage / end
		br.read(2) // reserved + blocking strategy
		const bsCode = br.read(4)
		const srCode = br.read(4)
		const chAssign = br.read(4)
		const sizeCode = br.read(3)
		br.read(1)
		// coded frame/sample number: UTF-8 style, 1..7 bytes
		const first = br.read(8)
		let extra = first < 0x80 ? 0 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : first < 0xf8 ? 3 : first < 0xfc ? 4 : first < 0xfe ? 5 : 6
		while (extra-- > 0) br.read(8)
		let blockSize = BLOCK_SIZES[bsCode]
		if (bsCode === 6) blockSize = br.read(8) + 1
		else if (bsCode === 7) blockSize = br.read(16) + 1
		if (!blockSize) throw new Error('FLAC: bad block size')
		if (srCode === 12) br.read(8)
		else if (srCode === 13 || srCode === 14) br.read(16)
		br.read(8) // header CRC-8
		const bps = sizeCode === 0 ? streamBps : SAMPLE_BITS[sizeCode]
		if (!bps) throw new Error('FLAC: reserved sample size')
		const nch = chAssign < 8 ? chAssign + 1 : 2
		const chans = []
		for (let c = 0; c < nch; c++) {
			// the side channel carries one extra bit
			const extraBit = (chAssign === 8 && c === 1) || (chAssign === 9 && c === 0) || (chAssign === 10 && c === 1) ? 1 : 0
			chans.push(readSubframe(br, blockSize, bps + extraBit))
		}
		br.align()
		br.read(16) // frame CRC-16
		// channel 0 after undoing inter-channel decorrelation
		let ch0 = chans[0]
		if (chAssign === 8) ch0 = chans[0] // left/side: channel 0 is left already
		else if (chAssign === 9) {
			ch0 = new Float64Array(blockSize) // side/right: left = side + right
			for (let i = 0; i < blockSize; i++) ch0[i] = chans[0][i] + chans[1][i]
		} else if (chAssign === 10) {
			ch0 = new Float64Array(blockSize) // mid/side: left = (mid*2 + (side&1) + side) / 2
			for (let i = 0; i < blockSize; i++) {
				const side = chans[1][i]
				const mid = chans[0][i] * 2 + (((side % 2) + 2) % 2)
				ch0[i] = (mid + side) / 2 // exact: mid and side always have the same parity
			}
		}
		const scale = 2 ** (bps - 1)
		const f = new Float32Array(blockSize)
		for (let i = 0; i < blockSize; i++) f[i] = ch0[i] / scale
		chunks.push(f)
		count += blockSize
	}
	const out = new Float32Array(count)
	let o = 0
	for (const c of chunks) {
		out.set(c, o)
		o += c.length
	}
	return total && count > total ? out.subarray(0, total) : out
}

/** @returns {Float32Array|undefined} first channel, or undefined if the container is not WAV/FLAC */
export function decodeChannel0(buffer) {
	if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
	if (buffer.length < 12) return undefined
	try {
		return decodeWav(buffer) ?? decodeFlac(buffer)
	} catch {
		return undefined
	}
}

/**
 * The 64-value voice-note waveform (0..100) — same algorithm as upstream's getAudioWaveform:
 * 64 equal blocks, mean absolute amplitude per block, scaled so the loudest block is 100.
 */
export function waveformFromSamples(rawData, samples = 64) {
	const blockSize = Math.floor(rawData.length / samples)
	const filtered = []
	for (let i = 0; i < samples; i++) {
		const blockStart = blockSize * i
		let sum = 0
		for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[blockStart + j])
		filtered.push(sum / blockSize)
	}
	const multiplier = Math.pow(Math.max(...filtered), -1)
	return new Uint8Array(filtered.map(n => n * multiplier).map(n => Math.floor(100 * n)))
}

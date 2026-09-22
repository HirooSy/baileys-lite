/**
 * Native audio duration reader (seconds) — replaces `music-metadata` for the one thing lite used it for:
 * `metadata.format.duration`.
 *
 * Supported containers (formulas mirror music-metadata 11.x):
 *   Ogg Opus     (granule(last page) - preSkip) / 48000
 *   Ogg Vorbis   granule(last page) / sampleRate
 *   WAV          (fact.dwSampleLength | dataSize/blockAlign) / sampleRate   (data chunk clamped to file size)
 *   FLAC         STREAMINFO.totalSamples / sampleRate
 *   MP4/M4A      first audio track  mdhd.duration / mdhd.timeScale          (+ fragmented mp4, mvhd not used)
 *   MP3 / ADTS   Xing/Info frame count, CBR from file size, or full frame scan
 *   AIFF / AIFF-C  COMM.numSampleFrames / sampleRate (80-bit float)
 *   Matroska / WebM  Segment > Info > Duration x TimecodeScale
 *   AMR-NB / AMR-WB  frame count x 20 ms
 *
 * Returns `undefined` when the duration cannot be determined with confidence (unknown container, truncated
 * header, ...) — callers may then fall back to something else. It never guesses.
 */
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'

/* ------------------------------ helpers ------------------------------ */

const u32be = (b, o) => b.readUInt32BE(o)
const u64be = (b, o) => Number(b.readBigUInt64BE(o))
const ascii = (b, o, n) => b.toString('latin1', o, o + n)

/* ------------------------------ Ogg ------------------------------ */

const oggDuration = buf => {
	// Mirrors music-metadata's OggParser: pages are read in order; a stream's `lastPageHeader` is recorded when
	// its page header is parsed (BEFORE the page body is read), so a file cut inside a page body still records
	// that page's granule. `endOfStream` is true only when reading threw EndOfStream (file cut mid-header/body).
	const streams = new Map()
	let pos = 0
	let endOfStream = false
	while (true) {
		if (pos + 27 > buf.length) {
			// PageHeader needs 27 bytes; if there is nothing left at all this is a clean end, otherwise a cut header
			if (pos < buf.length) endOfStream = true
			else endOfStream = true // readToken at EOF also throws EndOfStream in music-metadata
			break
		}
		if (ascii(buf, pos, 4) !== 'OggS') break // OggContentError -> warning; not an end-of-stream
		const headerType = buf[pos + 5]
		const granule = buf.readBigInt64LE(pos + 6)
		const serial = buf.readUInt32LE(pos + 14)
		const nseg = buf[pos + 26]
		let s = streams.get(serial)
		if (!s) {
			s = { codec: undefined, sampleRate: undefined, preSkip: 0, last: undefined, closed: false, pageNumber: 0, fullPages: 0, pageCount: 0 }
			streams.set(serial, s)
		}
		s.pageNumber = buf.readUInt32LE(pos + 18)
		if (pos + 27 + nseg > buf.length) {
			endOfStream = true // SegmentTable read hits EOF; lastPageHeader is NOT yet updated for this page
			break
		}
		let dataLen = 0
		for (let i = 0; i < nseg; i++) dataLen += buf[pos + 27 + i]
		const dataStart = pos + 27 + nseg
		if (dataStart + dataLen > buf.length) {
			endOfStream = true // page body cut short: music-metadata throws before parsePage of the consumer runs
			break
		}
		if (headerType & 0x02) {
			const idText = [...buf.subarray(dataStart, dataStart + 7)].filter(b => b >= 32 && b <= 126).map(b => String.fromCharCode(b)).join('')
			if (idText === 'OpusHea') {
				s.codec = 'opus'
				s.preSkip = buf.readUInt16LE(dataStart + 10)
				s.sampleRate = buf.readUInt32LE(dataStart + 12)
			} else if (idText === 'vorbis') {
				s.codec = 'vorbis'
				s.sampleRate = buf.readUInt32LE(dataStart + 12)
			} else {
				s.codec = 'other'
			}
		}
		if (headerType & 0x04) s.closed = true
		else if (!(headerType & 0x02)) s.fullPages++ // a complete page that is neither first nor last
		s.pageCount++
		s.last = { granule, lastPage: !!(headerType & 0x04) }
		pos = dataStart + dataLen
		// music-metadata stops early after page 12 unless a consumer wants the last page (Opus/Vorbis do) — so it keeps going
		if ([...streams.values()].every(x => x.closed)) break
	}
	for (const s of streams.values()) {
		if (!s.last || !s.sampleRate) continue
		if (!(endOfStream || s.last.lastPage)) continue
		if (s.last.granule < 0n) continue
		// music-metadata (Vorbis only): on a truncated file it calls flush() -> parseFullPage() on the pages queued so
		// far; with nothing queued (file ends after the identification page, before the comment page completes) that
		// reads an empty array and THROWS RangeError. A throw leaves the caller's `seconds` unset, so the faithful
		// equivalent is `undefined` — never a fabricated 0. (Measured: cut in bytes 58..3997 of a Vorbis file.)
		if (s.codec === 'vorbis' && endOfStream && !s.last.lastPage && s.fullPages === 0 && s.pageCount > 0) return undefined
		const g = Number(s.last.granule)
		if (s.codec === 'opus') return (g - s.preSkip) / 48000
		if (s.codec === 'vorbis') return g / s.sampleRate
	}
	return undefined
}

/* ------------------------------ WAV ------------------------------ */

const wavDuration = buf => {
	if (ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WAVE') return undefined
	let pos = 12
	let sampleRate
	let blockAlign = 0
	let fact
	while (pos + 8 <= buf.length) {
		const id = ascii(buf, pos, 4)
		const size = buf.readUInt32LE(pos + 4)
		const body = pos + 8
		if (id === 'fmt ') {
			sampleRate = buf.readUInt32LE(body + 4)
			blockAlign = buf.readUInt16LE(body + 12)
		} else if (id === 'fact') {
			fact = buf.readUInt32LE(body)
		} else if (id === 'data') {
			let chunkSize = size
			const remaining = buf.length - body
			if (remaining < chunkSize) chunkSize = remaining // "data chunk length exceeding file length"
			const samples = fact !== undefined ? fact : chunkSize === 0xffffffff ? undefined : chunkSize / blockAlign
			if (samples && sampleRate) return samples / sampleRate
			return undefined
		}
		pos = body + size + (size % 2) // chunks are word aligned
	}
	return undefined
}

/* ------------------------------ FLAC ------------------------------ */

const flacDuration = buf => {
	if (ascii(buf, 0, 4) !== 'fLaC') return undefined
	let pos = 4
	while (pos + 4 <= buf.length) {
		const h = buf[pos]
		const type = h & 0x7f
		const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]
		if (type === 0) {
			// STREAMINFO (34 bytes): ... sampleRate(20) channels(3) bps(5) totalSamples(36)
			if (len !== 34) return undefined
			// music-metadata only reports once the whole 34-byte STREAMINFO block is present (a cut inside it is not trusted)
			if (pos + 4 + 34 > buf.length) return undefined
			const o = pos + 4
			const sampleRate = ((buf[o + 10] << 16) | (buf[o + 11] << 8) | buf[o + 12]) >> 4
			const totalSamples = (buf[o + 13] & 0x0f) * 2 ** 32 + buf.readUInt32BE(o + 14)
			return totalSamples > 0 && sampleRate ? totalSamples / sampleRate : undefined
		}
		if (h & 0x80) break // last metadata block, no STREAMINFO seen
		pos += 4 + len
	}
	return undefined
}

/* ------------------------------ MP4 / M4A ------------------------------ */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex'])

const mp4Duration = buf => {
	const tracks = [] // { handler, timeScale, duration, fragSamples }
	const walk = (start, end, cur) => {
		let pos = start
		while (pos + 8 <= end) {
			let size = u32be(buf, pos)
			const type = ascii(buf, pos + 4, 4)
			let hdr = 8
			if (size === 1) {
				size = u64be(buf, pos + 8)
				hdr = 16
			} else if (size === 0) size = end - pos
			// A box that claims more bytes than the file holds means the file is truncated. music-metadata reads
			// boxes through a tokenizer and throws EndOfStreamError there; the faithful equivalent is "no duration".
			if (size >= hdr && pos + size > end) {
				if (type === 'moov') truncated = true // header atom incomplete -> unreliable
				size = end - pos
			} else if (size < hdr) size = Math.min(Math.max(size, hdr), end - pos)
			const body = pos + hdr
			const bodyEnd = pos + size
			if (type === 'trak') {
				const t = { handler: undefined, timeScale: 0, duration: 0, hasMdhd: false }
				tracks.push(t)
				walk(body, bodyEnd, t)
			} else if (CONTAINERS.has(type)) {
				walk(body, bodyEnd, cur)
			} else if (cur && type === 'hdlr') {
				cur.handler = ascii(buf, body + 8, 4)
			} else if (cur && type === 'mdhd') {
				const v = buf[body]
				cur.hasMdhd = true
				if (v === 1) {
					cur.timeScale = u32be(buf, body + 20)
					cur.duration = u64be(buf, body + 24)
				} else {
					cur.timeScale = u32be(buf, body + 12)
					cur.duration = u32be(buf, body + 16)
				}
			}
			pos += size
		}
	}
	let truncated = false
	walk(0, buf.length, undefined)
	if (truncated) return undefined
	const audio = tracks.find(t => t.handler === 'soun' || t.handler === 'audi')
	if (audio && audio.timeScale > 0 && audio.duration > 0) return audio.duration / audio.timeScale
	return undefined // fragmented-only / timeScale 0 cases are not reproduced (caller falls back)
}

/* ------------------------------ MP3 / ADTS ------------------------------ */

const MPEG_BITRATES = {
	// [version][layer] kbps by index 1..14; version: 1 = MPEG1, 2 = MPEG2/2.5
	'1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
	'1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
	'1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	'2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
	'2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
	'2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const MPEG_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } // keyed by version bits

/** Parses a 4-byte MPEG audio frame header at `o`. Returns null when it is not a valid frame header. */
const mpegHeader = (buf, o) => {
	if (o + 4 > buf.length || buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) return null
	const versionBits = (buf[o + 1] >> 3) & 3 // 3=MPEG1 2=MPEG2 0=MPEG2.5 1=reserved
	const layerBits = (buf[o + 1] >> 1) & 3 // 1=III 2=II 3=I 0=reserved (ADTS uses 0)
	const bitrateIdx = buf[o + 2] >> 4
	const srIdx = (buf[o + 2] >> 2) & 3
	const padding = (buf[o + 2] >> 1) & 1
	if (versionBits === 1 || layerBits === 0 || srIdx === 3) return null
	const layer = 4 - layerBits // 1,2,3
	const verKey = versionBits === 3 ? 1 : 2
	if (bitrateIdx === 0 || bitrateIdx === 15) return null
	const bitrate = MPEG_BITRATES[`${verKey}-${layer}`][bitrateIdx - 1] * 1000
	const sampleRate = MPEG_SAMPLE_RATES[versionBits][srIdx]
	const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : versionBits === 3 ? 1152 : 576
	const slot = layer === 1 ? 4 : 1
	const frameSize = layer === 1 ? Math.floor(((12 * bitrate) / sampleRate + padding) * 4) : Math.floor((samplesPerFrame / 8) * bitrate / sampleRate + (padding ? slot : 0))
	const mono = (buf[o + 3] >> 6) === 3
	return { versionBits, layer, bitrate, sampleRate, samplesPerFrame, frameSize, padding, crc: (buf[o + 1] & 1) === 0, mono }
}

const id3v2Size = buf => {
	if (buf.length >= 10 && ascii(buf, 0, 3) === 'ID3') {
		const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
		return 10 + size + (buf[5] & 0x10 ? 10 : 0)
	}
	return 0
}

const mp3Duration = buf => {
	let pos = id3v2Size(buf)
	// find first valid frame header
	let first
	while (pos + 4 <= buf.length) {
		const h = mpegHeader(buf, pos)
		if (h && h.frameSize > 0 && (pos + h.frameSize === buf.length || mpegHeader(buf, pos + h.frameSize) || pos + h.frameSize > buf.length)) {
			first = { ...h, pos }
			break
		}
		pos++
	}
	if (!first) return undefined
	const hasId3v1 = buf.length >= 128 && ascii(buf, buf.length - 128, 3) === 'TAG'

	// Xing / Info tag lives after the side info of the first frame
	const sideInfo = first.versionBits === 3 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17
	const tagOff = first.pos + 4 + (first.crc ? 2 : 0) + sideInfo
	const tag = tagOff + 4 <= buf.length ? ascii(buf, tagOff, 4) : ''
	if (tag === 'Xing' || tag === 'Info') {
		const flags = u32be(buf, tagOff + 4)
		let o = tagOff + 8
		let numFrames = null
		let streamSize = null
		if (flags & 1) {
			numFrames = u32be(buf, o)
			o += 4
		}
		if (flags & 2) {
			streamSize = u32be(buf, o)
			o += 4
		}
		if (flags & 4) o += 100
		if (flags & 8) o += 4
		let lameMusicLength
		if (o + 4 <= buf.length && ascii(buf, o, 4) === 'LAME') {
			const ver = ascii(buf, o + 4, 5)
			const m = ver.match(/\d+.\d+/g)
			if (m) {
				const [maj, min] = m[0].split('.').map(n => parseInt(n, 10))
				if (maj >= 3 && min >= 90) lameMusicLength = buf.readUInt32BE(o + 9 + 0x14) // ExtendedLameHeader.music_length
			}
		}
		// music-metadata: LAME music_length/1000 first, then overwritten by the frame-count formula if streamSize present
		if (streamSize && numFrames !== null) return (numFrames * first.samplesPerFrame) / first.sampleRate
		if (lameMusicLength !== undefined && lameMusicLength > 0) return lameMusicLength / 1000
		// 'Info' tag = CBR marker, fall through to CBR-by-size below
	}

	// Scan up to 4 frames to detect CBR (all equal bitrates), like music-metadata
	const bitrates = []
	let p = first.pos
	let last
	for (let i = 0; i < 4 && p + 4 <= buf.length; i++) {
		const h = mpegHeader(buf, p)
		if (!h) break
		bitrates.push(h.bitrate)
		last = h
		p += h.frameSize
	}
	if (bitrates.length === 4 && bitrates.every(b => b === bitrates[0])) {
		// CBR: numberOfSamples = round(mpegSize / frame_size) * samplesPerFrame
		const mpegSize = buf.length - first.pos - (hasId3v1 ? 128 : 0)
		return (Math.round(mpegSize / last.frameSize) * first.samplesPerFrame) / first.sampleRate
	}

	// VBR without Xing: full frame walk
	let frames = 0
	p = first.pos
	while (p + 4 <= buf.length) {
		const h = mpegHeader(buf, p)
		if (!h) {
			// resync: advance byte-wise to next plausible header
			p++
			continue
		}
		frames++
		p += h.frameSize
	}
	return frames ? (frames * first.samplesPerFrame) / first.sampleRate : undefined
}

/* ------------------------------ ADTS (raw AAC) ------------------------------ */

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

/**
 * Raw ADTS AAC (`.aac`): every frame carries 1024 samples; duration = frames * 1024 / sampleRate.
 * Walks frame by frame using the 13-bit frame length in each header. Like music-metadata the sample rate
 * comes from the first frame header.
 */
const adtsDuration = buf => {
	let pos = id3v2Size(buf)
	let frames = 0
	let sampleRate
	while (pos + 7 <= buf.length) {
		// syncword 0xFFF, layer bits == 00 (this is what distinguishes ADTS from MPEG audio layers)
		if (buf[pos] !== 0xff || (buf[pos + 1] & 0xf6) !== 0xf0) {
			if (frames === 0) {
				pos++ // still hunting for the first sync
				continue
			}
			break // garbage after the stream: stop like a decoder would
		}
		const sfi = (buf[pos + 2] >> 2) & 0x0f
		const frameLength = ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | (buf[pos + 5] >> 5)
		if (sfi > 12 || frameLength < 7) {
			if (frames === 0) {
				pos++
				continue
			}
			break
		}
		if (sampleRate === undefined) sampleRate = ADTS_SAMPLE_RATES[sfi]
		frames++
		pos += frameLength
	}
	return frames && sampleRate ? (frames * 1024) / sampleRate : undefined
}

/* ------------------------------ AIFF / AIFF-C ------------------------------ */

const aiffDuration = buf => {
	if (ascii(buf, 0, 4) !== 'FORM') return undefined
	const kind = ascii(buf, 8, 4)
	if (kind !== 'AIFF' && kind !== 'AIFC') return undefined
	let pos = 12
	while (pos + 8 <= buf.length) {
		const id = ascii(buf, pos, 4)
		const size = u32be(buf, pos + 4)
		const body = pos + 8
		if (id === 'COMM') {
			if (size < 18 || body + size > buf.length) return undefined // the whole COMM chunk (incl. AIFF-C extras) must be present
			const frames = u32be(buf, body + 2)
			// 80-bit IEEE extended sample rate: 1 sign + 15 exponent bits, 64-bit mantissa (explicit integer bit)
			const exp = buf.readUInt16BE(body + 8) & 0x7fff
			const mantissa = buf.readBigUInt64BE(body + 10)
			const sampleRate = Number(mantissa) * 2 ** (exp - 16383 - 63)
			return sampleRate > 0 ? frames / sampleRate : undefined
		}
		pos = body + size + (size & 1)
	}
	return undefined
}

/* ------------------------------ Matroska / WebM ------------------------------ */

/** EBML variable-length integer at `pos`. `keepMarker` = element IDs keep the length-marker bit, sizes drop it. */
const ebmlVint = (buf, pos, keepMarker) => {
	if (pos >= buf.length) return undefined
	const first = buf[pos]
	if (first === 0) return undefined
	const len = Math.clz32(first) - 23 // 1..8
	if (pos + len > buf.length) return undefined
	let value = keepMarker ? first : first & (0xff >> len)
	let allOnes = (first & (0xff >> len)) === 0xff >> len
	for (let i = 1; i < len; i++) {
		value = value * 256 + buf[pos + i]
		if (buf[pos + i] !== 0xff) allOnes = false
	}
	return { value, length: len, unknown: !keepMarker && allOnes }
}

const matroskaDuration = buf => {
	const info = { timecodeScale: undefined, duration: undefined }
	const readUInt = (o, n) => {
		let v = 0
		for (let i = 0; i < n; i++) v = v * 256 + buf[o + i]
		return v
	}
	// walk `[start, end)` looking for the Segment > Info element; returns true once Info has been fully read
	const walk = (start, end, depth) => {
		let pos = start
		while (pos < end) {
			const id = ebmlVint(buf, pos, true)
			if (!id) return false
			const size = ebmlVint(buf, pos + id.length, false)
			if (!size) return false
			const body = pos + id.length + size.length
			const bodyEnd = size.unknown ? end : Math.min(end, body + size.value)
			if (id.value === 0x18538067 && depth === 0) {
				if (walk(body, bodyEnd, 1)) return true // Segment
			} else if (id.value === 0x1549a966 && depth === 1) {
				// Info: TimecodeScale (uint) and Duration (float)
				let q = body
				while (q < bodyEnd) {
					const cid = ebmlVint(buf, q, true)
					const csz = cid && ebmlVint(buf, q + cid.length, false)
					if (!csz) break
					const cb = q + cid.length + csz.length
					if (cb + csz.value > buf.length) break
					if (cid.value === 0x2ad7b1) info.timecodeScale = readUInt(cb, csz.value)
					else if (cid.value === 0x4489) info.duration = csz.value === 4 ? buf.readFloatBE(cb) : csz.value === 8 ? buf.readDoubleBE(cb) : undefined
					q = cb + csz.value
				}
				return true
			}
			if (size.unknown) return false // cannot skip an unknown-size element that is not the Segment
			pos = body + size.value
		}
		return false
	}
	walk(0, buf.length, 0)
	if (typeof info.duration !== 'number' || !Number.isFinite(info.duration)) return undefined
	return (info.duration * (info.timecodeScale || 1000000)) / 1e9
}

/* ------------------------------ AMR (NB and WB) ------------------------------ */

// total bytes per frame (1 header byte + payload), indexed by frame type; 0 = invalid frame type
const AMR_NB_FRAME_BYTES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1]
const AMR_WB_FRAME_BYTES = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 0, 0, 0, 0, 1, 1]

/** Every AMR frame (any mode, incl. SID and "no data") covers 20 ms. */
const amrDuration = buf => {
	const wb = ascii(buf, 0, 9) === '#!AMR-WB\n'
	if (!wb && ascii(buf, 0, 6) !== '#!AMR\n') return undefined
	const table = wb ? AMR_WB_FRAME_BYTES : AMR_NB_FRAME_BYTES
	let pos = wb ? 9 : 6
	let frames = 0
	while (pos < buf.length) {
		const size = table[(buf[pos] >> 3) & 0x0f]
		if (!size) break // reserved frame type: not a valid stream from here on
		if (pos + size > buf.length) break // partial last frame is not counted
		frames++
		pos += size
	}
	return frames ? frames * 0.02 : undefined
}

/* ------------------------------ dispatch ------------------------------ */

/** @param {Buffer} buf @returns {number|undefined} duration in seconds */
export const durationFromBuffer = buf => {
	if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
	if (buf.length < 12) return undefined
	try {
		const magic = ascii(buf, 0, 4)
		if (magic === 'OggS') return oggDuration(buf)
		if (magic === 'RIFF') return wavDuration(buf)
		if (magic === 'fLaC') return flacDuration(buf)
		if (ascii(buf, 4, 4) === 'ftyp') return mp4Duration(buf)
		if (magic === 'FORM') return aiffDuration(buf)
		if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return matroskaDuration(buf)
		if (magic === '#!AM') return amrDuration(buf)
		if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return adtsDuration(buf) // sync + layer 00 = ADTS
		if (magic.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return mp3Duration(buf)
	} catch {
		return undefined
	}
	return undefined
}

/** Accepts a Buffer, a file path, or a Readable stream (same inputs as the old `getAudioDuration`). */
export const audioDuration = async input => {
	if (Buffer.isBuffer(input)) return durationFromBuffer(input)
	if (typeof input === 'string') {
		const { size } = await stat(input)
		if (size > 64 * 1024 * 1024) {
			// avoid loading huge files fully: header-only containers only need a prefix, Ogg needs the tail
			const fh = await open(input, 'r')
			try {
				const head = Buffer.alloc(Math.min(size, 4 * 1024 * 1024))
				await fh.read(head, 0, head.length, 0)
				return durationFromBuffer(head)
			} finally {
				await fh.close()
			}
		}
		const chunks = []
		for await (const c of createReadStream(input)) chunks.push(c)
		return durationFromBuffer(Buffer.concat(chunks))
	}
	const chunks = []
	for await (const c of input) chunks.push(c)
	return durationFromBuffer(Buffer.concat(chunks))
}

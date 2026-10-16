import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { Boom } from './boom.js'

// Dependency-free image thumbnails. Used when none of sharp / @napi-rs/image / jimp is installed,
// so a missing optional library never results in a media message without jpegThumbnail
// (the recipient sees that as a grey box).
//   1. built-in decoder (vendored jpeg-js + pngjs) for JPEG / PNG
//   2. ffmpeg for everything else (webp, gif, bmp, ...) and for big files, so the event loop is not
//      blocked by a pure-JS decode of a multi-megapixel photo

const JPEG_QUALITY = 50
const BUILTIN_PREFERRED_MAX_BYTES = 2 * 1024 * 1024
const FFMPEG_TIMEOUT_MS = 15_000

const isJpeg = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
const isPng = b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

async function readHeader(path) {
	const handle = await fs.open(path, 'r')
	try {
		const header = Buffer.alloc(16)
		const { bytesRead } = await handle.read(header, 0, 16, 0)
		return header.subarray(0, bytesRead)
	} finally {
		await handle.close()
	}
}

async function decodeRaster(buffer) {
	if (isJpeg(buffer)) {
		const { default: decode } = await import('../vendor/jpeg-js/decoder.js')
		return decode(buffer, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true })
	}
	if (isPng(buffer)) {
		const { read } = await import('../vendor/pngjs/png-sync.js')
		return read(buffer)
	}
	throw new Boom('unsupported image format for built-in decoder')
}

// area-average downscale; transparent pixels are composited over white (JPEG has no alpha)
function resizeToRgba({ data, width: sw, height: sh }, dw, dh) {
	const out = Buffer.allocUnsafe(dw * dh * 4)
	const xr = sw / dw
	const yr = sh / dh
	for (let dy = 0; dy < dh; dy++) {
		const y0 = Math.floor(dy * yr)
		const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((dy + 1) * yr)))
		for (let dx = 0; dx < dw; dx++) {
			const x0 = Math.floor(dx * xr)
			const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((dx + 1) * xr)))
			let r = 0
			let g = 0
			let b = 0
			for (let y = y0; y < y1; y++) {
				let i = (y * sw + x0) * 4
				for (let x = x0; x < x1; x++, i += 4) {
					const a = data[i + 3] / 255
					r += data[i] * a + 255 * (1 - a)
					g += data[i + 1] * a + 255 * (1 - a)
					b += data[i + 2] * a + 255 * (1 - a)
				}
			}
			const n = (y1 - y0) * (x1 - x0)
			const o = (dy * dw + dx) * 4
			out[o] = Math.round(r / n)
			out[o + 1] = Math.round(g / n)
			out[o + 2] = Math.round(b / n)
			out[o + 3] = 255
		}
	}
	return out
}

async function builtinThumb(buffer, width) {
	const image = await decodeRaster(buffer)
	if (!image?.width || !image?.height || !image.data?.length) throw new Boom('could not decode image')
	const dw = Math.max(1, Math.min(width, image.width)) // never upscale
	const dh = Math.max(1, Math.round((image.height * dw) / image.width))
	const { default: encode } = await import('../vendor/jpeg-js/encoder.js')
	const rgba = resizeToRgba(image, dw, dh)
	const { data } = encode({ data: rgba, width: dw, height: dh }, JPEG_QUALITY)
	return { buffer: Buffer.from(data), original: { width: image.width, height: image.height } }
}

async function runFfmpeg(command, args, input) {
	const child = spawn(command, args, { stdio: [Buffer.isBuffer(input) ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
	const out = []
	const err = []
	child.stdout.on('data', c => out.push(c))
	child.stderr.on('data', c => err.push(c))
	if (Buffer.isBuffer(input)) {
		child.stdin.on('error', () => {})
		child.stdin.end(input)
	}
	const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS)
	try {
		const [code] = await once(child, 'close')
		if (code !== 0) throw new Boom(`${command} failed (code ${code}): ${Buffer.concat(err).toString('utf8').trim()}`)
		return Buffer.concat(out)
	} finally {
		clearTimeout(timer)
	}
}

async function probeDimensions(input) {
	try {
		const src = Buffer.isBuffer(input) ? 'pipe:0' : input
		const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]
		const [width, height] = (await runFfmpeg('ffprobe', args, input)).toString('utf8').trim().split(',').map(Number)
		return width > 0 && height > 0 ? { width, height } : {}
	} catch {
		return {}
	}
}

async function ffmpegThumb(input, width) {
	const src = Buffer.isBuffer(input) ? 'pipe:0' : input
	const args = [
		'-loglevel', 'error', '-i', src, '-an', '-sn', '-dn', '-map_metadata', '-1',
		'-vf', `scale=w='min(${width},iw)':h=-2`,
		'-frames:v', '1', '-q:v', '12', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'
	]
	const buffer = await runFfmpeg('ffmpeg', args, input)
	if (!buffer.length) throw new Boom('ffmpeg produced no output')
	return { buffer, original: await probeDimensions(input) }
}

/**
 * @param {Buffer | string} input image bytes or a file path
 * @param {number} width thumbnail width in px
 * @returns {Promise<{ buffer: Buffer, original: { width?: number, height?: number } }>}
 */
export async function extractImageThumbFallback(input, width = 32) {
	let header
	let size
	if (Buffer.isBuffer(input)) {
		header = input
		size = input.length
	} else {
		header = await readHeader(input)
		size = (await fs.stat(input)).size
	}
	const decodable = isJpeg(header) || isPng(header)
	const big = size > BUILTIN_PREFERRED_MAX_BYTES
	const attempts = []
	if (decodable) {
		const builtin = async () => builtinThumb(Buffer.isBuffer(input) ? input : await fs.readFile(input), width)
		attempts.push(builtin)
		if (big) attempts.unshift(() => ffmpegThumb(input, width))
		else attempts.push(() => ffmpegThumb(input, width))
	} else {
		attempts.push(() => ffmpegThumb(input, width))
	}
	const errors = []
	for (const attempt of attempts) {
		try {
			return await attempt()
		} catch (err) {
			errors.push(err?.message ?? String(err))
		}
	}
	throw new Boom(`could not generate image thumbnail (install sharp, @napi-rs/image or jimp, or ffmpeg): ${errors.join(' | ')}`)
}

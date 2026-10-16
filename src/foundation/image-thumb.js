import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Boom } from './boom.js'

// Dependency-free image thumbnails. Used when none of sharp / @napi-rs/image / jimp is installed,
// so a missing optional library never results in a media message without jpegThumbnail
// (the recipient sees that as a grey box). Uses ffmpeg.

const FFMPEG_TIMEOUT_MS = 15_000

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
	try {
		return await ffmpegThumb(input, width)
	} catch (err) {
		throw new Boom(`could not generate image thumbnail (install sharp, @napi-rs/image or jimp, or ffmpeg): ${err?.message ?? String(err)}`)
	}
}

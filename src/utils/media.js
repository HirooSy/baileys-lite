/**
 * Media handling utilities. Combines what used to be messages-media.js and link-preview.js.
 *
 * Optional packages (`sharp`, `@napi-rs/image`, `jimp`) are NOT declared in package.json. They are dynamically
 * imported and used only if the application installs them itself; each call site degrades gracefully when one is
 * missing (see below). Audio durations, WAV/FLAC waveforms and link previews no longer need `music-metadata`,
 * `audio-decode` or `link-preview-js` — they're handled by the built-in modules in ../foundation.
 */
import { spawn } from 'node:child_process'
import { audioDuration } from '../foundation/audio-duration.js'
import { decodeChannel0, waveformFromSamples } from '../foundation/audio-samples.js'
import { getLinkPreview } from '../foundation/link-preview.js'
import * as Crypto from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { proto } from '../../WAProto/index.js'
import { Boom } from '../foundation/boom.js'
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../binary/wa-binary.js'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './wa-protocol-core.js'
import { generateMessageIDV2 } from './wa-protocol-core.js'

const DEFAULT_ORIGIN = 'https://web.whatsapp.com'

export const MEDIA_HKDF_KEY_MAPPING = {
	audio: 'Audio',
	document: 'Document',
	gif: 'Video',
	image: 'Image',
	ppic: '',
	product: 'Image',
	ptt: 'Audio',
	'sticker-pack': 'Sticker Pack',
	'thumbnail-sticker-pack': 'Sticker Pack Thumbnail',
	sticker: 'Image',
	video: 'Video',
	'thumbnail-document': 'Document Thumbnail',
	'thumbnail-image': 'Image Thumbnail',
	'thumbnail-video': 'Video Thumbnail',
	'thumbnail-link': 'Link Thumbnail',
	'md-msg-hist': 'History',
	'md-app-state': 'App State',
	'product-catalog-image': 'Product Catalog Image',
	'payment-bg-image': 'Payment Background',
	ptv: 'Video',
	'biz-cover-photo': 'Image',
	location: 'Location',
	contact: 'Contact',
	'voip-token': 'Voip Token'
}

export const MEDIA_PATH_MAP = {
	image: '/mms/image',
	video: '/mms/video',
	document: '/mms/document',
	audio: '/mms/audio',
	sticker: '/mms/image',
	'sticker-pack': '/mms/sticker-pack',
	'thumbnail-sticker-pack': '/mms/thumbnail-sticker-pack',
	'thumbnail-link': '/mms/image',
	'thumbnail-image': '/mms/image',
	'thumbnail-video': '/mms/video',
	'thumbnail-document': '/mms/document',
	'product-catalog-image': '/product/image',
	'md-app-state': '',
	'md-msg-hist': '/mms/md-app-state',
	'biz-cover-photo': '/pps/biz-cover-photo'
}

export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP)

const NEWSLETTER_MEDIA_PATH_MAP = {
	image: '/newsletter/newsletter-image',
	video: '/newsletter/newsletter-video',
	document: '/newsletter/newsletter-document',
	audio: '/newsletter/newsletter-audio',
	sticker: '/newsletter/newsletter-image',
	'thumbnail-link': '/newsletter/newsletter-thumbnail-link'
}

const getTmpFilesDirectory = () => tmpdir()

/* ------------------------------------------------------------------ */
/* Image processing (sharp / @napi-rs/image / jimp — first available)  */
/* ------------------------------------------------------------------ */

let imageProcessingLibrary
export const getImageProcessingLibrary = async () => {
	if (imageProcessingLibrary) return imageProcessingLibrary
	const [sharp, image, jimp] = await Promise.all([
		import('sharp').catch(() => {}),
		import('@napi-rs/image').catch(() => {}),
		import('jimp').catch(() => {})
	])
	if (sharp) imageProcessingLibrary = { sharp }
	else if (image) imageProcessingLibrary = { image }
	else if (jimp) imageProcessingLibrary = { jimp }
	else throw new Boom('No image processing library available')
	return imageProcessingLibrary
}

export const hkdfInfoKey = type => `WhatsApp ${MEDIA_HKDF_KEY_MAPPING[type]} Keys`

export const getRawMediaUploadData = async (media, mediaType, logger) => {
	const { stream } = await getStream(media)
	logger?.debug('got stream for raw upload')
	const hasher = Crypto.createHash('sha256')
	const filePath = join(tmpdir(), mediaType + generateMessageIDV2())
	const fileWriteStream = createWriteStream(filePath)
	let fileLength = 0
	try {
		for await (const data of stream) {
			fileLength += data.length
			hasher.update(data)
			if (!fileWriteStream.write(data)) await once(fileWriteStream, 'drain')
		}
		fileWriteStream.end()
		await once(fileWriteStream, 'finish')
		stream.destroy()
		const fileSha256 = hasher.digest()
		logger?.debug('hashed data for raw upload')
		return { filePath, fileSha256, fileLength }
	} catch (error) {
		fileWriteStream.destroy()
		stream.destroy()
		try {
			await fs.unlink(filePath)
		} catch {
			// ignore
		}
		throw error
	}
}

/** generates all the keys required to encrypt/decrypt & sign a media message */
export async function getMediaKeys(buffer, mediaType) {
	if (!buffer) throw new Boom('Cannot derive from empty media key')
	if (typeof buffer === 'string') buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
	// expand using HKDF to 112 bytes, also pass in the relevant app info
	const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
	return {
		iv: expandedMediaKey.slice(0, 16),
		cipherKey: expandedMediaKey.slice(16, 48),
		macKey: expandedMediaKey.slice(48, 80)
	}
}

/** Extracts video thumb using FFMPEG */
export const extractVideoThumb = async (path, time, size) => {
	const ffmpeg = spawn(
		'ffmpeg',
		[
			'-loglevel',
			'error',
			'-ss',
			String(time),
			'-i',
			path,
			'-an',
			'-sn',
			'-dn',
			'-map_metadata',
			'-1',
			'-vf',
			`scale=${size.width}:-1`,
			'-frames:v',
			'1',
			'-c:v',
			'mjpeg',
			'-f',
			'image2pipe',
			'pipe:1'
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	)
	let buffer = Buffer.alloc(0)
	const stderrChunks = []
	ffmpeg.stdout.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk])
	})
	ffmpeg.stderr.on('data', chunk => stderrChunks.push(chunk))
	const [code] = await once(ffmpeg, 'close')
	if (code !== 0) throw new Boom(`FFmpeg failed (code ${code}):\n` + Buffer.concat(stderrChunks).toString('utf8'))
	return buffer
}

export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
	if (bufferOrFilePath instanceof Readable) bufferOrFilePath = await toBuffer(bufferOrFilePath)
	const lib = await getImageProcessingLibrary()
	if ('sharp' in lib && lib.sharp?.default) {
		const img = lib.sharp.default(bufferOrFilePath)
		const dimensions = await img.metadata()
		const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer()
		return { buffer, original: { width: dimensions.width, height: dimensions.height } }
	} else if ('image' in lib && lib.image?.Transformer) {
		if (!Buffer.isBuffer(bufferOrFilePath)) bufferOrFilePath = await fs.readFile(bufferOrFilePath)
		const img = new lib.image.Transformer(bufferOrFilePath)
		const dimensions = await img.metadata()
		const buffer = await img.resize(width, undefined, 0).jpeg(50)
		return { buffer, original: { width: dimensions.width, height: dimensions.height } }
	} else if ('jimp' in lib && lib.jimp?.Jimp) {
		const jimp = await lib.jimp.Jimp.read(bufferOrFilePath)
		const dimensions = { width: jimp.width, height: jimp.height }
		const buffer = await jimp.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 })
		return { buffer, original: dimensions }
	} else {
		throw new Boom('No image processing library available')
	}
}

export const encodeBase64EncodedStringForUpload = b64 => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))

export const generateProfilePicture = async (mediaUpload, dimensions) => {
	let buffer
	const { width: w = 720, height: h = 720 } = dimensions || {}
	if (Buffer.isBuffer(mediaUpload)) {
		buffer = mediaUpload
	} else {
		const { stream } = await getStream(mediaUpload)
		buffer = await toBuffer(stream)
	}
	const lib = await getImageProcessingLibrary()
	let img
	if ('sharp' in lib && lib.sharp?.default) {
		img = lib.sharp.default(buffer).resize(w, h).jpeg({ quality: 80 }).toBuffer()
	} else if ('image' in lib && lib.image?.Transformer) {
		img = new lib.image.Transformer(buffer).resize(w, h, 0).jpeg(80)
	} else if ('jimp' in lib && lib.jimp?.Jimp) {
		const jimp = await lib.jimp.Jimp.read(buffer)
		const min = Math.min(jimp.width, jimp.height)
		const cropped = jimp.crop({ x: 0, y: 0, w: min, h: min })
		img = cropped.resize({ w, h, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 80 })
	} else {
		throw new Boom('No image processing library available')
	}
	return { img: await img }
}

/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = message => {
	const media = Object.values(message)[0]
	return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64')
}

/**
 * Duration of an audio file in seconds. Accepts a Buffer, a file path, or a Readable stream.
 *
 * Built-in parser: Ogg Opus/Vorbis, WAV, FLAC, MP4/M4A, MP3, ADTS-AAC, AIFF/AIFF-C, Matroska/WebM, AMR-NB/WB —
 * see src/foundation/audio-duration.js. Anything else (WMA, APE, WavPack, Musepack, DSD, ...) resolves
 * `undefined` rather than guessing.
 */
export async function getAudioDuration(buffer) {
	if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') buffer = await toBuffer(buffer)
	const native = await audioDuration(buffer)
	if (typeof native === 'number' && Number.isFinite(native)) return native
	return ffprobeDuration(buffer) // containers the built-in parser doesn't cover (WMA, APE, ...)
}

async function ffprobeDuration(input) {
	const usesStdin = Buffer.isBuffer(input)
	const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', usesStdin ? 'pipe:0' : input]
	try {
		const ffprobe = spawn('ffprobe', args, { stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'ignore'] })
		const outChunks = []
		ffprobe.stdout.on('data', chunk => outChunks.push(chunk))
		if (usesStdin) ffprobe.stdin.end(input)
		const [code] = await once(ffprobe, 'close')
		if (code !== 0) return undefined
		const seconds = parseFloat(Buffer.concat(outChunks).toString('utf8').trim())
		return Number.isFinite(seconds) ? seconds : undefined
	} catch {
		return undefined // ffprobe not installed
	}
}

/**
 * First channel of an audio file as float samples via the system `ffmpeg` binary (a program, not an npm package;
 * media.js already shells out to it for video thumbnails). Used only for containers the built-in decoder cannot
 * read (Ogg Opus/Vorbis, MP3, AAC/M4A, AMR, ...). Resolves `undefined` when ffmpeg is missing or fails.
 */
const decodeChannel0WithFfmpeg = audioData =>
	new Promise(resolve => {
		let child
		try {
			child = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-af', 'pan=mono|c0=c0', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] })
		} catch {
			return resolve(undefined)
		}
		const out = []
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			resolve(undefined)
		}, 60000)
		child.on('error', () => resolve(undefined)) // ENOENT: ffmpeg not installed
		child.stdin.on('error', () => {}) // ffmpeg may close its input early (EPIPE)
		child.stdout.on('data', c => out.push(c))
		child.on('close', code => {
			clearTimeout(timer)
			const raw = Buffer.concat(out)
			if (code !== 0 || raw.length < 4) return resolve(undefined)
			const copy = new Float32Array(Math.floor(raw.length / 4))
			for (let i = 0; i < copy.length; i++) copy[i] = raw.readFloatLE(i * 4)
			resolve(copy)
		})
		child.stdin.end(audioData)
	})

/**
 * 64-value voice-note waveform (0..100). WAV and FLAC are decoded by the built-in decoder; other formats need the
 * system `ffmpeg` binary. Without either, resolves `undefined` (the voice note is still sent, just without a waveform).
 * referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export async function getAudioWaveform(buffer, logger) {
	try {
		let audioData
		if (Buffer.isBuffer(buffer)) audioData = buffer
		else if (typeof buffer === 'string') audioData = await toBuffer(createReadStream(buffer))
		else audioData = await toBuffer(buffer)
		const rawData = decodeChannel0(audioData) ?? (await decodeChannel0WithFfmpeg(audioData))
		if (!rawData || !rawData.length) {
			logger?.debug('Failed to generate waveform: no decoder for this audio (built-in handles WAV/FLAC; other formats need ffmpeg)')
			return undefined
		}
		return waveformFromSamples(rawData)
	} catch (e) {
		logger?.debug('Failed to generate waveform: ' + e)
	}
}

export const toReadable = buffer => {
	const readable = new Readable({ read: () => {} })
	readable.push(buffer)
	readable.push(null)
	return readable
}

export const toBuffer = async stream => {
	const chunks = []
	for await (const chunk of stream) chunks.push(chunk)
	stream.destroy()
	return Buffer.concat(chunks)
}

export const getStream = async (item, opts) => {
	if (Buffer.isBuffer(item)) return { stream: toReadable(item), type: 'buffer' }
	if ('stream' in item) return { stream: item.stream, type: 'readable' }
	const urlStr = item.url.toString()
	if (urlStr.startsWith('data:')) {
		const buffer = Buffer.from(urlStr.split(',')[1], 'base64')
		return { stream: toReadable(buffer), type: 'buffer' }
	}
	if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) return { stream: await getHttpStream(item.url, opts), type: 'remote' }
	return { stream: createReadStream(item.url), type: 'file' }
}

/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(file, mediaType, options) {
	let thumbnail
	let originalImageDimensions
	if (mediaType === 'image') {
		const { buffer, original } = await extractImageThumb(file)
		thumbnail = buffer.toString('base64')
		if (original.width && original.height) originalImageDimensions = { width: original.width, height: original.height }
	} else if (mediaType === 'video') {
		try {
			const buff = await extractVideoThumb(file, '00:00:00', { width: 32, height: 32 })
			thumbnail = buff.toString('base64')
		} catch (err) {
			options.logger?.debug('could not generate video thumb: ' + err)
		}
	}
	return { thumbnail, originalImageDimensions }
}

export const getHttpStream = async (url, options = {}) => {
	const response = await fetch(url.toString(), { dispatcher: options.dispatcher, method: 'GET', headers: options.headers })
	if (!response.ok) throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } })
	return response.body instanceof Readable ? response.body : Readable.fromWeb(response.body)
}

export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts } = {}) => {
	const { stream, type } = await getStream(media, opts)
	logger?.debug('fetched media stream')
	const mediaKey = Crypto.randomBytes(32)
	const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType)
	const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-enc')
	const encFileWriteStream = createWriteStream(encFilePath)
	let originalFileStream
	let originalFilePath
	if (saveOriginalFileIfRequired) {
		originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-original')
		originalFileStream = createWriteStream(originalFilePath)
	}
	let fileLength = 0
	const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
	const hmac = Crypto.createHmac('sha256', macKey).update(iv)
	const sha256Plain = Crypto.createHash('sha256')
	const sha256Enc = Crypto.createHash('sha256')
	const onChunk = async buff => {
		sha256Enc.update(buff)
		hmac.update(buff)
		if (!encFileWriteStream.write(buff)) await once(encFileWriteStream, 'drain')
	}
	try {
		for await (const data of stream) {
			fileLength += data.length
			if (type === 'remote' && opts?.maxContentLength && fileLength + data.length > opts.maxContentLength) {
				throw new Boom(`content length exceeded when encrypting "${type}"`, { data: { media, type } })
			}
			if (originalFileStream) {
				if (!originalFileStream.write(data)) await once(originalFileStream, 'drain')
			}
			sha256Plain.update(data)
			await onChunk(aes.update(data))
		}
		await onChunk(aes.final())
		const mac = hmac.digest().slice(0, 10)
		sha256Enc.update(mac)
		const fileSha256 = sha256Plain.digest()
		const fileEncSha256 = sha256Enc.digest()
		encFileWriteStream.write(mac)
		const encFinishPromise = once(encFileWriteStream, 'finish')
		const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve()
		encFileWriteStream.end()
		originalFileStream?.end?.()
		stream.destroy()
		// Wait for write streams to fully flush to disk (reduces memory pressure).
		await encFinishPromise
		await originalFinishPromise
		logger?.debug('encrypted data successfully')
		return { mediaKey, originalFilePath, encFilePath, mac, fileEncSha256, fileSha256, fileLength }
	} catch (error) {
		encFileWriteStream.destroy()
		originalFileStream?.destroy?.()
		aes.destroy()
		hmac.destroy()
		sha256Plain.destroy()
		sha256Enc.destroy()
		stream.destroy()
		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) await fs.unlink(originalFilePath)
		} catch (err) {
			logger?.error({ err }, 'failed deleting tmp files')
		}
		throw error
	}
}

export const DEF_MEDIA_HOST = 'mmg.whatsapp.net'
const AES_CHUNK_SIZE = 16
const toSmallestChunkSize = num => Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE

export const getUrlFromDirectPath = (directPath, host = DEF_MEDIA_HOST) => `https://${host}${directPath}`

const extractHost = url => {
	if (!url) return undefined
	try {
		return new URL(url).host
	} catch {
		return undefined
	}
}

export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
	// Fallback host: explicit opt > host parsed from `url` > DEF_MEDIA_HOST.
	const fallbackHost = opts.host ?? extractHost(url)
	const downloadUrl = directPath ? getUrlFromDirectPath(directPath, fallbackHost) : url
	if (!downloadUrl) throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 })
	const keys = await getMediaKeys(mediaKey, type)
	return downloadEncryptedContent(downloadUrl, keys, opts)
}

/** Decrypts and downloads an AES256-CBC encrypted file; the plaintext's SHA256 is appended to the ciphertext. */
export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv }, { startByte, endByte, options } = {}) => {
	let bytesFetched = 0
	let startChunk = 0
	let firstBlockIsIV = false
	if (startByte) {
		const chunk = toSmallestChunkSize(startByte || 0)
		if (chunk) {
			startChunk = chunk - AES_CHUNK_SIZE
			bytesFetched = chunk
			firstBlockIsIV = true
		}
	}
	const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined
	const headersInit = options?.headers ? options.headers : undefined
	const headers = {
		...(headersInit ? (Array.isArray(headersInit) ? Object.fromEntries(headersInit) : headersInit) : {}),
		Origin: DEFAULT_ORIGIN
	}
	if (startChunk || endChunk) {
		headers.Range = `bytes=${startChunk}-`
		if (endChunk) headers.Range += endChunk
	}
	const fetched = await getHttpStream(downloadUrl, { ...(options || {}), headers })
	let remainingBytes = Buffer.from([])
	let aes

	const pushBytes = (bytes, push) => {
		if (startByte || endByte) {
			const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0)
			const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0)
			push(bytes.slice(start, end))
			bytesFetched += bytes.length
		} else {
			push(bytes)
		}
	}

	const output = new Transform({
		transform(chunk, _, callback) {
			let data = remainingBytes.length ? Buffer.concat([remainingBytes, chunk]) : chunk
			const decryptLength = toSmallestChunkSize(data.length)
			remainingBytes = data.slice(decryptLength)
			data = data.slice(0, decryptLength)
			if (!aes) {
				let ivValue = iv
				if (firstBlockIsIV) {
					ivValue = data.slice(0, AES_CHUNK_SIZE)
					data = data.slice(AES_CHUNK_SIZE)
				}
				aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
				if (endByte) aes.setAutoPadding(false) // avoid PKCS7 errors when trimming to a byte range
			}
			try {
				pushBytes(aes.update(data), b => this.push(b))
				callback()
			} catch (error) {
				callback(error)
			}
		},
		final(callback) {
			try {
				pushBytes(aes.final(), b => this.push(b))
				callback()
			} catch (error) {
				callback(error)
			}
		}
	})
	// pipe() does not forward 'error' events from source to destination -- without this,
	// a dropped connection or malformed response on `fetched` crashes the process
	// (unhandled 'error' on the source) instead of surfacing as an error on the
	// returned stream that callers can catch.
	fetched.on('error', err => output.destroy(err))
	return fetched.pipe(output, { end: true })
}

export function extensionForMediaMessage(message) {
	const getExtension = mimetype => mimetype.split(';')[0]?.split('/')[1]
	const type = Object.keys(message)[0]
	let extension
	if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
		extension = '.jpeg'
	} else {
		extension = getExtension(message[type].mimetype)
	}
	return extension
}

const isNodeRuntime = () =>
	typeof process !== 'undefined' && process.versions?.node !== null && typeof process.versions.bun === 'undefined' && typeof globalThis.Deno === 'undefined'

export const uploadWithNodeHttp = async ({ url, filePath, headers, timeoutMs, agent }, redirectCount = 0) => {
	if (redirectCount > 5) throw new Error('Too many redirects')
	const parsedUrl = new URL(url)
	const httpModule = parsedUrl.protocol === 'https:' ? await import('node:https') : await import('node:http')
	const fileStats = await fs.stat(filePath) // Content-Length is required for Node.js streaming
	const fileSize = fileStats.size
	return new Promise((resolve, reject) => {
		const req = httpModule.request(
			{
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method: 'POST',
				headers: { ...headers, 'Content-Length': fileSize },
				agent,
				timeout: timeoutMs
			},
			res => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume() // consume response to free resources
					const newUrl = new URL(res.headers.location, url).toString()
					resolve(uploadWithNodeHttp({ url: newUrl, filePath, headers, timeoutMs, agent }, redirectCount + 1))
					return
				}
				let body = ''
				res.on('data', chunk => (body += chunk))
				res.on('end', () => {
					try {
						resolve(JSON.parse(body))
					} catch {
						resolve(undefined)
					}
				})
			}
		)
		req.on('error', reject)
		req.on('timeout', () => {
			req.destroy()
			reject(new Error('Upload timeout'))
		})
		const stream = createReadStream(filePath)
		stream.pipe(req)
		stream.on('error', err => {
			req.destroy()
			reject(err)
		})
	})
}

const uploadWithFetch = async ({ url, filePath, headers, timeoutMs, agent }) => {
	const nodeStream = createReadStream(filePath)
	const webStream = Readable.toWeb(nodeStream)
	// Native fetch only accepts Undici-style dispatchers, not generic https Agents.
	const dispatcher = typeof agent?.dispatch === 'function' ? agent : undefined
	const response = await fetch(url, {
		...(dispatcher ? { dispatcher } : {}),
		method: 'POST',
		body: webStream,
		headers,
		duplex: 'half',
		signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
	})
	try {
		return await response.json()
	} catch {
		return undefined
	}
}

/**
 * Uploads media to WhatsApp servers.
 *
 * Two implementations: Node's native `fetch` (undici) buffers the whole request body in
 * memory even when streaming, causing high memory use on large files
 * (see https://github.com/nodejs/undici/issues/4058) — so on Node we use `node:http(s)`
 * directly. Other runtimes (Bun, Deno, browsers) stream correctly, so they use fetch.
 */
const uploadMedia = async (params, logger) => {
	if (isNodeRuntime()) {
		logger?.debug('Using Node.js https module for upload (avoids undici buffering bug)')
		return uploadWithNodeHttp(params)
	} else {
		logger?.debug('Using web-standard Fetch API for upload')
		return uploadWithFetch(params)
	}
}

export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
	return async (filePath, { mediaType, fileEncSha256B64, timeoutMs, newsletter }) => {
		let uploadInfo = await refreshMediaConn(false)
		let urls
		const hosts = [...customUploadHosts, ...uploadInfo.hosts]
		fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)
		const customHeaders = (() => {
			const hdrs = options?.headers
			if (!hdrs) return {}
			return Array.isArray(hdrs) ? Object.fromEntries(hdrs) : hdrs
		})()
		const headers = { ...customHeaders, 'Content-Type': 'application/octet-stream', Origin: DEFAULT_ORIGIN }

		for (const { hostname } of hosts) {
			logger.debug(`uploading to "${hostname}"`)
			const auth = encodeURIComponent(uploadInfo.auth)
			const mediaPathMap = newsletter ? NEWSLETTER_MEDIA_PATH_MAP : MEDIA_PATH_MAP
			const serverThumb = newsletter ? '&server_thumb_gen=1' : ''
			const url = `https://${hostname}${mediaPathMap[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}${serverThumb}`
			let result
			try {
				result = await uploadMedia({ url, filePath, headers, timeoutMs, agent: fetchAgent }, logger)
				if (result?.url || result?.direct_path) {
					urls = {
						mediaUrl: result.url,
						directPath: result.direct_path,
						meta_hmac: result.meta_hmac,
						fbid: result.fbid,
						ts: result.ts,
						thumbnailDirectPath: result.thumbnail_info?.thumbnail_direct_path,
						thumbnailSha256: result.thumbnail_info?.thumbnail_sha256
					}
					break
				} else {
					uploadInfo = await refreshMediaConn(true)
					throw new Error(`upload failed, reason: ${JSON.stringify(result)}`)
				}
			} catch (error) {
				const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname
				logger.warn({ trace: error?.stack, uploadResult: result }, `Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`)
			}
		}
		if (!urls) throw new Boom('Media upload failed on all hosts', { statusCode: 500 })
		return urls
	}
}

const getMediaRetryKey = mediaKey => hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })

/** Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL */
export const encryptMediaRetryRequest = (key, mediaKey, meId) => {
	const recp = { stanzaId: key.id }
	const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish()
	const iv = Crypto.randomBytes(12)
	const retryKey = getMediaRetryKey(mediaKey)
	const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id))
	return {
		tag: 'receipt',
		attrs: { id: key.id, to: jidNormalizedUser(meId), type: 'server-error' },
		content: [
			// this encrypt node is actually pretty useless — media returns even without it —
			// kept here to maintain parity with WA Web
			{
				tag: 'encrypt',
				attrs: {},
				content: [
					{ tag: 'enc_p', attrs: {}, content: ciphertext },
					{ tag: 'enc_iv', attrs: {}, content: iv }
				]
			},
			{ tag: 'rmr', attrs: { jid: key.remoteJid, from_me: (!!key.fromMe).toString(), participant: key.participant || undefined } }
		]
	}
}

export const decodeMediaRetryNode = node => {
	const rmrNode = getBinaryNodeChild(node, 'rmr')
	const event = {
		key: {
			id: node.attrs.id,
			remoteJid: rmrNode.attrs.jid,
			fromMe: rmrNode.attrs.from_me === 'true',
			participant: rmrNode.attrs.participant
		}
	}
	const errorNode = getBinaryNodeChild(node, 'error')
	if (errorNode) {
		const errorCode = +errorNode.attrs.code
		event.error = new Boom(`Failed to re-upload media (${errorCode})`, { data: errorNode.attrs, statusCode: getStatusCodeForMediaRetry(errorCode) })
	} else {
		const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt')
		const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p')
		const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv')
		if (ciphertext && iv) event.media = { ciphertext, iv }
		else event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
	}
	return event
}

export const decryptMediaRetryData = ({ ciphertext, iv }, mediaKey, msgId) => {
	const retryKey = getMediaRetryKey(mediaKey)
	const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId))
	return proto.MediaRetryNotification.decode(plaintext)
}

const MEDIA_RETRY_STATUS_MAP = {
	[proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
	[proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
	[proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
	[proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
}
export const getStatusCodeForMediaRetry = code => MEDIA_RETRY_STATUS_MAP[code]

/* ------------------------------------------------------------------ */
/* Link preview                                                        */
/* ------------------------------------------------------------------ */

const THUMBNAIL_WIDTH_PX = 192

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async (url, { thumbnailWidth, fetchOpts }) => {
	const stream = await getHttpStream(url, fetchOpts)
	return extractImageThumb(stream, thumbnailWidth)
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it.
 * Returns undefined if the fetch failed or no URL was found.
 */
export const getUrlInfo = async (text, opts = { thumbnailWidth: THUMBNAIL_WIDTH_PX, fetchOpts: { timeout: 3000 } }) => {
	try {
		let retries = 0
		const maxRetry = 5
		let previewLink = text
		if (!text.startsWith('https://') && !text.startsWith('http://')) previewLink = 'https://' + previewLink

		const info = await getLinkPreview(previewLink, {
			...opts.fetchOpts,
			followRedirects: 'follow',
			handleRedirects: (baseURL, forwardedURL) => {
				const urlObj = new URL(baseURL)
				const forwardedURLObj = new URL(forwardedURL)
				if (retries >= maxRetry) return false
				if (
					forwardedURLObj.hostname === urlObj.hostname ||
					forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
					'www.' + forwardedURLObj.hostname === urlObj.hostname
				) {
					retries += 1
					return true
				}
				return false
			},
			headers: opts.fetchOpts?.headers
		})

		if (info && 'title' in info && info.title) {
			const [image] = info.images
			const urlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}
			if (opts.uploadImage) {
				// imported lazily to avoid a hard circular dependency with the message-composition module
				const { prepareWAMessageMedia } = await import('./message-compose.js')
				const { imageMessage } = await prepareWAMessageMedia(
					{ image: { url: image } },
					{ upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts }
				)
				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined
				} catch (error) {
					opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail')
				}
			}
			return urlInfo
		}
	} catch (error) {
		if (!error.message.includes('receive a valid')) throw error
	}
}

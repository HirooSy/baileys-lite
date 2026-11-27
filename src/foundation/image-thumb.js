import { imageThumb } from '../ffmpeg/index.js'
import { Boom } from './boom.js'

/**
 * @param {Buffer | string} input image bytes or a file path
 * @param {number} width thumbnail width in px
 * @returns {Promise<{ buffer: Buffer, original: { width?: number, height?: number } }>}
 */
export async function extractImageThumbFallback(input, width = 32) {
	const thumb = await imageThumb(input, width)
	if (!thumb) throw new Boom('could not generate image thumbnail (install sharp, @napi-rs/image or jimp)')
	return thumb
}

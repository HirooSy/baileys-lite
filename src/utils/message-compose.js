/**
 * Message composition utilities. Combines what used to be messages.js and
 * rich-message-utils.js. LANGUAGE_KEYWORDS (syntax-highlighting keyword lists)
 * moved here from WABinary/constants.js, where it had been misplaced — it's
 * message-composition data, not WA binary-protocol data.
 */
import { getRandomValues, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { proto } from '../../WAProto/index.js'
import { AIRichBuilder, aiRichBuilderFromSpec } from '../foundation/ai-rich.js'
import { Boom } from '../foundation/boom.js'
import { zip } from '../foundation/zip.js'
import {
	AssociationType,
	ButtonHeaderType,
	ButtonType,
	CarouselCardType,
	CodeHighlightType,
	ListType,
	RichSubMessageType,
	WAMessageStatus,
	WAProto
} from '../constants.js'
import { isLidUser, isPnUser, isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../binary/wa-binary.js'
import { sha256, generateMessageIDV2, getKeyAuthor, unixTimestampSeconds, shouldIncludeReportingToken } from './wa-protocol-core.js'
import {
	downloadContentFromMessage,
	encryptedStream,
	generateThumbnail,
	getAudioDuration,
	getAudioWaveform,
	getImageProcessingLibrary,
	getRawMediaUploadData,
	getStream,
	toBuffer
} from './media.js'

const LIBRARY_NAME = 'Baileys'
const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60
const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'
const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
const MEDIA_KEYS = ['image', 'video', 'audio', 'sticker', 'document']
export const URL_REGEX = /https:\/\/(?![^:@/\s]+:[^:@/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g
const LEXER_REGEX =
	/(\/\/.*|\/\*[\s\S]*?\*\/|#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[\s\S]*?`)|(\b[a-zA-Z_]\w*\b)(?=\s*\()|(\b[a-zA-Z_]\w*\b)|(\b\d+(?:\.\d+)?\b)|(\s+|[^\w\s]+)/g

const CONCURRENCY_LIMIT = 15
const MIMETYPE_MAP = {
	image: 'image/jpeg',
	video: 'video/mp4',
	document: 'application/pdf',
	audio: 'audio/ogg; codecs=opus',
	sticker: 'image/webp',
	'product-catalog-image': 'image/jpeg'
}
const MessageTypeProto = {
	image: WAProto.Message.ImageMessage,
	video: WAProto.Message.VideoMessage,
	audio: WAProto.Message.AudioMessage,
	sticker: WAProto.Message.StickerMessage,
	document: WAProto.Message.DocumentMessage
}

/* ------------------------------------------------------------------ */
/* Code syntax-highlighting keyword lists (for richResponseMessage)     */
/* ------------------------------------------------------------------ */

const CPP_KEYWORDS = new Set([
	'alignas','alignof','and','and_eq','asm','auto','bitand','bitor','bool','break','case',
	'catch','char','class','compl','concept','const','consteval','constexpr','constinit',
	'const_cast','continue','co_await','co_return','co_yield','decltype','default','delete',
	'do','double','dynamic_cast','else','enum','explicit','export','extern','false','float',
	'for','friend','goto','if','inline','int','long','mutable','namespace','new','noexcept',
	'not','not_eq','nullptr','operator','or','or_eq','private','protected','public','register',
	'reinterpret_cast','requires','return','short','signed','sizeof','static','static_assert',
	'static_cast','struct','switch','template','this','thread_local','throw','true','try',
	'typedef','typeid','typename','union','unsigned','using','virtual','void','volatile',
	'wchar_t','while','xor','xor_eq'
])
const CSS_KEYWORDS = new Set([
	'import','media','font-face','keyframes','supports','charset',
	'important','root','hover','active','focus','visited','before','after',
	'not','nth-child','first-child','last-child','only-child',
	'none','inherit','initial','unset','auto','transparent','currentcolor'
])
const GO_KEYWORDS = new Set([
	'break','default','func','interface','select','case','defer','go','map','struct',
	'chan','else','goto','package','switch','const','fallthrough','if','range','type',
	'continue','for','import','return','var','true','false','nil'
])
const HTML_KEYWORDS = new Set([
	'html','head','body','title','meta','link','script','style',
	'header','footer','main','section','article','aside','nav',
	'div','span','h1','h2','h3','h4','h5','h6','p','a','img',
	'ul','ol','li','table','tr','td','th','thead','tbody',
	'form','input','button','select','textarea','label','option',
	'canvas','svg','iframe','video','audio','source'
])
const JS_KEYWORDS = new Set([
	'import','export','from','default','as',
	'const','let','var','function','class','extends','new',
	'return','if','else','for','while','do','switch','case','break','continue',
	'try','catch','finally','throw',
	'async','await','yield',
	'typeof','instanceof','in','of','delete','void',
	'true','false','null','undefined','NaN','Infinity',
	'this','super','static','get','set',
	'debugger','with'
])
const PYTHON_KEYWORDS = new Set([
	'import','from','as','def','class','return','if','elif','else',
	'for','while','break','continue','try','except','finally','raise',
	'with','yield','lambda','pass','del','global','nonlocal','assert',
	'True','False','None','and','or','not','in','is','async','await',
	'self','print'
])
const RUST_KEYWORDS = new Set([
	'as','break','const','continue','crate','else','enum','extern',
	'false','fn','for','if','impl','in','let','loop','match',
	'mod','move','mut','pub','ref','return','self','Self',
	'static','struct','super','trait','true','type','unsafe',
	'use','where','while','async','await','dyn',
	'abstract','become','box','do','final','macro',
	'override','priv','typeof','unsized','virtual','yield',
	'try'
])
const C_KEYWORDS = new Set([
	'auto','break','case','char','const','continue',
	'default','do','double','else','enum','extern',
	'float','for','goto','if','inline','int',
	'long','register','restrict','return','short',
	'signed','sizeof','static','struct','switch',
	'typedef','union','unsigned','void','volatile',
	'while',
	'_Alignas','_Alignof','_Atomic','_Bool',
	'_Complex','_Generic','_Imaginary',
	'_Noreturn','_Static_assert','_Thread_local'
])
const CSHARP_KEYWORDS = new Set([
	'abstract','as','base','bool','break','byte',
	'case','catch','char','checked','class',
	'const','continue','decimal','default',
	'delegate','do','double','else','enum',
	'event','explicit','extern','false','finally',
	'fixed','float','for','foreach','goto',
	'if','implicit','in','int','interface',
	'internal','is','lock','long','namespace',
	'new','null','object','operator','out',
	'override','params','private','protected',
	'public','readonly','ref','return','sbyte',
	'sealed','short','sizeof','stackalloc',
	'static','string','struct','switch',
	'this','throw','true','try','typeof',
	'uint','ulong','unchecked','unsafe',
	'ushort','using','virtual','void',
	'volatile','while',
	'async','await','record','init',
	'required','file','global','nameof',
	'var','dynamic','partial','yield',
	'from','where','select','group',
	'orderby','join','let','into',
	'equals','by','ascending','descending'
])
const BASH_KEYWORDS = new Set([
	'if','then','else','elif','fi',
	'case','esac','for','while',
	'until','do','done','in',
	'function','select','time',
	'coproc',
	'echo','printf','read','cd',
	'pwd','exit','export','unset',
	'alias','unalias','source',
	'exec','eval','test','shift',
	'trap','wait','jobs','kill',
	'bg','fg','history','type',
	'ulimit','umask','set',
	'true','false'
])
const CMD_KEYWORDS = new Set([
	'echo','set','if','else',
	'for','in','do','goto',
	'call','exit','shift',
	'pause','start','title',
	'cls','rem',
	'dir','copy','move','del',
	'mkdir','rmdir','type',
	'ren','tasklist','taskkill',
	'ping','ipconfig','netstat',
	'shutdown'
])
const POWERSHELL_KEYWORDS = new Set([
	'function','filter','param',
	'begin','process','end',
	'if','else','elseif',
	'switch','foreach','for',
	'while','do','until',
	'break','continue','return',
	'throw','trap','try',
	'catch','finally',
	'$true','$false','$null',
	'Write-Host','Write-Output',
	'Get-Item','Set-Item',
	'Get-ChildItem','Remove-Item',
	'Copy-Item','Move-Item',
	'Test-Path','Invoke-Command'
])
const LANGUAGE_KEYWORDS = {
	css: CSS_KEYWORDS,
	html: HTML_KEYWORDS,
	javascript: JS_KEYWORDS,
	typescript: JS_KEYWORDS,
	js: JS_KEYWORDS,
	ts: JS_KEYWORDS,
	python: PYTHON_KEYWORDS,
	py: PYTHON_KEYWORDS,
	go: GO_KEYWORDS,
	golang: GO_KEYWORDS,
	cpp: CPP_KEYWORDS,
	'c++': CPP_KEYWORDS,
	rust: RUST_KEYWORDS,
	rs: RUST_KEYWORDS,
	c: C_KEYWORDS,
	h: C_KEYWORDS,
	csharp: CSHARP_KEYWORDS,
	cs: CSHARP_KEYWORDS,
	bash: BASH_KEYWORDS,
	sh: BASH_KEYWORDS,
	zsh: BASH_KEYWORDS,
	cmd: CMD_KEYWORDS,
	bat: CMD_KEYWORDS,
	powershell: POWERSHELL_KEYWORDS,
	ps1: POWERSHELL_KEYWORDS
}

const NOOP_KEYWORDS = new Set([])

export const tokenizeCode = (code, language = 'javascript') => {
	const keywords = LANGUAGE_KEYWORDS[language] || NOOP_KEYWORDS
	const blocks = []
	LEXER_REGEX.lastIndex = 0
	let match
	while ((match = LEXER_REGEX.exec(code)) !== null) {
		if (match[1]) blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] })
		else if (match[2]) blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] })
		else if (match[3]) blocks.push({ highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD, codeContent: match[3] })
		else if (match[4]) blocks.push({ highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT, codeContent: match[4] })
		else if (match[5]) blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] })
		else blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] })
	}
	return blocks
}

export const toUnified = (submessages, uuid) => ({
	response_id: uuid || randomUUID(),
	sections: submessages.map(submessage => {
		switch (submessage.messageType) {
			case RichSubMessageType.CODE: {
				const codeMetadata = submessage.codeMetadata
				return {
					view_model: {
						primitive: {
							language: codeMetadata.codeLanguage,
							code_blocks: codeMetadata.codeBlocks.map(block => ({ content: block.codeContent, type: CodeHighlightType[block.highlightType] })),
							__typename: 'GenAICodeUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				}
			}
			case RichSubMessageType.CONTENT_ITEMS:
			case RichSubMessageType.INLINE_IMAGE:
			case RichSubMessageType.LATEX:
				return {}
			case RichSubMessageType.TABLE: {
				const tableMetadata = submessage.tableMetadata
				return {
					view_model: {
						primitive: {
							title: tableMetadata.title,
							rows: tableMetadata.rows.map(row => ({ is_header: row.isHeading, cells: row.items, markdown_cells: row.items.map(item => ({ text: item })) })),
							__typename: 'GenATableUXPrimitive'
						},
						__typename: 'GenAISingleLayoutViewModel'
					}
				}
			}
			case RichSubMessageType.TEXT:
				return {
					view_model: {
						primitive: { text: submessage.messageText, inline_entities: submessage.inlineEntities || [], __typename: 'GenAIMarkdownTextUXPrimitive' },
						__typename: 'GenAISingleLayoutViewModel'
					}
				}
			default:
				return submessage
		}
	})
})

export const prepareRichResponseMessage = content => {
	const {
		alignment, code, contentText, disclaimerText, footerText, headerText, imageText, inlineImage, inlineVideo,
		items, language, latex, links, noHeading, posts, products, suggested, richResponse, table, tapLinkUrl, title
	} = content
	let submessages = []
	if (Array.isArray(richResponse)) {
		submessages = richResponse.map(submessage => {
			if (submessage.text) return { messageType: RichSubMessageType.TEXT, messageText: submessage.text, inlineEntities: submessage.inlineEntities }
			if (submessage.code) return { messageType: RichSubMessageType.CODE, codeMetadata: { codeLanguage: submessage.language, codeBlocks: submessage.code } }
			if (submessage.items) {
				return {
					messageType: RichSubMessageType.CONTENT_ITEMS,
					contentItemsMetadata: { itemsMetadata: submessage.items, contentType: proto.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL }
				}
			}
			if (submessage.inlineImage) {
				return {
					messageType: RichSubMessageType.INLINE_IMAGE,
					imageMetadata: { imageUrl: submessage.inlineImage, imageText: submessage.imageText, alignment: submessage.alignment, tapLinkUrl: submessage.tapLinkUrl }
				}
			}
			if (submessage.inlineVideo) return { messageType: RichSubMessageType.TEXT, messageText: 'INLINE_VIDEO' }
			if (submessage.latex) return { messageType: RichSubMessageType.LATEX, latexMetadata: { text: submessage.text, expressions: submessage.latex } }
			if (submessage.posts) return { messageType: RichSubMessageType.TEXT, messageText: 'POSTS' }
			if (submessage.products) return { messageType: RichSubMessageType.TEXT, messageText: 'PRODUCTS' }
			if (submessage.suggested) return { messageType: RichSubMessageType.TEXT, messageText: 'SUGGESTED_PROMPT' }
			if (submessage.table) return { messageType: RichSubMessageType.TABLE, tableMetadata: { title: submessage.title, rows: submessage.table } }
			return submessage
		})
	} else {
		if (headerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: headerText })
		if (contentText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: contentText })
		if (code) {
			const lang = language || 'javascript'
			submessages.push({ messageType: RichSubMessageType.CODE, codeMetadata: { codeLanguage: lang, codeBlocks: tokenizeCode(code, lang) } })
		}
		if (items) {
			submessages.push({
				messageType: RichSubMessageType.CONTENT_ITEMS,
				contentItemsMetadata: { itemsMetadata: items, contentType: proto.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL }
			})
		}
		if (inlineImage) submessages.push({ messageType: RichSubMessageType.INLINE_IMAGE, imageMetadata: { imageUrl: inlineImage, imageText, alignment, tapLinkUrl } })
		if (inlineVideo) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'INLINE_VIDEO' })
		if (latex) submessages.push({ messageType: RichSubMessageType.LATEX, latexMetadata: { text: content.text, expressions: latex } })
		if (links) {
			links.forEach((linkField, index) => {
				const prefix = 'SS_' + index
				const url = linkField.url
				const sources = linkField.sources?.map(sourceField => ({
					source_type: 'THIRD_PARTY',
					source_display_name: sourceField.displayName,
					source_subtitle: sourceField.subtitle,
					source_url: sourceField.url || url
				}))
				submessages.push({
					messageType: RichSubMessageType.TEXT,
					messageText: linkField.text + ` {{${prefix}}}¹{{/${prefix}}} `,
					inlineEntities: [
						{
							key: prefix,
							metadata: {
								reference_id: index + 1,
								reference_url: url,
								reference_title: linkField.title,
								reference_display_name: linkField.displayName,
								sources: sources || [],
								__typename: 'GenAISearchCitationItem'
							}
						}
					]
				})
			})
		}
		if (posts) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'POSTS' })
		if (products) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'PRODUCTS' })
		if (suggested) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'SUGGESTED_PROMPT' })
		if (table) {
			submessages.push({
				messageType: RichSubMessageType.TABLE,
				tableMetadata: { title, rows: table.map((items_, index) => ({ isHeading: !noHeading && index === 0, items: items_ })) }
			})
		}
		if (footerText) submessages.push({ messageType: RichSubMessageType.TEXT, messageText: footerText })
	}

	const uuid = randomUUID()
	const unified = toUnified(submessages, uuid)
	const richResponseMessage = proto.AIRichResponseMessage.create({
		submessages,
		messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
		unifiedResponse: { data: Buffer.from(JSON.stringify(unified)) },
		contextInfo: { isForwarded: true, forwardingScore: 1, forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }, forwardOrigin: 4 }
	})
	const message = wrapToBotForwardedMessage(richResponseMessage)
	const botMetadata = message.messageContextInfo.botMetadata
	if (disclaimerText) botMetadata.messageDisclaimerText = disclaimerText
	botMetadata.botResponseId = uuid
	return message
}

export const botMetadataSignature = () => {
	const signature = new Uint8Array(64)
	getRandomValues(signature)
	return signature
}

export const botMetadataCertificate = (length = 685) => {
	const certificate = new Uint8Array(length)
	certificate[0] = 48
	certificate[1] = 130
	getRandomValues(certificate.subarray(2))
	return certificate
}

export const wrapToBotForwardedMessage = richResponseMessage => ({
	messageContextInfo: {
		botMetadata: {
			verificationMetadata: {
				proofs: [{ certificateChain: [botMetadataCertificate(), botMetadataCertificate(892)], version: 1, useCase: 1, signature: botMetadataSignature() }]
			}
		}
	},
	botForwardedMessage: { message: { richResponseMessage } }
})

/* ------------------------------------------------------------------ */
/* Message content composition                                         */
/* ------------------------------------------------------------------ */

/** Uses a regex to test whether the string contains a URL, and returns the URL if it does. */
export const extractUrlFromText = text => text.match(URL_REGEX)?.[0]

export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
	const url = extractUrlFromText(text)
	if (!!getUrlInfo && url) {
		try {
			return await getUrlInfo(url)
		} catch (error) {
			logger?.warn({ trace: error.stack }, 'url generation failed')
		}
	}
}

const assertColor = async color => {
	if (typeof color === 'number') return color > 0 ? color : 0xffffffff + Number(color) + 1
	let hex = color.trim().replace('#', '')
	if (hex.length <= 6) hex = 'FF' + hex.padStart(6, '0')
	return parseInt(hex, 16)
}

export const prepareWAMessageMedia = async (message, options) => {
	const logger = options.logger
	let mediaType
	for (const key of MEDIA_KEYS) if (key in message) mediaType = key
	if (!mediaType) throw new Boom('Invalid media type', { statusCode: 400 })

	const uploadData = { ...message, media: message[mediaType] }
	delete uploadData[mediaType]

	const cacheableKey =
		typeof uploadData.media === 'object' &&
		'url' in uploadData.media &&
		!!uploadData.media.url &&
		!!options.mediaCache &&
		mediaType + ':' + uploadData.media.url.toString()

	if (mediaType === 'document' && !uploadData.fileName) uploadData.fileName = 'file'
	if (!uploadData.mimetype) uploadData.mimetype = MIMETYPE_MAP[mediaType]

	if (cacheableKey) {
		const mediaBuff = await options.mediaCache.get(cacheableKey)
		if (mediaBuff) {
			logger?.debug({ cacheableKey }, 'got media cache hit')
			const obj = proto.Message.decode(mediaBuff)
			const key = `${mediaType}Message`
			Object.assign(obj[key], { ...uploadData, media: undefined })
			return obj
		}
	}

	const isNewsletter = !!options.jid && isJidNewsletter(options.jid)
	if (isNewsletter) {
		logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter')
		const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger)
		const fileSha256B64 = fileSha256.toString('base64')
		const { mediaUrl, directPath, thumbnailDirectPath, thumbnailSha256 } = await options.upload(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType,
			timeoutMs: options.mediaUploadTimeoutMs,
			newsletter: isNewsletter
		})
		await fs.unlink(filePath)
		const obj = WAProto.Message.fromObject({
			[`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
				url: mediaUrl,
				directPath,
				fileSha256,
				fileLength,
				thumbnailDirectPath,
				thumbnailSha256,
				...uploadData,
				media: undefined
			})
		})
		if (uploadData.ptv) {
			obj.ptvMessage = obj.videoMessage
			delete obj.videoMessage
		}
		if (obj.stickerMessage) obj.stickerMessage.stickerSentTs = Date.now()
		if (cacheableKey) {
			logger?.debug({ cacheableKey }, 'set cache')
			await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish())
		}
		return obj
	}

	const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
	const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined'
	const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined'
	const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
	const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation

	const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(
		uploadData.media,
		options.mediaTypeOverride || mediaType,
		{ logger, saveOriginalFileIfRequired: requiresOriginalForSomeProcessing, opts: options.options }
	)
	const fileEncSha256B64 = fileEncSha256.toString('base64')
	const [{ mediaUrl, directPath }] = await Promise.all([
		(async () => {
			const result = await options.upload(encFilePath, { fileEncSha256B64, mediaType, timeoutMs: options.mediaUploadTimeoutMs })
			logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
			return result
		})(),
		(async () => {
			try {
				if (requiresThumbnailComputation) {
					const { thumbnail, originalImageDimensions } = await generateThumbnail(originalFilePath, mediaType, options)
					uploadData.jpegThumbnail = thumbnail
					if (!uploadData.width && originalImageDimensions) {
						uploadData.width = originalImageDimensions.width
						uploadData.height = originalImageDimensions.height
						logger?.debug('set dimensions')
					}
					logger?.debug('generated thumbnail')
				}
				if (requiresDurationComputation) {
					uploadData.seconds = await getAudioDuration(originalFilePath)
					logger?.debug('computed audio duration')
				}
				if (requiresWaveformProcessing) {
					uploadData.waveform = await getAudioWaveform(originalFilePath, logger)
					logger?.debug('processed waveform')
				}
				if (requiresAudioBackground) {
					uploadData.backgroundArgb = await assertColor(options.backgroundColor)
					logger?.debug('computed backgroundColor audio status')
				}
			} catch (error) {
				logger?.warn({ trace: error.stack }, 'failed to obtain extra info')
			}
		})()
	]).finally(async () => {
		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) await fs.unlink(originalFilePath)
			logger?.debug('removed tmp files')
		} catch {
			logger?.warn('failed to remove tmp file')
		}
	})

	const obj = WAProto.Message.fromObject({
		[`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
			url: mediaUrl,
			directPath,
			mediaKey,
			fileEncSha256,
			fileSha256,
			fileLength,
			mediaKeyTimestamp: unixTimestampSeconds(),
			...uploadData,
			media: undefined
		})
	})
	if (uploadData.ptv) {
		obj.ptvMessage = obj.videoMessage
		delete obj.videoMessage
	}
	if (cacheableKey) {
		logger?.debug({ cacheableKey }, 'set cache')
		await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish())
	}
	return obj
}

const prepareProductMessage = async (message, options) => {
	if (!message.businessOwnerJid) throw new Boom('"businessOwnerJid" is missing from the content', { statusCode: 400 })
	const { imageMessage } = await prepareWAMessageMedia({ image: message.image || message.product.productImage }, options)
	const { image, ...content } = message
	content.product = { currencyCode: 'IDR', priceAmount1000: 1000, title: LIBRARY_NAME, ...message.product, productImage: imageMessage }
	return content
}

/**
 * Credits: Work on ensuring stickerPackMessage fields are valid by @jlucaso1
 * (https://github.com/jlucaso1), based on https://github.com/WhiskeySockets/Baileys/pull/1561
 */
const prepareStickerPackMessage = async (message, options) => {
	const { cover, stickers = [], name = '📦 Sticker Pack', publisher = '', description = '' } = message
	if (stickers.length > 60) throw new Boom('Sticker pack exceeds the maximum limit of 60 stickers', { statusCode: 400 })
	if (stickers.length === 0) throw new Boom('Sticker pack must contain at least one sticker', { statusCode: 400 })
	if (!cover) throw new Boom('Sticker pack must contain a cover', { statusCode: 400 })

	const logger = options.logger
	let cacheableKey = false
	if (Array.isArray(stickers) && stickers.length && options.mediaCache) {
		const urls = []
		for (const s of stickers) {
			if (typeof s.data === 'object' && s.data?.url) urls.push(s.data.url)
		}
		if (urls.length > 0) cacheableKey = 'sticker:' + urls.join('@')
	}
	if (cacheableKey) {
		const mediaBuff = await options.mediaCache.get(cacheableKey)
		if (mediaBuff) {
			logger?.debug({ cacheableKey }, 'got media cache hit')
			return proto.Message.StickerPackMessage.decode(mediaBuff)
		}
	}

	const lib = await getImageProcessingLibrary()
	const hasSharp = 'sharp' in lib && !!lib.sharp?.default
	const hasImage = 'image' in lib && !!lib.image?.Transformer
	const hasJimp = 'jimp' in lib && !!lib.jimp?.Jimp
	if (!hasSharp && !hasImage) throw new Boom('No image processing library (sharp or @napi-rs/image) available for converting sticker to WebP.')

	const stickerPackIdValue = generateMessageIDV2()
	const stickerData = {}
	const stickerMetadata = new Array(stickers.length)
	for (let i = 0; i < stickers.length; i += CONCURRENCY_LIMIT) {
		const promises = []
		const chunkEnd = Math.min(i + CONCURRENCY_LIMIT, stickers.length)
		for (let j = i; j < chunkEnd; j++) {
			promises.push(
				(async index => {
					const sticker = stickers[index]
					const { stream } = await getStream(sticker.data)
					const buffer = await toBuffer(stream)
					let webpBuffer
					let isAnimated = false
					if (isWebPBuffer(buffer)) {
						webpBuffer = buffer
						isAnimated = isAnimatedWebP(buffer)
					} else if (hasSharp) {
						webpBuffer = await lib.sharp.default(buffer).resize(512, 512, { fit: 'inside' }).webp({ quality: 80 }).toBuffer()
					} else {
						webpBuffer = await new lib.image.Transformer(buffer).resize(512, 512).webp(80)
					}
					if (webpBuffer.length > 1024 * 1024) throw new Boom(`Sticker at index ${index} exceeds the 1MB size limit`, { statusCode: 400 })
					const hash = sha256(webpBuffer).toString('base64').replace(/\//g, '-')
					const fileName = `${hash}.webp`
					stickerData[fileName] = [new Uint8Array(webpBuffer), { level: 0 }]
					stickerMetadata[index] = {
						fileName,
						mimetype: 'image/webp',
						isAnimated,
						emojis: sticker.emojis || ['✨'],
						accessibilityLabel: sticker.accessibilityLabel || '‎'
					}
				})(j)
			)
		}
		await Promise.all(promises)
	}

	const trayIconFileName = `${stickerPackIdValue}.webp`
	const { stream: coverStream } = await getStream(cover)
	const coverBuffer = await toBuffer(coverStream)
	let coverWebpBuffer
	if (isWebPBuffer(coverBuffer)) coverWebpBuffer = coverBuffer
	else if (hasSharp) coverWebpBuffer = await lib.sharp.default(coverBuffer).resize(512, 512, { fit: 'inside' }).webp({ quality: 80 }).toBuffer()
	else coverWebpBuffer = await new lib.image.Transformer(coverBuffer).resize(512, 512).webp(80)
	stickerData[trayIconFileName] = [new Uint8Array(coverWebpBuffer), { level: 0 }]

	const zipBuffer = await new Promise((resolve, reject) => {
		zip(stickerData, (error, data) => (error ? reject(error) : resolve(Buffer.from(data))))
	})
	const stickerPackUpload = await encryptedStream(zipBuffer, 'sticker-pack', { logger, opts: options.options })
	let stickerPackUploadResult
	try {
		stickerPackUploadResult = await options.upload(stickerPackUpload.encFilePath, {
			fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
			mediaType: 'sticker-pack',
			timeoutMs: options.mediaUploadTimeoutMs
		})
	} finally {
		fs.unlink(stickerPackUpload.encFilePath).catch(() => logger?.warn('failed to remove tmp file'))
	}

	const obj = {
		name,
		publisher,
		stickerPackId: stickerPackIdValue,
		packDescription: description,
		stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
		stickerPackSize: zipBuffer.length,
		stickers: stickerMetadata,
		fileSha256: stickerPackUpload.fileSha256,
		fileEncSha256: stickerPackUpload.fileEncSha256,
		mediaKey: stickerPackUpload.mediaKey,
		directPath: stickerPackUploadResult.directPath,
		fileLength: stickerPackUpload.fileLength,
		mediaKeyTimestamp: unixTimestampSeconds(),
		trayIconFileName
	}

	try {
		let thumbnailBuffer
		if (hasSharp) thumbnailBuffer = await lib.sharp.default(coverBuffer).resize(252, 252).jpeg().toBuffer()
		else if (hasImage) thumbnailBuffer = await new lib.image.Transformer(coverBuffer).resize(252, 252).jpeg()
		else if (hasJimp) {
			const jimpImage = await lib.jimp.Jimp.read(coverBuffer)
			thumbnailBuffer = await jimpImage.resize({ w: 252, h: 252 }).getBuffer('image/jpeg')
		} else {
			throw new Error('No image processing library available for thumbnail generation')
		}
		if (!thumbnailBuffer || thumbnailBuffer.length === 0) throw new Error('Failed to generate thumbnail buffer')

		const thumbUpload = await encryptedStream(thumbnailBuffer, 'thumbnail-sticker-pack', { logger, opts: options.options, mediaKey: stickerPackUpload.mediaKey })
		let thumbUploadResult
		try {
			thumbUploadResult = await options.upload(thumbUpload.encFilePath, {
				fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'),
				mediaType: 'thumbnail-sticker-pack',
				timeoutMs: options.mediaUploadTimeoutMs
			})
		} finally {
			fs.unlink(thumbUpload.encFilePath).catch(() => logger?.warn('failed to remove tmp file'))
		}
		Object.assign(obj, {
			thumbnailDirectPath: thumbUploadResult.directPath,
			thumbnailSha256: thumbUpload.fileSha256,
			thumbnailEncSha256: thumbUpload.fileEncSha256,
			thumbnailHeight: 252,
			thumbnailWidth: 252,
			imageDataHash: sha256(thumbnailBuffer).toString('base64')
		})
	} catch (error) {
		logger?.warn(`Thumbnail generation failed: ${error}`)
	}

	if (cacheableKey) {
		logger?.debug({ cacheableKey }, 'set cache (background)')
		options.mediaCache.set(cacheableKey, WAProto.Message.StickerPackMessage.encode(obj).finish())
	}
	return WAProto.Message.StickerPackMessage.fromObject(obj)
}

/**
 * `nativeFlow` accepts a plain array of button objects — `{text, id}`, `{text, url}`, `{text, copy}`,
 * `{text, sections}`, `{text, call}` — or `{ buttons: [...] }`. Matches WAProto's InteractiveMessage.NativeFlowMessage
 * button shape 1:1; see prepareNativeFlowButtons below for the encoding.
 */
const prepareNativeFlowButtons = message => {
	const buttons = message.nativeFlow
	const isButtonsFieldArray = Array.isArray(buttons)
	const correctedField = isButtonsFieldArray ? buttons : buttons.buttons
	const messageParamsJson = {}
	if (hasOptionalProperty(message, 'offerText') && !!message.offerText) {
		Object.assign(messageParamsJson, {
			limited_time_offer: { text: message.offerText || LIBRARY_NAME, ...(message.offerUrl ? { url: message.offerUrl } : {}), copy_code: message.offerCode, expiration_time: message.offerExpiration }
		})
	}
	if (hasOptionalProperty(message, 'optionText') && !!message.optionText) {
		Object.assign(messageParamsJson, {
			bottom_sheet: {
				in_thread_buttons_limit: 1,
				divider_indices: Array.from({ length: correctedField.length }, (_, index) => index),
				list_title: message.optionTitle || '📄 Select Options',
				button_title: message.optionText
			}
		})
	}
	return {
		buttons: correctedField.map(button => {
			const buttonText = button.text || button.buttonText
			const buttonIcon = button.icon?.toUpperCase()
			if (hasOptionalProperty(button, 'id') && !!button.id) {
				return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: buttonText || '👉🏻 Click', id: button.id, icon: buttonIcon }) }
			}
			if (hasOptionalProperty(button, 'copy') && !!button.copy) {
				return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: buttonText || '📋 Copy', copy_code: button.copy, icon: buttonIcon }) }
			}
			if (hasOptionalProperty(button, 'url') && !!button.url) {
				return {
					name: 'cta_url',
					buttonParamsJson: JSON.stringify({ display_text: buttonText || '🌐 Visit', url: button.url, merchant_url: button.url, webview_interaction: button.useWebview, icon: buttonIcon })
				}
			}
			if (hasOptionalProperty(button, 'call') && !!button.call) {
				return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: buttonText || '📞 Call', phone_number: button.call, icon: buttonIcon }) }
			}
			if (hasOptionalProperty(button, 'sections') && !!button.sections) {
				return { name: 'single_select', buttonParamsJson: JSON.stringify({ title: buttonText || '📋 Select', sections: button.sections, icon: buttonIcon }) }
			}
			return button
		}),
		messageParamsJson: JSON.stringify(messageParamsJson)
	}
}

export const prepareDisappearingMessageSettingContent = ephemeralExpiration => {
	ephemeralExpiration = ephemeralExpiration || 0
	return WAProto.Message.fromObject({
		ephemeralMessage: { message: { protocolMessage: { type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING, ephemeralExpiration } } }
	})
}

/**
 * Generate forwarded message content like WA does.
 * @param message the message to forward
 * @param forceForward will show the message as forwarded even if it is from you
 */
export const generateForwardMessageContent = (message, forceForward) => {
	let content = message.message
	if (!content) throw new Boom('no content in message', { statusCode: 400 })
	content = normalizeMessageContent(content)
	content = proto.Message.decode(proto.Message.encode(content).finish())
	let key = Object.keys(content)[0]
	let score = content?.[key]?.contextInfo?.forwardingScore || 0
	score += message.key.fromMe && !forceForward ? 0 : 1
	if (key === 'conversation') {
		content.extendedTextMessage = { text: content[key] }
		delete content.conversation
		key = 'extendedTextMessage'
	}
	const key_ = content?.[key]
	key_.contextInfo = score > 0 ? { forwardingScore: score, isForwarded: true } : {}
	return content
}

export const hasNonNullishProperty = (message, key) => message != null && typeof message === 'object' && key in message && message[key] != null
export const hasOptionalProperty = (obj, key) => obj != null && typeof obj === 'object' && key in obj && obj[key] != null
export const hasValidAlbumMedia = message => !!(message.imageMessage || message.videoMessage)
export const hasValidInteractiveHeader = message =>
	!!(message.imageMessage || message.videoMessage || message.documentMessage || message.productMessage || message.locationMessage)
export const hasValidCarouselHeader = message => !!(message.imageMessage || message.videoMessage || message.productMessage)

export const generateWAMessageContent = async (message, options) => {
	let m = {}
	if (hasNonNullishProperty(message, 'raw')) {
		delete message.raw
		return message
	} else if (hasNonNullishProperty(message, 'aiRich')) {
		const { aiRich, forwarded, quoted, quotedParticipant, botJid } = message
		const builder = aiRich instanceof AIRichBuilder ? aiRich : aiRichBuilderFromSpec(aiRich)
		m = builder.build({ forwarded, quoted, quotedParticipant, botJid })
	} else if (
		hasNonNullishProperty(message, 'code') ||
		hasNonNullishProperty(message, 'links') ||
		hasNonNullishProperty(message, 'table') ||
		hasNonNullishProperty(message, 'richResponse')
	) {
		m = prepareRichResponseMessage(message)
	} else if (hasNonNullishProperty(message, 'text')) {
		const extContent = { text: message.text }
		let urlInfo = message.linkPreview
		if (typeof urlInfo === 'undefined') urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)
		if (urlInfo) {
			extContent.matchedText = urlInfo['matched-text']
			extContent.jpegThumbnail = urlInfo.jpegThumbnail
			extContent.description = urlInfo.description
			extContent.title = urlInfo.title
			extContent.previewType = urlInfo.previewType ?? 0
			extContent.linkPreviewMetadata = urlInfo.linkPreviewMetadata
			const img = urlInfo.highQualityThumbnail
			if (img) {
				extContent.thumbnailDirectPath = img.directPath
				extContent.mediaKey = img.mediaKey
				extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
				extContent.thumbnailWidth = img.width
				extContent.thumbnailHeight = img.height
				extContent.thumbnailSha256 = img.fileSha256
				extContent.thumbnailEncSha256 = img.fileEncSha256
			}
		}
		const faviconData = message.favicon
		if (faviconData && typeof options.upload === 'function') {
			const { imageMessage } = await prepareWAMessageMedia({ image: faviconData }, options)
			extContent.faviconMMSMetadata = {
				thumbnailDirectPath: imageMessage.directPath,
				mediaKey: imageMessage.mediaKey,
				mediaKeyTimestamp: imageMessage.mediaKeyTimestamp,
				thumbnailWidth: 32,
				thumbnailHeight: 32,
				thumbnailSha256: imageMessage.fileSha256,
				thumbnailEncSha256: imageMessage.fileEncSha256
			}
		}
		if (options.backgroundColor) extContent.backgroundArgb = await assertColor(options.backgroundColor)
		if (options.font) extContent.font = options.font
		m.extendedTextMessage = extContent
	} else if (hasNonNullishProperty(message, 'contacts')) {
		const contactLen = message.contacts.contacts.length
		if (!contactLen) throw new Boom('require atleast 1 contact', { statusCode: 400 })
		if (contactLen === 1) m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0])
		else m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts)
	} else if (hasNonNullishProperty(message, 'location')) {
		m.locationMessage = WAProto.Message.LocationMessage.create(message.location)
	} else if (hasNonNullishProperty(message, 'react')) {
		if (!message.react.senderTimestampMs) message.react.senderTimestampMs = Date.now()
		m.reactionMessage = WAProto.Message.ReactionMessage.create(message.react)
	} else if (hasNonNullishProperty(message, 'delete')) {
		m.protocolMessage = { key: message.delete, type: WAProto.Message.ProtocolMessage.Type.REVOKE }
	} else if (hasNonNullishProperty(message, 'forward')) {
		m = generateForwardMessageContent(message.forward, message.force)
	} else if (hasNonNullishProperty(message, 'disappearingMessagesInChat')) {
		const exp =
			typeof message.disappearingMessagesInChat === 'boolean'
				? message.disappearingMessagesInChat
					? WA_DEFAULT_EPHEMERAL
					: 0
				: message.disappearingMessagesInChat
		m = prepareDisappearingMessageSettingContent(exp)
	} else if (hasNonNullishProperty(message, 'groupInvite')) {
		m.groupInviteMessage = {}
		m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode
		m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration
		m.groupInviteMessage.caption = message.groupInvite.text
		m.groupInviteMessage.groupJid = message.groupInvite.jid
		m.groupInviteMessage.groupName = message.groupInvite.subject
		if (options.getProfilePicUrl) {
			const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview')
			if (pfpUrl) {
				const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher })
				if (resp.ok) m.groupInviteMessage.jpegThumbnail = Buffer.from(await resp.arrayBuffer())
			}
		}
	} else if (hasNonNullishProperty(message, 'stickers')) {
		m.stickerPackMessage = await prepareStickerPackMessage(message, options)
	} else if (hasNonNullishProperty(message, 'pin')) {
		m.pinInChatMessage = {}
		m.messageContextInfo = {}
		m.pinInChatMessage.key = message.pin
		m.pinInChatMessage.type = message.type
		m.pinInChatMessage.senderTimestampMs = Date.now()
		m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0
	} else if (hasNonNullishProperty(message, 'keep')) {
		m.keepInChatMessage = {}
		m.keepInChatMessage.key = message.keep
		m.keepInChatMessage.keepType = message.type
		m.keepInChatMessage.timestampMs = Date.now()
	} else if (hasNonNullishProperty(message, 'flowReply')) {
		m.interactiveResponseMessage = {
			body: { format: message.flowReply.format || proto.Message.InteractiveResponseMessage.Body.Format.DEFAULT, text: message.flowReply.text },
			nativeFlowResponseMessage: { name: message.flowReply.name, paramsJson: message.flowReply.paramsJson || '{}', version: message.flowReply.version || 1 }
		}
	} else if (hasNonNullishProperty(message, 'buttonReply')) {
		if (message.type === 'template') {
			m.templateButtonReplyMessage = {
				selectedDisplayText: message.buttonReply.displayText,
				selectedId: message.buttonReply.id,
				selectedIndex: message.buttonReply.index
			}
		} else if (message.type === 'plain') {
			m.buttonsResponseMessage = {
				selectedButtonId: message.buttonReply.id,
				selectedDisplayText: message.buttonReply.displayText,
				type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
			}
		}
	} else if (hasNonNullishProperty(message, 'listReply')) {
		m.listResponseMessage = {
			description: message.listReply.description,
			listType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT,
			singleSelectReply: { selectedRowId: message.listReply.id },
			title: message.listReply.title
		}
	} else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
		const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options)
		m.ptvMessage = videoMessage
	} else if (hasNonNullishProperty(message, 'product')) {
		m.productMessage = await prepareProductMessage(message, options)
	} else if (hasNonNullishProperty(message, 'event')) {
		m.eventMessage = {}
		const startTime = Math.floor(message.event.startDate.getTime() / 1000)
		if (message.event.call && options.getCallLink) {
			const token = await options.getCallLink(message.event.call, { startTime })
			m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token
		}
		m.messageContextInfo = { messageSecret: message.event.messageSecret || randomBytes(32) }
		m.eventMessage.name = message.event.name
		m.eventMessage.description = message.event.description
		m.eventMessage.startTime = startTime
		m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined
		m.eventMessage.isCanceled = message.event.isCancelled ?? false
		m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed
		m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false
		m.eventMessage.location = message.event.location
	} else if (hasNonNullishProperty(message, 'poll')) {
		message.poll.selectableCount ||= 0
		message.poll.toAnnouncementGroup ||= false
		if (!Array.isArray(message.poll.values)) throw new Boom('Invalid poll values', { statusCode: 400 })
		if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
			throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, { statusCode: 400 })
		}
		const pollCreationMessage = {
			name: message.poll.name,
			selectableOptionsCount: message.poll.selectableCount,
			options: message.poll.values.map(optionName => ({ optionName })),
			endTime: message.poll.endDate ? message.poll.endDate.getTime() : undefined,
			hideParticipantName: message.poll.hideVoter ?? false,
			allowAddOption: message.poll.canAddOption ?? false
		}
		if (message.poll.toAnnouncementGroup) {
			m.pollCreationMessageV2 = pollCreationMessage // v2: community announcement groups (single + multiple select)
		} else if (message.poll.pollType === 1) {
			if (!message.poll.correctAnswer) throw new Boom('No "correctAnswer" provided for quiz', { statusCode: 400 })
			m.pollCreationMessageV5 = {
				...pollCreationMessage, // quiz — newsletter only
				correctAnswer: { optionName: message.poll.correctAnswer.toString() },
				pollType: 1,
				selectableOptionsCount: 1
			}
		} else if (message.poll.hideVoter) {
			m.pollCreationMessageV6 = pollCreationMessage // v6: hidden-voter-names poll variant
		} else if (message.poll.selectableCount === 1) {
			m.pollCreationMessageV3 = pollCreationMessage // v3: single select polls
		} else {
			m.pollCreationMessage = pollCreationMessage // multiple choice polls
		}
		m.messageContextInfo = { messageSecret: message.poll.messageSecret || randomBytes(32) }
	} else if (hasNonNullishProperty(message, 'pollResult')) {
		const pollResultSnapshotMessage = {
			name: message.pollResult.name,
			pollVotes: message.pollResult.votes.map(vote => ({ optionName: vote.name, optionVoteCount: parseInt(vote.voteCount) }))
		}
		if (message.pollResult.pollType === 1) {
			pollResultSnapshotMessage.pollType = proto.Message.PollType.QUIZ
			m.pollResultSnapshotMessageV3 = pollResultSnapshotMessage
		} else {
			pollResultSnapshotMessage.pollType = proto.Message.PollType.POLL
			m.pollResultSnapshotMessage = pollResultSnapshotMessage
		}
	} else if (hasNonNullishProperty(message, 'pollUpdate')) {
		if (!message.pollUpdate.key) throw new Boom('Message key is required', { statusCode: 400 })
		if (!message.pollUpdate.vote) throw new Boom('Encrypted vote payload is required', { statusCode: 400 })
		m.pollUpdateMessage = { metadata: message.pollUpdate.metadata, pollCreationMessageKey: message.pollUpdate.key, senderTimestampMs: Date.now(), vote: message.pollUpdate.vote }
	} else if (hasNonNullishProperty(message, 'paymentInviteServiceType')) {
		m.paymentInviteMessage = { expiryTimestamp: Date.now(), serviceType: message.paymentInviteServiceType }
	} else if (hasNonNullishProperty(message, 'orderText')) {
		if (!Buffer.isBuffer(message.thumbnail)) throw new Boom('Must provide thumbnail buffer in order message', { statusCode: 400 })
		m.orderMessage = {
			itemCount: 1,
			messageVersion: 1,
			orderTitle: LIBRARY_NAME,
			status: proto.Message.OrderMessage.OrderStatus.INQUIRY,
			surface: proto.Message.OrderMessage.OrderSurface.CATALOG,
			token: generateMessageIDV2(),
			totalAmount1000: 1000,
			totalCurrencyCode: 'IDR',
			...message,
			message: message.orderText
		}
		delete m.orderMessage.orderText
	} else if (hasNonNullishProperty(message, 'album')) {
		if (!Array.isArray(message.album)) throw new Boom('Invalid album type. Expected an array.', { statusCode: 400 })
		let videoCount = 0
		let imageCount = 0
		for (const item of message.album) {
			if (item.video) videoCount++
			if (item.image) imageCount++
		}
		if (videoCount + imageCount < 2) throw new Boom('Minimum provide 2 media to upload album message', { statusCode: 400 })
		m.albumMessage = { expectedImageCount: imageCount, expectedVideoCount: videoCount }
	} else if (hasNonNullishProperty(message, 'sharePhoneNumber')) {
		m.protocolMessage = { type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER }
	} else if (hasNonNullishProperty(message, 'requestPhoneNumber')) {
		m.requestPhoneNumberMessage = {}
	} else if (hasNonNullishProperty(message, 'limitSharing')) {
		m.protocolMessage = {
			type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
			limitSharing: { sharingLimited: message.limitSharing === true, trigger: 1, limitSharingSettingTimestamp: Date.now(), initiatedByMe: true }
		}
	} else {
		m = await prepareWAMessageMedia(message, options)
	}

	if (hasNonNullishProperty(message, 'buttons')) {
		const buttonsMessage = {
			buttons: message.buttons.map(button => {
				const buttonText = button.text || button.buttonText
				if (hasOptionalProperty(button, 'sections')) {
					return { nativeFlowInfo: { name: 'single_select', paramsJson: JSON.stringify({ title: buttonText, sections: button.sections }) }, type: ButtonType.NATIVE_FLOW }
				}
				if (hasOptionalProperty(button, 'name')) {
					return { nativeFlowInfo: { name: button.name, paramsJson: button.paramsJson }, type: ButtonType.NATIVE_FLOW }
				}
				return { buttonId: button.id || button.buttonId, buttonText: typeof buttonText === 'string' ? { displayText: buttonText } : buttonText, type: button.type || ButtonType.RESPONSE }
			})
		}
		if (hasOptionalProperty(message, 'text')) {
			buttonsMessage.contentText = message.text
			buttonsMessage.headerType = ButtonHeaderType.EMPTY
		} else {
			if (hasOptionalProperty(message, 'caption')) buttonsMessage.contentText = message.caption
			const type = Object.keys(m)[0].replace('Message', '').toUpperCase()
			buttonsMessage.headerType = ButtonHeaderType[type]
			Object.assign(buttonsMessage, m)
		}
		if (hasOptionalProperty(message, 'footer')) buttonsMessage.footerText = message.footer
		m = { buttonsMessage }
	} else if (hasNonNullishProperty(message, 'sections')) {
		m = { listMessage: { sections: message.sections, buttonText: message.buttonText, title: message.title, footerText: message.footer, description: message.text, listType: ListType.SINGLE_SELECT } }
	} else if (hasNonNullishProperty(message, 'templateButtons')) {
		const hydratedTemplate = {
			hydratedButtons: message.templateButtons.map((button, i) => {
				const buttonText = button.text || button.buttonText
				if (hasOptionalProperty(button, 'id')) return { index: i, quickReplyButton: { displayText: buttonText || '👉🏻 Click', id: button.id } }
				if (hasOptionalProperty(button, 'url')) return { index: i, urlButton: { displayText: buttonText || '🌐 Visit', url: button.url } }
				if (hasOptionalProperty(button, 'call')) return { index: i, callButton: { displayText: buttonText || '📞 Call', phoneNumber: button.call } }
				button.index = button.index || i
				return button
			})
		}
		if (hasOptionalProperty(message, 'text')) {
			hydratedTemplate.hydratedContentText = message.text
		} else {
			if (hasOptionalProperty(message, 'caption')) {
				hydratedTemplate.hydratedTitleText = message.title
				hydratedTemplate.hydratedContentText = message.caption
			}
			Object.assign(hydratedTemplate, m)
		}
		if (hasOptionalProperty(message, 'footer')) hydratedTemplate.hydratedFooterText = message.footer
		hydratedTemplate.templateId = message.id || 'template-' + Date.now()
		m = { templateMessage: { hydratedFourRowTemplate: hydratedTemplate, hydratedTemplate } }
	} else if (hasNonNullishProperty(message, 'nativeFlow')) {
		const interactiveMessage = { nativeFlowMessage: prepareNativeFlowButtons(message) }
		if (hasOptionalProperty(message, 'bizJid')) {
			interactiveMessage.collectionMessage = { bizJid: message.bizJid, id: message.id, messageVersion: 1 }
		} else if (hasOptionalProperty(message, 'shopSurface')) {
			interactiveMessage.shopStorefrontMessage = { surface: message.shopSurface, id: message.id, messageVersion: 1 }
		}
		if (hasOptionalProperty(message, 'text')) {
			interactiveMessage.body = { text: message.text }
		} else {
			if (hasOptionalProperty(message, 'caption')) {
				const isValidHeader = hasValidInteractiveHeader(m)
				if (!isValidHeader) throw new Boom('Invalid media type for interactive message header', { statusCode: 400 })
				interactiveMessage.header = { title: message.title || '', subtitle: message.subtitle || '', hasMediaAttachment: isValidHeader }
				interactiveMessage.body = { text: message.caption }
			}
			if (hasOptionalProperty(message, 'thumbnail') && !!message.thumbnail) interactiveMessage.jpegThumbnail = message.thumbnail
			Object.assign(interactiveMessage.header, m)
		}
		if (hasOptionalProperty(message, 'audioFooter')) {
			const { audioMessage } = await prepareWAMessageMedia({ audio: message.audioFooter }, options)
			interactiveMessage.footer = { audioMessage, hasMediaAttachment: true }
		} else if (hasOptionalProperty(message, 'footer')) {
			interactiveMessage.footer = { text: message.footer }
		}
		m = { interactiveMessage }
	} else if (hasNonNullishProperty(message, 'cards')) {
		const interactiveMessage = {
			carouselMessage: {
				cards: await Promise.all(
					message.cards.map(async card => {
						let carouselHeader = {}
						if (hasNonNullishProperty(card, 'product')) carouselHeader.productMessage = await prepareProductMessage(card, options)
						else carouselHeader = await prepareWAMessageMedia(card, options).catch(() => ({}))
						const isValidHeader = hasValidCarouselHeader(carouselHeader)
						if (!isValidHeader) throw new Boom('Invalid media type for carousel card', { statusCode: 400 })
						const carouselCard = { nativeFlowMessage: prepareNativeFlowButtons(card.nativeFlow ? card : []) }
						if (hasOptionalProperty(card, 'text')) {
							carouselCard.body = { text: card.text }
						} else {
							if (hasOptionalProperty(card, 'caption')) {
								carouselCard.header = { title: card.title || '', subtitle: card.subtitle || '', hasMediaAttachment: isValidHeader }
								carouselCard.body = { text: card.caption }
							}
							if (hasOptionalProperty(card, 'thumbnail') && !!card.thumbnail) carouselCard.jpegThumbnail = card.thumbnail
							Object.assign(carouselCard.header, carouselHeader)
						}
						if (hasOptionalProperty(card, 'audioFooter')) {
							const { audioMessage } = await prepareWAMessageMedia({ audio: card.audioFooter }, options)
							carouselCard.footer = { audioMessage, hasMediaAttachment: true }
						} else if (hasOptionalProperty(card, 'footer')) {
							carouselCard.footer = { text: card.footer }
						}
						return carouselCard
					})
				),
				carouselCardType: CarouselCardType.UNKNOWN,
				messageVersion: 1
			}
		}
		if (hasOptionalProperty(message, 'text')) interactiveMessage.body = { text: message.text }
		if (hasOptionalProperty(message, 'footer')) interactiveMessage.footer = { text: message.footer }
		m = { interactiveMessage }
	} else if (hasNonNullishProperty(message, 'requestPaymentFrom')) {
		const requestPaymentMessage = {
			amount: { currencyCode: 'IDR', offset: 1000, value: 1000 },
			amount1000: 1000,
			currencyCodeIso4217: 'IDR',
			expiryTimestamp: Date.now(),
			noteMessage: m,
			requestFrom: message.requestPaymentFrom,
			...message
		}
		delete requestPaymentMessage.requestPaymentFrom
		if (hasNonNullishProperty(m, 'extendedTextMessage') || hasNonNullishProperty(m, 'stickerMessage')) {
			Object.assign(requestPaymentMessage.noteMessage, m)
		} else {
			throw new Boom('Invalid message type for request payment note message', { statusCode: 400 })
		}
		m = { requestPaymentMessage }
	} else if (hasNonNullishProperty(message, 'invoiceNote')) {
		const attachment = m.imageMessage || m.documentMessage
		const type = Object.keys(m)[0].replace('Message', '').toUpperCase()
		const invoiceMessage = { attachmentType: proto.Message.InvoiceMessage.AttachmentType[type === 'DOCUMENT' ? 'PDF' : 'IMAGE'], note: message.invoiceNote }
		if (attachment) {
			const { directPath, fileEncSha256, fileSha256, jpegThumbnail = undefined, mediaKey, mediaKeyTimestamp, mimetype } = attachment
			Object.assign(invoiceMessage, {
				attachmentDirectPath: directPath,
				attachmentFileEncSha256: fileEncSha256,
				attachmentFileSha256: fileSha256,
				attachmentJpegThumbnail: jpegThumbnail,
				attachmentMediaKey: mediaKey,
				attachmentMediaKeyTimestamp: mediaKeyTimestamp,
				attachmentMimetype: mimetype,
				token: generateMessageIDV2()
			})
		} else {
			throw new Boom('Invalid media type for invoice message', { statusCode: 400 })
		}
		m = { invoiceMessage }
	}

	if (hasOptionalProperty(message, 'externalAdReply') && !!message.externalAdReply) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		const content = message.externalAdReply
		if ('thumbnail' in content && !Buffer.isBuffer(content.thumbnail)) throw new Boom('Thumbnail must in buffer type', { statusCode: 400 })
		if (content.url != null && typeof content.url !== 'string') throw new Boom('externalAdReply.url must be a string', { statusCode: 400 })
		const externalAdReply = {
			...content,
			body: content.body,
			mediaType: content.mediaType || 1,
			mediaUrl: content.url,
			renderLargerThumbnail: content.largeThumbnail,
			sourceUrl: content.url,
			thumbnail: content.thumbnail,
			thumbnailUrl: content.url ? content.url + '?update=' + Date.now() : undefined,
			title: content.title || LIBRARY_NAME
		}
		delete externalAdReply.subTitle
		delete externalAdReply.largeThumbnail
		delete externalAdReply.url
		if ('contextInfo' in key && !!key.contextInfo) key.contextInfo.externalAdReply = { ...key.contextInfo.externalAdReply, ...externalAdReply }
		else if (key) key.contextInfo = { externalAdReply }
	}
	if ((hasOptionalProperty(message, 'mentions') && message.mentions?.length) || (hasOptionalProperty(message, 'mentionAll') && message.mentionAll)) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if (key && 'contextInfo' in key) {
			key.contextInfo = key.contextInfo || {}
			if (message.mentions?.length) key.contextInfo.mentionedJid = message.mentions
			if (message.mentionAll) key.contextInfo.nonJidMentions = 1
		} else if (key) {
			key.contextInfo = { mentionedJid: message.mentions, nonJidMentions: message.mentionAll ? 1 : 0 }
		}
	}
	if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if ('contextInfo' in key && !!key.contextInfo) key.contextInfo = { ...key.contextInfo, ...message.contextInfo }
		else if (key) key.contextInfo = message.contextInfo
	}
	if (hasOptionalProperty(message, 'groupStatus') && !!message.groupStatus) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if ('contextInfo' in key && !!key.contextInfo) key.contextInfo.isGroupStatus = message.groupStatus
		else if (key) key.contextInfo = { isGroupStatus: message.groupStatus }
		m = { groupStatusMessageV2: { message: m } }
		delete message.groupStatus
	}
	if (hasOptionalProperty(message, 'spoiler') && !!message.spoiler) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if ('contextInfo' in key && !!key.contextInfo) key.contextInfo.isSpoiler = message.spoiler
		else if (key) key.contextInfo = { isSpoiler: message.spoiler }
		m = { spoilerMessage: { message: m } }
		delete message.spoiler
	} else if (hasOptionalProperty(message, 'interactiveAsTemplate') && !!message.interactiveAsTemplate) {
		if (!m.interactiveMessage) throw new Boom('Invalid message type for template', { statusCode: 400 })
		m = { templateMessage: { interactiveMessageTemplate: m.interactiveMessage, templateId: message.id || 'template-' + Date.now() } }
		delete message.interactiveAsTemplate
	}
	if (hasOptionalProperty(message, 'ephemeral') && !!message.ephemeral) {
		m = { ephemeralMessage: { message: m } }
		delete message.ephemeral
	}
	if (hasOptionalProperty(message, 'isLottie') && !!message.isLottie) {
		m = { lottieStickerMessage: { message: m } }
	} else if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
		m = { viewOnceMessage: { message: m } }
	} else if (hasOptionalProperty(message, 'viewOnceV2') && !!message.viewOnceV2) {
		m = { viewOnceMessageV2: { message: m } }
		delete message.viewOnceV2
	} else if (hasOptionalProperty(message, 'viewOnceV2Extension') && !!message.viewOnceV2Extension) {
		m = { viewOnceMessageV2Extension: { message: m } }
		delete message.viewOnceV2Extension
	}
	if (hasOptionalProperty(message, 'edit')) {
		m = { protocolMessage: { key: message.edit, editedMessage: m, timestampMs: Date.now(), type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT } }
	}
	if (shouldIncludeReportingToken(m)) {
		m.messageContextInfo = m.messageContextInfo || {}
		if (!m.messageContextInfo.messageSecret) m.messageContextInfo.messageSecret = randomBytes(32)
	}
	return WAProto.Message.create(m)
}

export const generateWAMessageFromContent = (jid, message, options) => {
	if (!options.timestamp) options.timestamp = new Date()
	const innerMessage = normalizeMessageContent(message)
	const messageContextInfo = message.messageContextInfo
	const key = getContentType(innerMessage)
	const timestamp = unixTimestampSeconds(options.timestamp)
	const isNewsletter = isJidNewsletter(jid)
	const { quoted, userJid } = options

	if (quoted) {
		const participant = quoted.key.fromMe ? userJid : quoted.participant || quoted.key.participant || quoted.key.remoteJid
		let quotedMsg = normalizeMessageContent(quoted.message)
		const msgType = getContentType(quotedMsg)
		quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] }) // strip redundant properties
		const quotedContent = quotedMsg[msgType]
		if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) delete quotedContent.contextInfo
		const contextInfo = ('contextInfo' in innerMessage[key] && innerMessage[key]?.contextInfo) || {}
		contextInfo.participant = jidNormalizedUser(participant)
		contextInfo.stanzaId = quoted.key.id
		contextInfo.quotedMessage = quotedMsg
		// if a participant is quoted, then it must be a group, so remoteJid of that group must also be set
		if (!isNewsletter && jid !== quoted.key.remoteJid) contextInfo.remoteJid = quoted.key.remoteJid
		if (contextInfo && innerMessage[key]) innerMessage[key].contextInfo = contextInfo
	}

	if (!!options?.ephemeralExpiration && key !== 'protocolMessage' && key !== 'ephemeralMessage' && !isNewsletter) {
		innerMessage[key].contextInfo = { ...(innerMessage[key].contextInfo || {}), expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL }
	}

	message = WAProto.Message.create(message)
	const messageJSON = {
		key: { remoteJid: jid, fromMe: true, id: options?.messageId || generateMessageIDV2() },
		message,
		messageTimestamp: timestamp,
		messageStubParameters: [],
		participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
		status: WAMessageStatus.PENDING
	}
	return WAProto.WebMessageInfo.fromObject(messageJSON)
}

export const generateWAMessage = async (jid, content, options) => {
	// ensure msg ID is with every log
	options.logger = options?.logger?.child({ msgId: options.messageId })
	// Pass jid in the options to generateWAMessageContent (copy: do not mutate the caller's options)
	return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options)
}

/** Get the key to access the true type of content */
export const getContentType = content => {
	if (content) {
		const keys = Object.keys(content)
		return keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
	}
}

const getFutureProofMessage = message =>
	message?.associatedChildMessage ||
	message?.botForwardedMessage ||
	message?.botInvokeMessage ||
	message?.botTaskMessage ||
	message?.documentWithCaptionMessage ||
	message?.editedMessage ||
	message?.ephemeralMessage ||
	message?.eventCoverImage ||
	message?.groupMentionedMessage ||
	message?.groupStatusMentionMessage ||
	message?.groupStatusMessage ||
	message?.groupStatusMessageV2 ||
	message?.limitSharingMessage ||
	message?.lottieStickerMessage ||
	message?.newsletterAdminProfileMessage ||
	message?.newsletterAdminProfileMessageV2 ||
	message?.newsletterAdminProfileStatusMessage ||
	message?.pollCreationMessageV4 ||
	message?.pollCreationOptionImageMessage ||
	message?.questionMessage ||
	message?.questionReplyMessage ||
	message?.spoilerMessage ||
	message?.statusAddYours ||
	message?.statusMentionMessage ||
	message?.viewOnceMessage ||
	message?.viewOnceMessageV2 ||
	message?.viewOnceMessageV2Extension

/**
 * Normalizes ephemeral, view once messages to regular message content.
 * Eg. image messages in ephemeral messages, in view once messages etc.
 */
export const normalizeMessageContent = content => {
	if (!content) return undefined
	for (let i = 0; i < 5; i++) {
		const inner = getFutureProofMessage(content)
		if (!inner) break
		content = inner.message
	}
	return content
}

/** Extract the true message content from a message. Eg. extracts the inner message from a disappearing/view-once message. */
export const extractMessageContent = content => {
	const extractFromTemplateMessage = msg => {
		if (msg.imageMessage) return { imageMessage: msg.imageMessage }
		if (msg.documentMessage) return { documentMessage: msg.documentMessage }
		if (msg.videoMessage) return { videoMessage: msg.videoMessage }
		if (msg.locationMessage) return { locationMessage: msg.locationMessage }
		return { conversation: 'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : '' }
	}
	content = normalizeMessageContent(content)
	if (content?.buttonsMessage) return extractFromTemplateMessage(content.buttonsMessage)
	if (content?.templateMessage?.hydratedFourRowTemplate) return extractFromTemplateMessage(content.templateMessage.hydratedFourRowTemplate)
	if (content?.templateMessage?.hydratedTemplate) return extractFromTemplateMessage(content.templateMessage.hydratedTemplate)
	if (content?.templateMessage?.fourRowTemplate) return extractFromTemplateMessage(content.templateMessage.fourRowTemplate)
	return content
}

/** Returns the device predicted by message ID */
export const getDevice = id =>
	/^3A.{18}$/.test(id) ? 'ios' : /^3E.{20}$/.test(id) ? 'web' : /^(.{21}|.{32})$/.test(id) ? 'android' : /^(3F|.{18}$)/.test(id) ? 'desktop' : 'unknown'

/** Upserts a receipt in the message */
export const updateMessageWithReceipt = (msg, receipt) => {
	msg.userReceipt = msg.userReceipt || []
	const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
	if (recp) Object.assign(recp, receipt)
	else msg.userReceipt.push(receipt)
}

/** Update the message with a new reaction */
export const updateMessageWithReaction = (msg, reaction) => {
	const authorID = getKeyAuthor(reaction.key)
	const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID)
	reaction.text = reaction.text || ''
	reactions.push(reaction)
	msg.reactions = reactions
}

/** Update the message with a new poll update */
export const updateMessageWithPollUpdate = (msg, update) => {
	const authorID = getKeyAuthor(update.pollUpdateMessageKey)
	const reactions = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID)
	if (update.vote?.selectedOptions?.length) reactions.push(update)
	msg.pollUpdates = reactions
}

/** Update the message with a new event response */
export const updateMessageWithEventResponse = (msg, update) => {
	const authorID = getKeyAuthor(update.eventResponseMessageKey)
	const responses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID)
	responses.push(update)
	msg.eventResponses = responses
}

/** Aggregates all poll updates in a poll. Returns a list of options & their voters. */
export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
	const opts =
		message?.pollCreationMessage?.options ||
		message?.pollCreationMessageV2?.options ||
		message?.pollCreationMessageV3?.options ||
		message?.pollCreationMessageV5?.options ||
		message?.pollCreationMessageV6?.options ||
		[]
	const voteHashMap = opts.reduce((acc, opt) => {
		const hash = sha256(Buffer.from(opt.optionName || '')).toString()
		acc[hash] = { name: opt.optionName || '', voters: [] }
		return acc
	}, {})
	for (const update of pollUpdates || []) {
		const { vote } = update
		if (!vote) continue
		for (const option of vote.selectedOptions || []) {
			const hash = option.toString()
			let data = voteHashMap[hash]
			if (!data) {
				voteHashMap[hash] = { name: 'Unknown', voters: [] }
				data = voteHashMap[hash]
			}
			voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId))
		}
	}
	return Object.values(voteHashMap)
}

/** Aggregates all event responses in an event message. Returns a list of response types & their responders. */
export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
	const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE']
	const responseMap = {}
	for (const type of responseTypes) responseMap[type] = { response: type, responders: [] }
	for (const update of eventResponses || []) {
		const responseType = update.eventResponse || 'UNKNOWN'
		if (responseType !== 'UNKNOWN' && responseMap[responseType]) responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId))
	}
	return Object.values(responseMap)
}

/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk. */
export const aggregateMessageKeysNotFromMe = keys => {
	const keyMap = {}
	for (const { remoteJid, id, participant, fromMe } of keys) {
		if (!fromMe) {
			const uqKey = `${remoteJid}:${participant || ''}`
			if (!keyMap[uqKey]) keyMap[uqKey] = { jid: remoteJid, participant, messageIds: [] }
			keyMap[uqKey].messageIds.push(id)
		}
	}
	return Object.values(keyMap)
}

const REUPLOAD_REQUIRED_STATUS = [410, 404]

/** Downloads the given message. Throws an error if it's not a media message. */
export const downloadMediaMessage = async (message, type, options, ctx) => {
	async function downloadMsg() {
		const mContent = extractMessageContent(message.message)
		if (!mContent) throw new Boom('No message present', { statusCode: 400, data: message })
		const contentType = getContentType(mContent)
		let mediaType = contentType?.replace('Message', '')
		const media = mContent[contentType]
		if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
			throw new Boom(`"${contentType}" message is not a media message`)
		}
		let download
		if ('thumbnailDirectPath' in media && !('url' in media)) {
			download = { directPath: media.thumbnailDirectPath, mediaKey: media.mediaKey }
			mediaType = 'thumbnail-link'
		} else {
			download = media
		}
		const stream = await downloadContentFromMessage(download, mediaType, options)
		if (type === 'buffer') {
			const bufferArray = []
			for await (const chunk of stream) bufferArray.push(chunk)
			return Buffer.concat(bufferArray)
		}
		return stream
	}

	return downloadMsg().catch(async error => {
		if (ctx && typeof error?.status === 'number' && REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
			ctx.logger.info({ key: message.key }, 'sending reupload media request...')
			message = await ctx.reuploadRequest(message)
			return downloadMsg()
		}
		throw error
	})
}

/** Checks whether the given message is a media message; if it is returns the inner content */
export const assertMediaContent = content => {
	content = extractMessageContent(content)
	const mediaContent = content?.documentMessage || content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.stickerMessage
	if (!mediaContent) throw new Boom('given message is not a media message', { statusCode: 400, data: content })
	return mediaContent
}

/** Checks if a WebP buffer is animated by looking for VP8X chunk with animation flag, or ANIM/ANMF chunks */
const isAnimatedWebP = buffer => {
	if (!isWebPBuffer(buffer)) return false
	let offset = 12
	while (offset < buffer.length - 8) {
		const chunkFourCC = buffer.toString('ascii', offset, offset + 4)
		const chunkSize = buffer.readUInt32LE(offset + 4)
		if (chunkFourCC === 'VP8X') {
			const flagsOffset = offset + 8
			if (flagsOffset < buffer.length && buffer[flagsOffset] & 0x02) return true
		} else if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') {
			return true
		}
		offset += 8 + chunkSize + (chunkSize % 2)
	}
	return false
}

/** Checks if a buffer is a WebP file */
const isWebPBuffer = buffer =>
	buffer.length >= 12 &&
	buffer[0] === 0x52 &&
	buffer[1] === 0x49 &&
	buffer[2] === 0x46 &&
	buffer[3] === 0x46 &&
	buffer[8] === 0x57 &&
	buffer[9] === 0x45 &&
	buffer[10] === 0x42 &&
	buffer[11] === 0x50

/**
 * Determines whether a message should include a Biz Binary Node.
 * A Biz Binary Node is added only for interactive messages such as buttons or other supported interactive types.
 */
export const shouldIncludeBizBinaryNode = message =>
	!!(message.buttonsMessage || message.listMessage || message.templateMessage || (message.interactiveMessage && message.interactiveMessage.nativeFlowMessage))

export { AssociationType }

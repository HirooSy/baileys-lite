/**
 * AIRich: a fluent builder for WhatsApp's "AI rich response" cards (the same
 * botForwardedMessage/AIRichResponseMessage shape Meta AI messages use — text,
 * code blocks, tables, image/video grids, product/post carousels, sources,
 * suggestion pills, embedded HTML tabs).
 *
 * Unlike a one-shot relayMessage bypass, an AIRich instance is just a content
 * builder: `sock.sendMessage(jid, { aiRich: builder })` (or `.send(jid, opts)`,
 * a shorthand for the same call) is the only way messages leave the socket, so
 * retries, acks, the message store and everything else `sendMessage` already
 * does keeps working exactly as it does for any other message type.
 *
 * `generateWAMessageContent` recognizes the `aiRich` key and calls `.build()`
 * on it (a plain spec object also works — see aiRichBuilderFromSpec).
 */
import { randomUUID } from 'node:crypto'

const newLayout = (name, data, extra = {}) => ({
	...extra,
	view_model: { [Array.isArray(data) ? 'primitives' : 'primitive']: data, __typename: `GenAI${name}LayoutViewModel` }
})

/**
 * Extracts `[text](url)` hyperlinks, `[](url)` bare citations and `[text|w|h](<url>)`
 * LaTeX images out of markdown-ish text, replacing each with a `{{_KEY_n}}...{{/_KEY_n}}`
 * tag and returning the matching WA inline_entities for the tag keys.
 */
const extractInlineEntities = (text, { hyperlink = true, citation = true, latex = true } = {}) => {
	const toEntity = (type, ie) => {
		if (type === 'hyperlink') {
			return { key: ie.key, metadata: { display_name: ie.text, is_trusted: ie.is_trusted, url: ie.url, __typename: 'GenAIInlineLinkItem' } }
		}
		if (type === 'citation') {
			return {
				key: ie.key,
				metadata: { reference_id: ie.reference_id, reference_url: ie.url, reference_title: ie.url, reference_display_name: ie.url, sources: [], __typename: 'GenAISearchCitationItem' }
			}
		}
		if (type === 'latex') {
			return {
				key: ie.key,
				metadata: {
					latex_expression: ie.text,
					latex_image: { url: ie.url, width: Number(ie.width) || 100, height: Number(ie.height) || 100 },
					font_height: Number(ie.font_height) || 83.333333333333,
					padding: Number(ie.padding) || 15,
					__typename: 'GenAILatexItem'
				}
			}
		}
	}

	const inline_entities = []
	let result = ''
	let last = 0
	let citationIndex = 1
	let hyperlinkIndex = 0
	let latexIndex = 0
	const stack = []

	for (let i = 0; i < text.length; i++) {
		if (text[i] === '[' && text[i - 1] !== '\\') {
			stack.push(i)
			continue
		}
		if (text[i] === ']' && (text[i + 1] === '(' || text[i + 1] === '<')) {
			const start = stack.pop()
			if (start == null) continue
			const open = text[i + 1]
			const close = open === '(' ? ')' : '>'
			const kind = open === '(' ? 'link' : 'latex'
			let end = i + 2
			let depth = 1
			while (end < text.length && depth) {
				if (text[end] === open && text[end - 1] !== '\\') depth++
				else if (text[end] === close && text[end - 1] !== '\\') depth--
				end++
			}
			if (depth) continue

			const raw = text.slice(start + 1, i).trim()
			const url = text.slice(i + 2, end - 1).trim()
			let key, tag, type, ie

			if (kind === 'latex') {
				if (!latex) continue
				const [txt = '', width = null, height = null, fontHeight = null, padding = null] = raw.split('|')
				key = `_LATEX_${latexIndex++}`
				tag = `{{${key}}}${txt || 'image'}{{/${key}}}`
				type = 'latex'
				ie = { key, text: txt, url, width, height, font_height: fontHeight, padding }
			} else if (raw) {
				if (!hyperlink) continue
				const trusted = !url.startsWith('!')
				key = `_HYPERLINK_${hyperlinkIndex++}`
				tag = `{{${key}}}${trusted ? url : url.slice(1)}{{/${key}}}`
				type = 'hyperlink'
				ie = { key, text: raw, url: trusted ? url : url.slice(1), is_trusted: trusted }
			} else {
				if (!citation) continue
				key = `_CITATION_${citationIndex - 1}`
				tag = `{{${key}}}${url}{{/${key}}}`
				type = 'citation'
				ie = { reference_id: citationIndex++, key, text: '', url }
			}

			result += text.slice(last, start) + tag
			last = end
			const entity = toEntity(type, ie)
			if (entity) inline_entities.push(entity)
			i = end - 1
		}
	}
	result += text.slice(last)
	return { text: result, inline_entities }
}

const toTableMetadata = (rows, { hyperlink = true, citation = true, latex = true } = {}) => {
	if (!Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) {
		throw new TypeError('Table must be a nested array of strings')
	}
	const [header, ...body] = rows
	const maxLen = Math.max(header.length, ...body.map(r => r.length))
	const normalize = r => [...r, ...Array(maxLen - r.length).fill('')]

	const unifiedRows = [{ is_header: true, cells: normalize(header) }, ...body.map(r => ({ is_header: false, cells: normalize(r) }))].map(row => {
		const markdownCells = row.cells.map(cell => {
			const extracted = extractInlineEntities(cell, { hyperlink, citation, latex })
			return { text: extracted.text, ...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {}) }
		})
		return { ...row, ...(markdownCells.some(c => c.inline_entities?.length) ? { markdown_cells: markdownCells } : {}) }
	})

	return {
		title: '',
		rows: unifiedRows.map(r => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) })),
		unifiedRows
	}
}

/** Best-effort code tokenizer for a handful of common languages; falls back to one DEFAULT block. */
const KEYWORD_SETS = {
	javascript: new Set(['break','case','catch','continue','debugger','delete','do','else','finally','for','function','if','in','instanceof','new','return','switch','this','throw','typeof','var','void','while','with','true','false','null','undefined','class','const','let','super','extends','export','import','yield','static','async','await','get','set']),
	typescript: new Set(['abstract','any','as','asserts','bigint','boolean','declare','enum','implements','infer','interface','is','keyof','module','namespace','never','readonly','require','number','object','override','private','protected','public','satisfies','string','symbol','type','unknown','using','from','break','case','catch','continue','do','else','finally','for','function','if','new','return','switch','this','throw','try','var','void','while','class','const','let','extends','import','export','async','await']),
	python: new Set(['False','None','True','and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield']),
	java: new Set(['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while']),
	go: new Set(['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var']),
	golang: new Set(['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var']),
	c: new Set(['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','int','long','register','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while']),
	cpp: new Set(['alignas','alignof','and','auto','bool','break','case','catch','class','const','constexpr','continue','delete','do','double','else','enum','explicit','export','extern','false','float','for','friend','if','inline','int','long','mutable','namespace','new','noexcept','nullptr','operator','private','protected','public','return','short','signed','sizeof','static','struct','switch','template','this','throw','true','try','typedef','typename','union','unsigned','using','virtual','void','while']),
	php: new Set(['abstract','and','array','as','break','callable','case','catch','class','clone','const','continue','declare','default','do','echo','else','elseif','empty','enddeclare','endfor','endforeach','endif','endswitch','endwhile','extends','final','finally','fn','for','foreach','function','global','goto','if','implements','include','include_once','instanceof','interface','match','namespace','new','null','or','private','protected','public','require','require_once','return','static','switch','throw','trait','try','use','var','while','yield']),
	rust: new Set(['as','break','const','continue','crate','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','Self','static','struct','super','trait','true','type','unsafe','use','where','while']),
	html: new Set(['html','head','body','div','span','p','a','img','video','audio','script','style','link','meta','form','input','button','table','tr','td','th','ul','ol','li','section','article','header','footer','nav','main']),
	bash: new Set(['if','then','else','elif','fi','for','while','do','done','case','esac','function','in','select','until','break','continue','return','export','readonly','local','declare'])
}
const HL = { DEFAULT: 0, KEYWORD: 1, METHOD: 2, STRING: 3, NUMBER: 4, COMMENT: 5 }
const HL_NAME = ['DEFAULT', 'KEYWORD', 'METHOD', 'STR', 'NUMBER', 'COMMENT']

export const tokenizeAIRichCode = (code, lang = 'javascript') => {
	const key = (lang || '').toLowerCase()
	if (!key || key === 'txt' || key === 'text' || key === 'plaintext') return [{ codeContent: code, highlightType: HL.DEFAULT }]

	const keywords = KEYWORD_SETS[key] || new Set()
	const tokens = []
	const isIdentifier = c => (key === 'css' ? /[a-zA-Z0-9_$-]/.test(c) : key === 'html' ? /[a-zA-Z0-9_$:-]/.test(c) : /[a-zA-Z0-9_$]/.test(c))
	const push = (content, type) => {
		if (!content) return
		const last = tokens[tokens.length - 1]
		if (last && last.highlightType === type) last.codeContent += content
		else tokens.push({ codeContent: content, highlightType: type })
	}

	let i = 0
	while (i < code.length) {
		const c = code[i]
		if (/\s/.test(c)) {
			const s = i
			while (i < code.length && /\s/.test(code[i])) i++
			push(code.slice(s, i), HL.DEFAULT)
			continue
		}
		if ((c === '/' && code[i + 1] === '/') || (c === '#' && (key === 'python' || key === 'bash'))) {
			const s = i
			while (i < code.length && code[i] !== '\n') i++
			push(code.slice(s, i), HL.COMMENT)
			continue
		}
		if (c === '"' || c === "'" || c === '`') {
			const s = i
			const q = c
			i++
			while (i < code.length) {
				if (code[i] === '\\' && i + 1 < code.length) i += 2
				else if (code[i] === q) {
					i++
					break
				} else i++
			}
			push(code.slice(s, i), HL.STRING)
			continue
		}
		if (/[0-9]/.test(c)) {
			const s = i
			while (i < code.length && /[0-9._]/.test(code[i])) i++
			push(code.slice(s, i), HL.NUMBER)
			continue
		}
		if (/[a-zA-Z_$]/.test(c)) {
			const s = i
			while (i < code.length && isIdentifier(code[i])) i++
			const word = code.slice(s, i)
			let type = HL.DEFAULT
			if (keywords.has(word)) type = HL.KEYWORD
			else {
				let j = i
				while (j < code.length && /\s/.test(code[j])) j++
				if (code[j] === '(') type = HL.METHOD
			}
			push(word, type)
			continue
		}
		push(c, HL.DEFAULT)
		i++
	}
	return tokens
}

const mediaUrl = value => {
	if (Buffer.isBuffer(value)) return `data:application/octet-stream;base64,${value.toString('base64')}`
	if (value && typeof value === 'object' && typeof value.url === 'string') return value.url
	return typeof value === 'string' ? value : undefined
}

export class AIRichBuilder {
	/** @param {{ sendMessage(jid: string, content: object, options?: object): Promise<any> }} [client] socket to send through; only needed for .send() */
	constructor(client) {
		this._client = client
		this._title = ''
		this._footer = ''
		this._contextInfo = {}
		this._submessages = []
		this._sections = []
		this._richResponseSources = []
		this._embeddedScreens = []
	}

	setTitle(title) {
		if (typeof title !== 'string') throw new TypeError('Title must be a string')
		this._title = title
		return this
	}

	setFooter(footer) {
		if (typeof footer !== 'string') throw new TypeError('Footer must be a string')
		this._footer = footer
		return this
	}

	setContextInfo(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new TypeError('ContextInfo must be a plain object')
		this._contextInfo = obj
		return this
	}

	addText(text, { hyperlink = true, citation = true, latex = true } = {}) {
		if (typeof text !== 'string') throw new TypeError('Text must be a string')
		const { text: extractedText, inline_entities } = extractInlineEntities(text, { hyperlink, citation, latex })
		this._submessages.push({ messageType: 2, messageText: extractedText, inlineEntities: inline_entities })
		this._sections.push(newLayout('Single', { text: extractedText, ...(inline_entities.length ? { inline_entities } : {}), __typename: 'GenAIMarkdownTextUXPrimitive' }))
		return this
	}

	addCode(language, code) {
		if (typeof language !== 'string' || typeof code !== 'string') throw new TypeError('Language and code must be a string')
		const codeBlocks = tokenizeAIRichCode(code, language)
		this._submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } })
		this._sections.push(
			newLayout('Single', {
				language,
				code_blocks: codeBlocks.map(b => ({ content: b.codeContent, type: HL_NAME[b.highlightType] })),
				__typename: 'GenAICodeUXPrimitive'
			})
		)
		return this
	}

	addTable(table, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(table)) throw new TypeError('Table must be an array')
		const meta = toTableMetadata(table, { hyperlink, citation, latex })
		this._submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } })
		this._sections.push(newLayout('Single', { rows: meta.unifiedRows, __typename: 'GenATableUXPrimitive' }))
		return this
	}

	addImage(image) {
		if (!(typeof image === 'string' || Buffer.isBuffer(image) || (Array.isArray(image) && image.every(v => typeof v === 'string' || Buffer.isBuffer(v))))) {
			throw new TypeError('image must be a string | buffer | array of string/buffer')
		}
		const list = (Array.isArray(image) ? image : [image]).map(mediaUrl).filter(Boolean)
		this._submessages.push({ messageType: 1, gridImageMetadata: { gridImageUrl: { imagePreviewUrl: list[0] }, imageUrls: list.map(u => ({ imagePreviewUrl: u, imageHighResUrl: u, sourceUrl: u })) } })
		for (const url of list) this._sections.push(newLayout('Single', { media: { url, mime_type: 'image/png' }, imagine_type: 'IMAGE', status: { status: 'READY' }, __typename: 'GenAIImaginePrimitive' }))
		return this
	}

	addVideo(video) {
		const items = Array.isArray(video) ? video : [video]
		this._submessages.push({ messageType: 2, messageText: '[ VIDEO ]' })
		for (const item of items) {
			const isObj = item && typeof item === 'object' && !Buffer.isBuffer(item)
			const url = mediaUrl(isObj ? item.url : item)
			this._sections.push(
				newLayout('Single', {
					media: { url, mime_type: (isObj && item.mimeType) || 'video/mp4', file_length: (isObj && item.fileLength) || 0, duration: (isObj && item.duration) || 0 },
					imagine_type: 'ANIMATE',
					status: { status: 'READY' },
					thumbnail: { raw_media: isObj ? item.thumbnail : undefined },
					__typename: 'GenAIImaginePrimitive'
				})
			)
		}
		return this
	}

	addSource(sources = []) {
		const isFlat = Array.isArray(sources) && sources.every(item => typeof item === 'string')
		const list = isFlat ? [sources] : sources
		if (!(Array.isArray(list) && list.every(item => Array.isArray(item) && item.every(v => typeof v === 'string')))) {
			throw new TypeError('Sources must be a string array or an array of string arrays')
		}
		const mapped = list.map(([icon, url, text]) => ({
			source_type: 'THIRD_PARTY',
			source_display_name: text ?? '',
			source_subtitle: 'AI',
			source_url: url ?? '',
			favicon: { url: icon ?? '', mime_type: 'image/jpeg', width: 16, height: 16 }
		}))
		this._sections.push(newLayout('Single', { sources: mapped, __typename: 'GenAISearchResultPrimitive' }))
		return this
	}

	addProduct(data = {}) {
		const items = Array.isArray(data) ? data : [data]
		this._submessages.push({ messageType: 2, messageText: '[ PRODUCT ]' })
		const products = items.map(item => ({
			title: item.title,
			brand: item.brand,
			price: item.price,
			sale_price: item.sale_price,
			product_url: item.product_url ?? item.url,
			image: { url: mediaUrl(item.image_url ?? item.image) },
			additional_images: [{ url: mediaUrl(item.icon_url ?? item.icon) }],
			__typename: 'GenAIProductItemCardPrimitive'
		}))
		this._sections.push(newLayout(Array.isArray(data) ? 'HScroll' : 'Single', Array.isArray(data) ? products : products[0]))
		return this
	}

	addPost(data = {}) {
		const posts = Array.isArray(data) ? data : [data]
		this._submessages.push({ messageType: 2, messageText: '[ POST ]' })
		const primitives = posts.map(p => ({
			title: p.title ?? '',
			subtitle: p.subtitle ?? '',
			username: p.username ?? '',
			profile_picture_url: mediaUrl(p.profile_picture_url ?? p.profile_url ?? p.profile),
			is_verified: !!(p.is_verified || p.verified),
			thumbnail_url: mediaUrl(p.thumbnail_url ?? p.thumbnail),
			post_caption: p.post_caption ?? p.caption ?? '',
			likes_count: p.likes_count ?? p.like ?? 0,
			comments_count: p.comments_count ?? p.comment ?? 0,
			shares_count: p.shares_count ?? p.share ?? 0,
			post_url: p.post_url ?? p.url ?? '',
			post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
			source_app: p.source_app || p.source || 'INSTAGRAM',
			footer_label: p.footer_label ?? p.footer ?? '',
			footer_icon: mediaUrl(p.footer_icon ?? p.icon),
			is_carousel: posts.length > 1,
			orientation: p.orientation ?? 'LANDSCAPE',
			post_type: p.post_type ?? 'VIDEO',
			__typename: 'GenAIPostPrimitive'
		}))
		this._sections.push(newLayout('HScroll', primitives))
		return this
	}

	addReels(data = []) {
		const items = Array.isArray(data) ? data : [data]
		const reels = items.map(item => ({ ...item, _avatar: mediaUrl(item.profileIconUrl ?? item.profile_url ?? item.profile), _thumbnail: mediaUrl(item.thumbnailUrl ?? item.thumbnail) }))
		this._submessages.push({
			messageType: 9,
			contentItemsMetadata: { contentType: 1, itemsMetadata: reels.map(item => ({ reelItem: { title: item.username ?? '', profileIconUrl: item._avatar, thumbnailUrl: item._thumbnail, videoUrl: item.videoUrl ?? item.url ?? '' } })) }
		})
		reels.forEach((item, idx) =>
			this._richResponseSources.push({ provider: '', thumbnailCDNURL: item._thumbnail, sourceProviderURL: item.videoUrl ?? item.url ?? '', sourceQuery: '', faviconCDNURL: item._avatar, citationNumber: idx + 1, sourceTitle: item.username ?? '' })
		)
		this._sections.push(
			newLayout(
				'HScroll',
				reels.map(item => ({
					reels_url: item.videoUrl ?? item.url ?? '',
					thumbnail_url: item._thumbnail,
					creator: item.username ?? item.title ?? '',
					avatar_url: item._avatar,
					reels_title: item.reels_title ?? item.title ?? '',
					likes_count: item.likes_count ?? item.like ?? 0,
					shares_count: item.shares_count ?? item.share ?? 0,
					view_count: item.view_count ?? item.view ?? 0,
					reel_source: item.reel_source ?? item.source ?? 'IG',
					is_verified: !!(item.is_verified || item.verified),
					__typename: 'GenAIReelPrimitive'
				}))
			)
		)
		return this
	}

	addTip(text) {
		this._submessages.push({ messageType: 2, messageText: text })
		this._sections.push(newLayout('Single', { text, __typename: 'GenAIMetadataTextPrimitive' }))
		return this
	}

	addSuggest(suggestion, { scroll = true, layout } = {}) {
		if (!(typeof suggestion === 'string' || (Array.isArray(suggestion) && suggestion.every(v => typeof v === 'string')))) {
			throw new TypeError('Suggestion must be a string or array of strings')
		}
		const items = (Array.isArray(suggestion) ? suggestion : [suggestion]).map(text => ({ prompt_text: text, prompt_type: 'SUGGESTED_PROMPT', __typename: 'GenAIFollowUpSuggestionPillPrimitive' }))
		const type = layout ?? (items.length === 1 ? 'Single' : scroll ? 'HScroll' : 'ActionRow')
		this._sections.push(newLayout(type, type === 'Single' ? items[0] : items, { __typename: 'GenAIUnifiedResponseSection' }))
		return this
	}

	addProcess(title) {
		if (typeof title !== 'string') throw new TypeError('Process title must be a string')
		this._submessages.push({ messageType: 2, messageText: title })
		this._sections.push(newLayout('Single', { icon: null, is_in_progress: true, meta_search_apps: null, target_secondary_screen_id: null, target_secondary_screen_tab_id: null, title, __typename: 'GenAIBotProgressStatusPrimitive' }))
		return this
	}

	/**
	 * addHtml(html) for a single inline HTML tab, or addHtml([html, title], [html2, title2], ..., { url, trustedSources })
	 * for multiple tabs opened in an embedded-screen sheet.
	 */
	addHtml(...args) {
		let options = {}
		if (args.length && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1])) options = args.pop()
		const url = options.url ?? ''
		const trustedSources = options.trustedSources ?? []

		if (args.length === 1 && typeof args[0] === 'string') {
			this._submessages.push({ messageType: 2, messageText: '[ HTML ]' })
			this._sections.push(newLayout('Single', { payload: args[0], url, trusted_sources: trustedSources, __typename: 'GenAIaeacdsnwHtmlPrimitive' }))
			return this
		}
		if (!args.every(item => Array.isArray(item) && typeof item[0] === 'string')) {
			throw new TypeError('addHtml() expects a single HTML string, or one or more [html, title] pairs, with an optional trailing options object')
		}
		if (!this._embeddedScreens.length) this._embeddedScreens.push({ title: 'Preview', content: [{ __typename: 'FOAIDNixelButtonSheets', tabs: [] }] })
		const tabs = this._embeddedScreens[0].content[0].tabs
		this._submessages.push({ messageType: 2, messageText: '[ HTML ]' })
		for (const [payload, title] of args) {
			tabs.push({
				id: `tab_${tabs.length}`,
				tab_header: title ?? `Tab ${tabs.length + 1}`,
				sections: [newLayout('Single', { payload, url, trusted_sources: trustedSources, __typename: 'GenAIaeacdsnwHtmlPrimitive' }, { __typename: 'GenAIUnifiedResponseSection' })],
				step_entries: []
			})
		}
		return this
	}

	/** Assembles the botForwardedMessage-shaped WAMessageContent object (same shape prepareRichResponseMessage returns). */
	build({ forwarded = true, quoted, quotedParticipant, botJid = '0@bot' } = {}) {
		const forward = forwarded ? { forwardingScore: 1, isForwarded: true, forwardedAiBotMessageInfo: { botJid }, forwardOrigin: 4 } : {}
		const qObj = quoted
			? { stanzaId: quoted?.key?.id || quoted?.id, participant: quotedParticipant || quoted?.key?.participant || quoted?.key?.remoteJid, quotedType: 0, quotedMessage: quoted?.message ?? quoted }
			: {}

		const sections = this._footer ? [...this._sections, newLayout('Single', { text: this._footer, __typename: 'GenAIMetadataTextPrimitive' })] : this._sections
		const responseData = { response_id: randomUUID(), sections }
		if (this._embeddedScreens.length) responseData.embedded_screens = this._embeddedScreens

		const hasRenderableContent = sections.length > 0 || this._embeddedScreens.length > 0
		const richResponseMessage = { messageType: 1, submessages: this._submessages, contextInfo: { ...forward, ...qObj, ...this._contextInfo } }
		if (hasRenderableContent) richResponseMessage.unifiedResponse = { data: Buffer.from(JSON.stringify(responseData)).toString('base64') }

		return {
			messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2, botMetadata: { messageDisclaimerText: this._title, richResponseSourcesMetadata: { sources: this._richResponseSources } } },
			botForwardedMessage: { message: { richResponseMessage } }
		}
	}

	/**
	 * Shorthand for `client.sendMessage(jid, { aiRich: this, ...buildOptions }, sendOptions)` — still goes
	 * through the socket's normal sendMessage pipeline (retry/ack/message-store), never relayMessage directly.
	 */
	async send(jid, { forwarded, quoted, quotedParticipant, botJid, ...sendOptions } = {}) {
		if (!this._client) throw new Error('AIRichBuilder.send() needs a client — use sock.aiRich() or new AIRichBuilder(sock)')
		return this._client.sendMessage(jid, { aiRich: this, forwarded, quoted, quotedParticipant, botJid }, sendOptions)
	}
}

/** Builds an AIRichBuilder from a plain spec object: { title, footer, text, code:{language,code}, table, image, video, source, product, post, reels, tip, suggest, process, html }. */
export const aiRichBuilderFromSpec = spec => {
	const b = new AIRichBuilder()
	if (spec.title) b.setTitle(spec.title)
	if (spec.footer) b.setFooter(spec.footer)
	if (spec.contextInfo) b.setContextInfo(spec.contextInfo)
	if (spec.text) b.addText(spec.text, spec.textOptions)
	if (spec.code) b.addCode(spec.code.language, spec.code.code)
	if (spec.table) b.addTable(spec.table, spec.tableOptions)
	if (spec.image) b.addImage(spec.image)
	if (spec.video) b.addVideo(spec.video)
	if (spec.source) b.addSource(spec.source)
	if (spec.product) b.addProduct(spec.product)
	if (spec.post) b.addPost(spec.post)
	if (spec.reels) b.addReels(spec.reels)
	if (spec.tip) b.addTip(spec.tip)
	if (spec.suggest) b.addSuggest(spec.suggest, spec.suggestOptions)
	if (spec.process) b.addProcess(spec.process)
	if (spec.html) b.addHtml(...(Array.isArray(spec.html[0]) ? spec.html : [spec.html]))
	return b
}

/**
 * Native link preview (replaces `link-preview-js`). `fetch` + a small, tolerant HTML head scanner.
 *
 * Result shape follows link-preview-js:
 *   HTML page : { url, title, siteName, description, mediaType, contentType, images[], videos[], favicons[] }
 *   image     : { url, mediaType: 'image', contentType, favicons[] }
 *   audio/video/application: { url, mediaType, contentType, favicons[] }
 * Throws Error('... did not receive a valid a url or text') when the text contains no http(s) URL (same message the
 * package used; getUrlInfo relies on it).
 *
 * The HTML scanner reads <meta>, <title>, <link>, <base> and <img> with a state machine that follows the WHATWG HTML
 * tokenizer (quoting, `=` and `/` corner cases, first duplicate attribute wins, unterminated tags dropped, comments,
 * script/style/textarea/title/noscript content treated as text). Named entities: ~100 common ones plus all numeric ones
 * (parse5 knows 2231 named entities; an unknown one is left as written). Verified against cheerio/parse5 in
 * test/native-link-preview.mjs.
 */

const REGEX_VALID_URL = /^(?:https?:\/\/)[^\s]+$/i
const DEFAULT_UA = 'Mozilla/5.0 (compatible; baileys-lite link preview)'
const MAX_BYTES = 1024 * 1024

/* ------------------------------ entities ------------------------------ */

const NAMED = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
	lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢',
	sect: '§', deg: '°', plusmn: '±', times: '×', divide: '÷', para: '¶', iexcl: '¡', iquest: '¿', shy: '\u00ad', larr: '←', rarr: '→', uarr: '↑',
	darr: '↓', hearts: '♥', check: '✓', star: '☆', infin: '∞', ne: '≠', le: '≤', ge: '≥', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
	micro: 'µ', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê',
	euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
	ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
	Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
	Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý'
}

// Legacy entities the HTML spec also decodes WITHOUT a trailing semicolon (text context only; see decodeEntities)
const LEGACY = /^(amp|lt|gt|quot|nbsp|copy|reg|deg|plusmn|times|divide|para|sect|shy|micro|middot|laquo|raquo|iexcl|iquest|cent|pound|yen)$/

/**
 * Named entities follow the HTML rules: `&name;` decodes when known; otherwise the LONGEST legacy prefix that is valid
 * without a semicolon decodes (`&amp8` -> `&8`). Inside an attribute value a semicolon-less match is NOT decoded when the
 * next character is `=` or alphanumeric (so `?a=1&copy=2` in a URL survives).
 */
const decodeEntities = (s, inAttr = false) => {
	if (!s.includes('&')) return s
	return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g, (m, dec, hex, name, semi, offset) => {
		if (name) {
			if (semi && Object.prototype.hasOwnProperty.call(NAMED, name)) return NAMED[name]
			for (let len = name.length; len >= 2; len--) {
				const prefix = name.slice(0, len)
				if (!LEGACY.test(prefix)) continue
				const rest = name.slice(len) + semi
				const next = rest[0] ?? s[offset + m.length]
				if (inAttr && next !== undefined && /[=A-Za-z0-9]/.test(next)) return m
				return NAMED[prefix] + rest
			}
			return m
		}
		const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16)
		if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd'
		return String.fromCodePoint(cp)
	})
}

/* ------------------------------ HTML scanning ------------------------------ */

// Elements whose content is not markup (tokenizer states RCDATA / RAWTEXT / script data). `title` is captured, the rest skipped.
const TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])
const WS = new Set([' ', '\t', '\n', '\f', '\r'])
const isAlpha = c => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))

/**
 * Follows the WHATWG HTML tokenizer for start tags: attribute names/values, quoting, `=` and `/` corner cases,
 * duplicate attributes (first wins), unterminated tags (dropped), comments, bogus comments (`<!...>`, `<?...>`, CDATA in
 * HTML content) and text-only elements. Returns { metas, links, imgs, title, base } — attribute maps with lower-case
 * names and entity-decoded values.
 */
export function scanHtml(html) {
	const out = { metas: [], links: [], imgs: [], title: undefined, base: undefined }
	const n = html.length
	let i = 0
	while (i < n) {
		const lt = html.indexOf('<', i)
		if (lt === -1) break
		i = lt + 1
		const c = html[i]
		if (c === '!') {
			// comment, doctype or bogus comment
			if (html.startsWith('--', i + 1)) {
				if (html[i + 3] === '>') i += 4 // <!-->
				else if (html.startsWith('->', i + 3)) i += 5 // <!--->
				else {
					const end = html.indexOf('-->', i + 3)
					const alt = html.indexOf('--!>', i + 3)
					const e = end === -1 ? alt : alt === -1 ? end : Math.min(end, alt)
					if (e === -1) break // unterminated comment swallows the rest
					i = e + (html.startsWith('--!>', e) ? 4 : 3)
				}
			} else {
				const gt = html.indexOf('>', i)
				if (gt === -1) break
				i = gt + 1
			}
			continue
		}
		if (c === '?') {
			const gt = html.indexOf('>', i)
			if (gt === -1) break
			i = gt + 1
			continue
		}
		if (c === '/') {
			// end tag: skipped (attributes are irrelevant); "</>" and "</ x>" follow the spec's bogus-comment rules
			const d = html[i + 1]
			if (d === '>') {
				i += 2
				continue
			}
			const gt = html.indexOf('>', i)
			if (gt === -1) break
			i = gt + 1
			continue
		}
		if (!isAlpha(c)) continue // a literal '<' in text
		// ---- start tag ----
		let j = i
		while (j < n && !WS.has(html[j]) && html[j] !== '/' && html[j] !== '>') j++
		let name = html.slice(i, j).toLowerCase()
		if (name === 'image') name = 'img' // the tree builder renames <image> to <img>
		const attrs = {}
		let closed = false
		// attribute loop (before attribute name state)
		for (;;) {
			while (j < n && (WS.has(html[j]) || html[j] === '/')) j++ // '/' not followed by '>' is ignored
			if (j >= n) break // EOF inside the tag: the tag is dropped
			if (html[j] === '>') {
				j++
				closed = true
				break
			}
			// attribute name: a leading '=' becomes part of the name
			let k = j + 1
			while (k < n && !WS.has(html[k]) && html[k] !== '/' && html[k] !== '>' && html[k] !== '=') k++
			const aname = html.slice(j, k).toLowerCase().replace(/\0/g, '\ufffd')
			j = k
			while (j < n && WS.has(html[j])) j++
			let value = ''
			if (html[j] === '=') {
				j++
				while (j < n && WS.has(html[j])) j++
				const q = html[j]
				if (q === '"' || q === "'") {
					const e = html.indexOf(q, j + 1)
					if (e === -1) {
						j = n // EOF inside a quoted value: the tag is dropped
						break
					}
					value = html.slice(j + 1, e)
					j = e + 1
				} else {
					let e = j
					while (e < n && !WS.has(html[e]) && html[e] !== '>') e++
					value = html.slice(j, e)
					j = e
				}
				value = decodeEntities(value, true)
			}
			if (!(aname in attrs)) attrs[aname] = value // duplicate attributes: the first one wins
		}
		if (!closed) break
		i = j
		if (name === 'meta') out.metas.push(attrs)
		else if (name === 'link') out.links.push(attrs)
		else if (name === 'img') out.imgs.push(attrs)
		else if (name === 'base') {
			if (out.base === undefined && attrs.href) out.base = attrs.href
		}
		if (TEXT_ELEMENTS.has(name)) {
			// content up to the matching end tag is text, not markup
			const re = new RegExp('</' + name + '(?=[\\s/>])', 'i')
			const m = re.exec(html.slice(i))
			const end = m ? i + m.index : n
			if (name === 'title' && out.title === undefined) out.title = decodeEntities(html.slice(i, end))
			i = end
		}
	}
	return out
}

const resolveUrl = (href, base) => {
	try {
		return new URL(href.trim(), base).href
	} catch {
		return undefined
	}
}

/* ------------------------------ fetching ------------------------------ */

const charsetFrom = (contentType, head) => {
	const h = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '')
	if (h) return h[1]
	const m = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(head)
	return m ? m[1] : 'utf-8'
}

const decodeBody = (bytes, contentType) => {
	const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1')
	const charset = charsetFrom(contentType, head)
	try {
		return new TextDecoder(charset).decode(bytes)
	} catch {
		return new TextDecoder('utf-8').decode(bytes)
	}
}

/** Reads at most `max` bytes; stops early once `</head>` has been seen (everything we need is there). */
const readBody = async (res, max) => {
	const reader = res.body?.getReader()
	if (!reader) return new Uint8Array(await res.arrayBuffer()).subarray(0, max)
	const chunks = []
	let total = 0
	let tail = ''
	while (total < max) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		total += value.length
		tail = (tail + Buffer.from(value).toString('latin1')).slice(-16)
		if (/<\/head\s*>/i.test(tail)) break
	}
	reader.cancel().catch(() => {})
	const buf = new Uint8Array(Math.min(total, max))
	let o = 0
	for (const c of chunks) {
		const take = Math.min(c.length, buf.length - o)
		buf.set(c.subarray(0, take), o)
		o += take
	}
	return buf
}

/**
 * @param {string} text  a URL, or text containing one
 * @param {{ timeout?: number, headers?: Record<string,string>, followRedirects?: 'follow'|'manual'|'error',
 *           handleRedirects?: (baseUrl: string, forwardedUrl: string) => boolean, maxBytes?: number }} [options]
 */
export async function getLinkPreview(text, options = {}) {
	if (typeof text !== 'string') throw new Error('link-preview did not receive a valid a url or text')
	const detected = text.replace(/\n/g, ' ').split(' ').find(token => REGEX_VALID_URL.test(token))
	if (!detected) throw new Error('link-preview did not receive a valid a url or text')
	const { timeout = 3000, followRedirects = 'follow', handleRedirects, maxBytes = MAX_BYTES } = options
	const headers = { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(options.headers || {}) }

	let url = detected
	let res
	for (let hops = 0; ; hops++) {
		res = await fetch(url, { headers, redirect: followRedirects === 'manual' ? 'manual' : followRedirects, signal: AbortSignal.timeout(timeout) })
		if (followRedirects === 'manual' && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			const forwarded = new URL(res.headers.get('location'), url).href
			res.body?.cancel().catch(() => {})
			if (hops >= 10 || !handleRedirects || !handleRedirects(url, forwarded)) throw new Error('link-preview could not handle redirect')
			url = forwarded
			continue
		}
		break
	}
	const finalUrl = res.url || url
	const contentType = (res.headers.get('content-type') || '').toLowerCase()
	const type = contentType.split(';')[0].trim()
	const origin = (() => {
		try {
			return new URL(finalUrl).origin
		} catch {
			return ''
		}
	})()
	const defaultFavicons = origin ? [origin + '/favicon.ico'] : []

	if (type.startsWith('image/')) {
		res.body?.cancel().catch(() => {})
		return { url: finalUrl, mediaType: 'image', contentType: type, favicons: defaultFavicons }
	}
	if (type.startsWith('audio/') || type.startsWith('video/') || type.startsWith('application/') && !type.includes('html') && !type.includes('xml')) {
		res.body?.cancel().catch(() => {})
		return { url: finalUrl, mediaType: type.split('/')[0], contentType: type, favicons: defaultFavicons }
	}
	if (type && !type.includes('html') && !type.includes('xml') && !type.startsWith('text/')) throw new Error(`link-preview: unsupported content type ${type}`)

	const html = decodeBody(await readBody(res, maxBytes), contentType)
	const doc = scanHtml(html)
	const base = doc.base ? (resolveUrl(doc.base, finalUrl) ?? finalUrl) : finalUrl
	const meta = (...keys) => {
		for (const k of keys) {
			const hit = doc.metas.find(a => (a.property ?? a.name ?? '').toLowerCase() === k && a.content !== undefined && a.content.trim() !== '')
			if (hit) return hit.content.trim()
		}
	}
	const metaAll = (...keys) => doc.metas.filter(a => keys.includes((a.property ?? a.name ?? '').toLowerCase()) && a.content?.trim()).map(a => a.content.trim())
	const title = meta('og:title', 'twitter:title') ?? doc.title?.trim() ?? undefined
	const description = meta('og:description', 'twitter:description', 'description')
	const siteName = meta('og:site_name')
	const mediaType = meta('og:type') ?? 'website'

	const images = []
	const pushUrl = (list, href) => {
		if (!href || /^data:/i.test(href.trim())) return
		const u = resolveUrl(href, base)
		if (u && !list.includes(u)) list.push(u)
	}
	for (const v of metaAll('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src')) pushUrl(images, v)
	if (!images.length) for (const img of doc.imgs.slice(0, 20)) pushUrl(images, img.src)
	const videos = []
	for (const v of metaAll('og:video', 'og:video:url', 'og:video:secure_url')) pushUrl(videos, v)
	const favicons = []
	for (const l of doc.links) if (/(^|\s)(shortcut\s+)?icon(\s|$)|apple-touch-icon/i.test(l.rel ?? '') && l.href) pushUrl(favicons, l.href)
	if (!favicons.length) favicons.push(...defaultFavicons)

	return { url: finalUrl, title, siteName, description, mediaType, contentType: type || 'text/html', images, videos, favicons }
}

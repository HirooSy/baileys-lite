import { promisify } from 'node:util'
import { inflate } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { Boom } from '../foundation/boom.js'
import * as constants from './wa-binary-constants.js'

/* ------------------------------------------------------------------ */
/* JID utilities                                                       */
/* ------------------------------------------------------------------ */

export const S_WHATSAPP_NET = '@s.whatsapp.net'
export const OFFICIAL_BIZ_JID = '16505361212@c.us'
export const SERVER_JID = 'server@c.us'
export const PSA_WID = '0@c.us'
export const STORIES_JID = 'status@broadcast'
export const META_AI_JID = '13135550002@c.us'

export const WAJIDDomains = {
	WHATSAPP: 0,
	LID: 1,
	HOSTED: 128,
	HOSTED_LID: 129
}

export const getServerFromDomainType = (initialServer, domainType) => {
	switch (domainType) {
		case WAJIDDomains.LID:
			return 'lid'
		case WAJIDDomains.HOSTED:
			return 'hosted'
		case WAJIDDomains.HOSTED_LID:
			return 'hosted.lid'
		case WAJIDDomains.WHATSAPP:
		default:
			return initialServer
	}
}

export const jidEncode = (user, server, device, agent) =>
	`${user || ''}${agent ? `_${agent}` : ''}${device ? `:${device}` : ''}@${server || 'lid'}`

export const jidDecode = jid => {
	const sepIdx = typeof jid === 'string' ? jid.indexOf('@') : -1
	if (sepIdx < 0) return undefined

	const server = jid.slice(sepIdx + 1)
	const userCombined = jid.slice(0, sepIdx)
	const [userAgent, device] = userCombined.split(':')
	const [user, agent] = userAgent.split('_')

	let domainType = WAJIDDomains.WHATSAPP
	if (server === 'lid') domainType = WAJIDDomains.LID
	else if (server === 'hosted') domainType = WAJIDDomains.HOSTED
	else if (server === 'hosted.lid') domainType = WAJIDDomains.HOSTED_LID
	else if (agent) domainType = parseInt(agent)

	return { server, user, domainType, device: device ? +device : undefined }
}

export const areJidsSameUser = (jid1, jid2) => jidDecode(jid1)?.user === jidDecode(jid2)?.user
export const isJidMetaAI = jid => jid?.endsWith('@bot')
export const isPnUser = jid => jid?.endsWith('@s.whatsapp.net')
export const isLidUser = jid => jid?.endsWith('@lid')
export const isJidBroadcast = jid => jid?.endsWith('@broadcast')
export const isJidGroup = jid => jid?.endsWith('@g.us')
export const isJidStatusBroadcast = jid => jid === 'status@broadcast'
export const isJidNewsletter = jid => jid?.endsWith('@newsletter')
export const isHostedPnUser = jid => jid?.endsWith('@hosted')
export const isHostedLidUser = jid => jid?.endsWith('@hosted.lid')

const BOT_JID_RE = /^1313555\d{4}$|^131655500\d{2}$/
export const isJidBot = jid => jid && BOT_JID_RE.test(jid.split('@')[0]) && jid.endsWith('@c.us')

export const jidNormalizedUser = jid => {
	const result = jidDecode(jid)
	if (!result) return ''
	const { user, server } = result
	return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server)
}

export const transferDevice = (fromJid, toJid) => {
	const fromDecoded = jidDecode(fromJid)
	const deviceId = fromDecoded?.device || 0
	const { server, user } = jidDecode(toJid)
	return jidEncode(user, server, deviceId)
}

/* ------------------------------------------------------------------ */
/* Binary node encode                                                  */
/* ------------------------------------------------------------------ */

export const encodeBinaryNode = (node, opts = constants, buffer = [0]) => {
	const encoded = encodeBinaryNodeInner(node, opts, buffer)
	return Buffer.from(encoded)
}

const encodeBinaryNodeInner = ({ tag, attrs, content }, opts, buffer) => {
	const { TAGS, TOKEN_MAP } = opts

	const pushByte = value => buffer.push(value & 0xff)
	const pushInt = (value, n, littleEndian = false) => {
		for (let i = 0; i < n; i++) {
			const curShift = littleEndian ? i : n - 1 - i
			buffer.push((value >> (curShift * 8)) & 0xff)
		}
	}
	const pushBytes = bytes => {
		for (const b of bytes) buffer.push(b)
	}
	const pushInt16 = value => pushBytes([(value >> 8) & 0xff, value & 0xff])
	const pushInt20 = value => pushBytes([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff])

	const writeByteLength = length => {
		if (length >= 4294967296) throw new Error('string too large to encode: ' + length)
		if (length >= 1 << 20) {
			pushByte(TAGS.BINARY_32)
			pushInt(length, 4)
		} else if (length >= 256) {
			pushByte(TAGS.BINARY_20)
			pushInt20(length)
		} else {
			pushByte(TAGS.BINARY_8)
			pushByte(length)
		}
	}

	const writeStringRaw = str => {
		const bytes = Buffer.from(str, 'utf-8')
		writeByteLength(bytes.length)
		pushBytes(bytes)
	}

	const writeJid = ({ domainType, device, user, server }) => {
		if (typeof device !== 'undefined') {
			pushByte(TAGS.AD_JID)
			pushByte(domainType || 0)
			pushByte(device || 0)
			writeString(user)
		} else {
			pushByte(TAGS.JID_PAIR)
			if (user.length) writeString(user)
			else pushByte(TAGS.LIST_EMPTY)
			writeString(server)
		}
	}

	const packNibble = char => {
		switch (char) {
			case '-':
				return 10
			case '.':
				return 11
			case '\0':
				return 15
			default:
				if (char >= '0' && char <= '9') return char.charCodeAt(0) - '0'.charCodeAt(0)
				throw new Error(`invalid byte for nibble "${char}"`)
		}
	}

	const packHex = char => {
		if (char >= '0' && char <= '9') return char.charCodeAt(0) - '0'.charCodeAt(0)
		if (char >= 'A' && char <= 'F') return 10 + char.charCodeAt(0) - 'A'.charCodeAt(0)
		if (char >= 'a' && char <= 'f') return 10 + char.charCodeAt(0) - 'a'.charCodeAt(0)
		if (char === '\0') return 15
		throw new Error(`Invalid hex char "${char}"`)
	}

	const writePackedBytes = (str, type) => {
		if (str.length > TAGS.PACKED_MAX) throw new Error('Too many bytes to pack')
		pushByte(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8)
		let roundedLength = Math.ceil(str.length / 2.0)
		if (str.length % 2 !== 0) roundedLength |= 128
		pushByte(roundedLength)
		const packFunction = type === 'nibble' ? packNibble : packHex
		const packBytePair = (v1, v2) => (packFunction(v1) << 4) | packFunction(v2)
		const strLengthHalf = Math.floor(str.length / 2)
		for (let i = 0; i < strLengthHalf; i++) pushByte(packBytePair(str[2 * i], str[2 * i + 1]))
		if (str.length % 2 !== 0) pushByte(packBytePair(str[str.length - 1], '\x00'))
	}

	const isNibble = str => {
		if (!str || str.length > TAGS.PACKED_MAX) return false
		for (const char of str) {
			const isInNibbleRange = char >= '0' && char <= '9'
			if (!isInNibbleRange && char !== '-' && char !== '.') return false
		}
		return true
	}

	const isHex = str => {
		if (!str || str.length > TAGS.PACKED_MAX) return false
		for (const char of str) {
			const isInNibbleRange = char >= '0' && char <= '9'
			if (!isInNibbleRange && !(char >= 'A' && char <= 'F')) return false
		}
		return true
	}

	const writeString = str => {
		if (str === undefined || str === null) {
			pushByte(TAGS.LIST_EMPTY)
			return
		}
		if (str === '') {
			writeStringRaw(str)
			return
		}
		const tokenIndex = TOKEN_MAP[str]
		if (tokenIndex) {
			if (typeof tokenIndex.dict === 'number') pushByte(TAGS.DICTIONARY_0 + tokenIndex.dict)
			pushByte(tokenIndex.index)
		} else if (isNibble(str)) {
			writePackedBytes(str, 'nibble')
		} else if (isHex(str)) {
			writePackedBytes(str, 'hex')
		} else {
			const decodedJid = jidDecode(str)
			if (decodedJid) writeJid(decodedJid)
			else writeStringRaw(str)
		}
	}

	const writeListStart = listSize => {
		if (listSize === 0) pushByte(TAGS.LIST_EMPTY)
		else if (listSize < 256) pushBytes([TAGS.LIST_8, listSize])
		else {
			pushByte(TAGS.LIST_16)
			pushInt16(listSize)
		}
	}

	if (!tag) throw new Error('Invalid node: tag cannot be undefined')

	const validAttributes = Object.keys(attrs || {}).filter(k => typeof attrs[k] !== 'undefined' && attrs[k] !== null)
	writeListStart(2 * validAttributes.length + 1 + (typeof content !== 'undefined' ? 1 : 0))
	writeString(tag)
	for (const key of validAttributes) {
		if (typeof attrs[key] === 'string') {
			writeString(key)
			writeString(attrs[key])
		}
	}

	if (typeof content === 'string') {
		writeString(content)
	} else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
		writeByteLength(content.length)
		pushBytes(content)
	} else if (Array.isArray(content)) {
		const validContent = content.filter(
			item => item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string')
		)
		writeListStart(validContent.length)
		for (const item of validContent) encodeBinaryNodeInner(item, opts, buffer)
	} else if (typeof content === 'undefined') {
		// no children
	} else {
		throw new Error(`invalid children for header "${tag}": ${content} (${typeof content})`)
	}

	return buffer
}

/* ------------------------------------------------------------------ */
/* Binary node decode                                                  */
/* ------------------------------------------------------------------ */

const inflatePromise = promisify(inflate)

export const decompressingIfRequired = async buffer => {
	if (2 & buffer.readUInt8()) {
		buffer = await inflatePromise(buffer.slice(1))
	} else {
		buffer = buffer.slice(1) // uncompressed nodes have a 0x00 prefix, strip it
	}
	return buffer
}

export const decodeDecompressedBinaryNode = (buffer, opts, indexRef = { index: 0 }) => {
	const { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } = opts

	const checkEOS = length => {
		if (indexRef.index + length > buffer.length) throw new Error('end of stream')
	}
	const next = () => {
		const value = buffer[indexRef.index]
		indexRef.index += 1
		return value
	}
	const readByte = () => {
		checkEOS(1)
		return next()
	}
	const readBytes = n => {
		checkEOS(n)
		const value = buffer.slice(indexRef.index, indexRef.index + n)
		indexRef.index += n
		return value
	}
	const readStringFromChars = length => readBytes(length).toString('utf-8')
	const readInt = (n, littleEndian = false) => {
		checkEOS(n)
		let val = 0
		for (let i = 0; i < n; i++) {
			const shift = littleEndian ? i : n - 1 - i
			val |= next() << (shift * 8)
		}
		return val
	}
	const readInt20 = () => {
		checkEOS(3)
		return ((next() & 15) << 16) + (next() << 8) + next()
	}

	const unpackHex = value => {
		if (value >= 0 && value < 16) return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10
		throw new Error('invalid hex: ' + value)
	}
	const unpackNibble = value => {
		if (value >= 0 && value <= 9) return '0'.charCodeAt(0) + value
		switch (value) {
			case 10:
				return '-'.charCodeAt(0)
			case 11:
				return '.'.charCodeAt(0)
			case 15:
				return '\0'.charCodeAt(0)
			default:
				throw new Error('invalid nibble: ' + value)
		}
	}
	const unpackByte = (tag, value) => {
		if (tag === TAGS.NIBBLE_8) return unpackNibble(value)
		if (tag === TAGS.HEX_8) return unpackHex(value)
		throw new Error('unknown tag: ' + tag)
	}
	const readPacked8 = tag => {
		const startByte = readByte()
		let value = ''
		for (let i = 0; i < (startByte & 127); i++) {
			const curByte = readByte()
			value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4))
			value += String.fromCharCode(unpackByte(tag, curByte & 0x0f))
		}
		if (startByte >> 7 !== 0) value = value.slice(0, -1)
		return value
	}

	const isListTag = tag => tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16
	const readListSize = tag => {
		switch (tag) {
			case TAGS.LIST_EMPTY:
				return 0
			case TAGS.LIST_8:
				return readByte()
			case TAGS.LIST_16:
				return readInt(2)
			default:
				throw new Error('invalid tag for list size: ' + tag)
		}
	}

	const readJidPair = () => {
		const i = readString(readByte())
		const j = readString(readByte())
		if (j) return (i || '') + '@' + j
		throw new Error('invalid jid pair: ' + i + ', ' + j)
	}
	const readAdJid = () => {
		const domainType = Number(readByte())
		const device = readByte()
		const user = readString(readByte())
		let server = 's.whatsapp.net'
		if (domainType === WAJIDDomains.LID) server = 'lid'
		else if (domainType === WAJIDDomains.HOSTED) server = 'hosted'
		else if (domainType === WAJIDDomains.HOSTED_LID) server = 'hosted.lid'
		return jidEncode(user, server, device)
	}
	const readFbJid = () => {
		const user = readString(readByte())
		const device = readInt(2)
		const server = readString(readByte())
		return `${user}:${device}@${server}`
	}
	const readInteropJid = () => {
		const user = readString(readByte())
		const device = readInt(2)
		const integrator = readInt(2)
		let server = 'interop'
		const beforeServer = indexRef.index
		try {
			server = readString(readByte())
		} catch {
			indexRef.index = beforeServer
		}
		return `${integrator}-${user}:${device}@${server}`
	}

	const readString = tag => {
		if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) return SINGLE_BYTE_TOKENS[tag] || ''
		switch (tag) {
			case TAGS.DICTIONARY_0:
			case TAGS.DICTIONARY_1:
			case TAGS.DICTIONARY_2:
			case TAGS.DICTIONARY_3:
				return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte())
			case TAGS.LIST_EMPTY:
				return ''
			case TAGS.BINARY_8:
				return readStringFromChars(readByte())
			case TAGS.BINARY_20:
				return readStringFromChars(readInt20())
			case TAGS.BINARY_32:
				return readStringFromChars(readInt(4))
			case TAGS.JID_PAIR:
				return readJidPair()
			case TAGS.FB_JID:
				return readFbJid()
			case TAGS.INTEROP_JID:
				return readInteropJid()
			case TAGS.AD_JID:
				return readAdJid()
			case TAGS.HEX_8:
			case TAGS.NIBBLE_8:
				return readPacked8(tag)
			default:
				throw new Error('invalid string with tag: ' + tag)
		}
	}

	const readList = tag => {
		const items = []
		const size = readListSize(tag)
		for (let i = 0; i < size; i++) items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef))
		return items
	}

	const getTokenDouble = (index1, index2) => {
		const dict = DOUBLE_BYTE_TOKENS[index1]
		if (!dict) throw new Error(`Invalid double token dict (${index1})`)
		const value = dict[index2]
		if (typeof value === 'undefined') throw new Error(`Invalid double token (${index2})`)
		return value
	}

	const listSize = readListSize(readByte())
	const header = readString(readByte())
	if (!listSize || !header.length) throw new Error('invalid node')

	const attrs = {}
	let data

	const attributesLength = (listSize - 1) >> 1
	for (let i = 0; i < attributesLength; i++) {
		const key = readString(readByte())
		const value = readString(readByte())
		attrs[key] = value
	}

	if (listSize % 2 === 0) {
		const tag = readByte()
		if (isListTag(tag)) {
			data = readList(tag)
		} else {
			switch (tag) {
				case TAGS.BINARY_8:
					data = readBytes(readByte())
					break
				case TAGS.BINARY_20:
					data = readBytes(readInt20())
					break
				case TAGS.BINARY_32:
					data = readBytes(readInt(4))
					break
				default:
					data = readString(tag)
					break
			}
		}
	}

	return { tag: header, attrs, content: data }
}

export const decodeBinaryNode = async buff => {
	const decompBuff = await decompressingIfRequired(buff)
	return decodeDecompressedBinaryNode(decompBuff, constants)
}

/* ------------------------------------------------------------------ */
/* Generic node helpers                                                */
/* ------------------------------------------------------------------ */

const indexCache = new WeakMap()

export const getBinaryNodeChildren = (node, childTag) => {
	if (!node || !Array.isArray(node.content)) return []
	let index = indexCache.get(node)
	if (!index) {
		index = new Map()
		for (const child of node.content) {
			let arr = index.get(child.tag)
			if (!arr) index.set(child.tag, (arr = []))
			arr.push(child)
		}
		indexCache.set(node, index)
	}
	return index.get(childTag) || []
}

export const getBinaryNodeChild = (node, childTag) => getBinaryNodeChildren(node, childTag)[0]

export const getAllBinaryNodeChildren = ({ content }) => (Array.isArray(content) ? content : [])

export const getBinaryNodeChildBuffer = (node, childTag) => {
	const child = getBinaryNodeChild(node, childTag)?.content
	if (Buffer.isBuffer(child) || child instanceof Uint8Array) return child
}

export const getBinaryNodeChildString = (node, childTag) => {
	const child = getBinaryNodeChild(node, childTag)?.content
	if (Buffer.isBuffer(child) || child instanceof Uint8Array) return Buffer.from(child).toString('utf-8')
	if (typeof child === 'string') return child
}

const bufferToUInt = (e, t) => {
	let a = 0
	for (let i = 0; i < t; i++) a = 256 * a + e[i]
	return a
}

export const getBinaryNodeChildUInt = (node, childTag, length) => {
	const buff = getBinaryNodeChildBuffer(node, childTag)
	if (buff) return bufferToUInt(buff, length)
}

export const assertNodeErrorFree = node => {
	const errNode = getBinaryNodeChild(node, 'error')
	if (errNode) throw new Boom(errNode.attrs.text || 'Unknown error', { data: +errNode.attrs.code })
}

export const reduceBinaryNodeToDictionary = (node, tag) => {
	const nodes = getBinaryNodeChildren(node, tag)
	return nodes.reduce((dict, { attrs }) => {
		if (typeof attrs.name === 'string') dict[attrs.name] = attrs.value || attrs.config_value
		else dict[attrs.config_code] = attrs.value || attrs.config_value
		return dict
	}, {})
}

/** `proto` is passed in by the message decode call site to avoid a hard import cycle here. */
export const getBinaryNodeMessages = ({ content }, proto) => {
	const msgs = []
	if (Array.isArray(content)) {
		for (const item of content) {
			if (item.tag === 'message') msgs.push(proto.WebMessageInfo.decode(item.content).toJSON())
		}
	}
	return msgs
}

const tabs = n => '\t'.repeat(n)
export function binaryNodeToString(node, i = 0) {
	if (!node) return node
	if (typeof node === 'string') return tabs(i) + node
	if (node instanceof Uint8Array) return tabs(i) + Buffer.from(node).toString('hex')
	if (Array.isArray(node)) return node.map(x => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n')

	const children = binaryNodeToString(node.content, i + 1)
	const tag = `<${node.tag} ${Object.entries(node.attrs || {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}='${v}'`)
		.join(' ')}`
	const content = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>'
	return tag + content
}

/**
 * Produce the binary node (WABinary-like JSON shape) required for the specific
 * interactive button / list type. Compatible with observed official client traffic.
 * NOTE: the "v" (version) / "name" values are empirically derived from real traffic.
 */
const FLOWS_MAP = {
	mpm: true,
	cta_catalog: true,
	send_location: true,
	call_permission_request: true,
	wa_payment_transaction_details: true,
	automated_greeting_message_view_catalog: true
}
const DECISION_SOURCE_CONTENT = [{ tag: 'decision_source', attrs: { value: 'df' } }]
const LIST_TYPE_CONTENT = { tag: 'list', attrs: { v: '2', type: 'product_list' } }
const NATIVE_FLOW_ATTRIBUTE = { type: 'native_flow', v: '1' }
const MIXED_NATIVE_FLOW = {
	tag: 'interactive',
	attrs: NATIVE_FLOW_ATTRIBUTE,
	content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
}

export const getBizBinaryNode = message => {
	const flowMsg = message.interactiveMessage?.nativeFlowMessage
	const firstButtonName = flowMsg?.buttons?.[0]?.name
	const qualityContent = {
		tag: 'quality_control',
		attrs: {
			decision_id: randomBytes(20).toString('hex'),
			source_type: 'third_party'
		},
		content: DECISION_SOURCE_CONTENT
	}
	const bizAttributes = {
		actual_actors: '2',
		host_storage: '2',
		privacy_mode_ts: `${(Date.now() / 1_000) | 0}`
	}

	if (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info') {
		bizAttributes.native_flow_name = firstButtonName === 'review_and_pay' ? 'order_details' : firstButtonName
		return { tag: 'biz', attrs: bizAttributes, content: [qualityContent] }
	}

	if (firstButtonName && FLOWS_MAP[firstButtonName]) {
		return {
			tag: 'biz',
			attrs: bizAttributes,
			content: [
				{
					tag: 'interactive',
					attrs: NATIVE_FLOW_ATTRIBUTE,
					content: [{ tag: 'native_flow', attrs: { v: '2', name: firstButtonName } }]
				},
				qualityContent
			]
		}
	}

	if (flowMsg || message.buttonsMessage || message.templateMessage) {
		return { tag: 'biz', attrs: bizAttributes, content: [MIXED_NATIVE_FLOW, qualityContent] }
	}

	if (message.listMessage) {
		return { tag: 'biz', attrs: bizAttributes, content: [LIST_TYPE_CONTENT, qualityContent] }
	}

	return { tag: 'biz', attrs: bizAttributes, content: [qualityContent] }
}

export { constants as WA_BINARY_CONSTANTS }

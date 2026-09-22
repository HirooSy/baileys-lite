/**
 * Core WA protocol utilities. Combines what used to be:
 *   crypto.js, generics.js, lt-hash.js, signal.js, validate-connection.js,
 *   noise-handler.js, browser-utils.js, companion-reg-client-utils.js,
 *   stanza-ack.js, reporting-utils.js
 *
 * md5/hkdf/LTHashAntiTampering come from ../foundation/wa-crypto.js and the
 * curve operations from ../signal/libsignal.js (both native, no npm deps).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomFillSync } from 'node:crypto'
import { platform, release } from 'node:os'
import { curve } from '../signal/libsignal.js'
import { createLogger } from '../foundation/logger.js'
import { md5, hkdf, LTHashAntiTampering } from '../foundation/wa-crypto.js'
import { Boom } from '../foundation/boom.js'
import { proto } from '../../WAProto/index.js'
import {
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildUInt,
	getBinaryNodeChildren,
	assertNodeErrorFree,
	jidDecode,
	S_WHATSAPP_NET,
	WAJIDDomains,
	getServerFromDomainType,
	decodeBinaryNode
} from '../binary/wa-binary.js'

export { md5, hkdf }

/* ------------------------------------------------------------------ */
/* Crypto primitives                                                    */
/* ------------------------------------------------------------------ */

const KEY_BUNDLE_TYPE = Buffer.from([5])
export { KEY_BUNDLE_TYPE }

/** prefix version byte to the pub keys, required for some curve crypto functions */
export const generateSignalPubKey = pubKey => (pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey]))

export const Curve = {
	generateKeyPair: () => {
		const { pubKey, privKey } = curve.generateKeyPair()
		return { private: Buffer.from(privKey), public: Buffer.from(pubKey.slice(1)) } // remove version byte
	},
	sharedKey: (privateKey, publicKey) => {
		const shared = curve.calculateAgreement(generateSignalPubKey(publicKey), privateKey)
		return Buffer.from(shared)
	},
	sign: (privateKey, buf) => curve.calculateSignature(privateKey, buf),
	/**
	 * KNOWN UPSTREAM QUIRK (kept for behavioral parity with @whiskeysockets/baileys 7.0.0-rc14): this only
	 * catches exceptions. `curve.verifySignature` REPORTS a bad signature by returning `false` (it does not throw),
	 * so `verify()` returns `true` for ANY well-formed 64-byte signature — a changed message, a random signature or
	 * a different key all "verify". The three call sites (noise certificate chain, account signature at pairing)
	 * are therefore not enforcing signatures today. See PROGRESS.md ("Security note") and `Curve.verifyStrict`.
	 */
	verify: (pubKey, message, signature) => {
		try {
			curve.verifySignature(generateSignalPubKey(pubKey), message, signature)
			return true
		} catch {
			return false
		}
	},
	/**
	 * Correct XEdDSA verification: returns `true` only for a valid signature. NOT used by the library yet —
	 * switching the call sites to it is a behavior change that must be validated against real server traffic
	 * first (a legitimate certificate that fails strict verification would break connecting).
	 */
	verifyStrict: (pubKey, message, signature) => {
		try {
			return curve.verifySignature(generateSignalPubKey(pubKey), message, signature) === true
		} catch {
			return false
		}
	}
}

export const signedKeyPair = (identityKeyPair, keyId) => {
	const preKey = Curve.generateKeyPair()
	const pubKey = generateSignalPubKey(preKey.public)
	const signature = Curve.sign(identityKeyPair.private, pubKey)
	return { keyPair: preKey, signature, keyId }
}

const GCM_TAG_LENGTH = 128 >> 3

/** encrypt AES 256 GCM; the auth tag is suffixed to the ciphertext */
export function aesEncryptGCM(plaintext, key, iv, additionalData) {
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(additionalData)
	return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/** decrypt AES 256 GCM; the auth tag is suffixed to the ciphertext */
export function aesDecryptGCM(ciphertext, key, iv, additionalData) {
	const decipher = createDecipheriv('aes-256-gcm', key, iv)
	const enc = ciphertext.slice(0, ciphertext.length - GCM_TAG_LENGTH)
	const tag = ciphertext.slice(ciphertext.length - GCM_TAG_LENGTH)
	decipher.setAAD(additionalData)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(enc), decipher.final()])
}

export function aesEncryptCTR(plaintext, key, iv) {
	const cipher = createCipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function aesDecryptCTR(ciphertext, key, iv) {
	const decipher = createDecipheriv('aes-256-ctr', key, iv)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** decrypt AES 256 CBC; the IV is prefixed to the buffer */
export function aesDecrypt(buffer, key) {
	return aesDecryptWithIV(buffer.subarray(16), key, buffer.subarray(0, 16))
}

export function aesDecryptWithIV(buffer, key, IV) {
	const aes = createDecipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([aes.update(buffer), aes.final()])
}

/** encrypt AES 256 CBC; a random IV is prefixed to the buffer */
export function aesEncrypt(buffer, key) {
	const IV = randomBytes(16)
	const aes = createCipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([IV, aes.update(buffer), aes.final()])
}

export function aesEncrypWithIV(buffer, key, IV) {
	const aes = createCipheriv('aes-256-cbc', key, IV)
	return Buffer.concat([aes.update(buffer), aes.final()])
}

export function hmacSign(buffer, key, variant = 'sha256') {
	return createHmac(variant, key).update(buffer).digest()
}

export function sha256(buffer) {
	return createHash('sha256').update(buffer).digest()
}

export async function derivePairingCodeKey(pairingCode, salt) {
	const { subtle } = globalThis.crypto
	const encoder = new TextEncoder()
	const pairingCodeBuffer = encoder.encode(pairingCode)
	const saltBuffer = new Uint8Array(salt instanceof Uint8Array ? salt : new Uint8Array(salt))
	const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer, { name: 'PBKDF2' }, false, ['deriveBits'])
	const derivedBits = await subtle.deriveBits({ name: 'PBKDF2', salt: saltBuffer, iterations: 2 << 16, hash: 'SHA-256' }, keyMaterial, 32 * 8)
	return Buffer.from(derivedBits)
}

/* ------------------------------------------------------------------ */
/* LT-Hash (anti-tampering)                                            */
/* ------------------------------------------------------------------ */

/**
 * LT Hash is a summation based hash algorithm that maintains the integrity of a piece of data
 * over a series of mutations. You can add/remove mutations and it'll return a hash equal to
 * if the same series of mutations was made sequentially.
 */
export const LT_HASH_ANTI_TAMPERING = new LTHashAntiTampering()

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

export const BufferJSON = {
	replacer: (k, value) => {
		if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
			return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') }
		}
		return value
	},
	reviver: (_, value) => {
		if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
			return Buffer.from(value.data, 'base64')
		}
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const keys = Object.keys(value)
			if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
				const values = Object.values(value)
				if (values.every(v => typeof v === 'number')) return Buffer.from(values)
			}
		}
		return value
	}
}

export const getKeyAuthor = (key, meId = 'me') =>
	(key?.fromMe ? meId : key?.participantAlt || key?.remoteJidAlt || key?.participant || key?.remoteJid) || ''

// eslint-disable-next-line eqeqeq
export const isStringNullOrEmpty = value => value == null || value === ''

export const writeRandomPadMax16 = msg => {
	const pad = randomBytes(1)
	const padLength = (pad[0] & 0x0f) + 1
	return Buffer.concat([msg, Buffer.alloc(padLength, padLength)])
}

export const unpadRandomMax16 = e => {
	const t = new Uint8Array(e)
	if (t.length === 0) throw new Error('unpadPkcs7 given empty bytes')
	const r = t[t.length - 1]
	if (r > t.length) throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`)
	return new Uint8Array(t.buffer, t.byteOffset, t.length - r)
}

// code is inspired by whatsmeow
export const generateParticipantHashV2 = participants => {
	participants.sort()
	const sha256Hash = sha256(Buffer.from(participants.join(''))).toString('base64')
	return '2:' + sha256Hash.slice(0, 6)
}

export const encodeWAMessage = message => writeRandomPadMax16(proto.Message.encode(message).finish())

export const generateRegistrationId = () => Uint16Array.from(randomBytes(2))[0] & 16383

export const encodeBigEndian = (e, t = 4) => {
	let r = e
	const a = new Uint8Array(t)
	for (let i = t - 1; i >= 0; i--) {
		a[i] = 255 & r
		r >>>= 8
	}
	return a
}

export const toNumber = t => (typeof t === 'object' && t ? ('toNumber' in t ? t.toNumber() : t.low) : t || 0)

/** unix timestamp of a date in seconds */
export const unixTimestampSeconds = (date = new Date()) => (date.getTime() / 1000) | 0

export const debouncedTimeout = (intervalMs = 1000, task) => {
	let timeout
	return {
		start: (newIntervalMs, newTask) => {
			task = newTask || task
			intervalMs = newIntervalMs || intervalMs
			timeout && clearTimeout(timeout)
			timeout = setTimeout(() => task?.(), intervalMs)
		},
		cancel: () => {
			timeout && clearTimeout(timeout)
			timeout = undefined
		},
		setTask: newTask => (task = newTask),
		setInterval: newInterval => (intervalMs = newInterval)
	}
}

export const delay = ms => delayCancellable(ms).delay

export const delayCancellable = ms => {
	const stack = new Error().stack
	let timeout
	let reject
	const delayPromise = new Promise((resolve, _reject) => {
		timeout = setTimeout(resolve, ms)
		reject = _reject
	})
	const cancel = () => {
		clearTimeout(timeout)
		reject(new Boom('Cancelled', { statusCode: 500, data: { stack } }))
	}
	return { delay: delayPromise, cancel }
}

export async function promiseTimeout(ms, promiseExecutor) {
	if (!ms) return new Promise(promiseExecutor)
	const stack = new Error().stack
	const { delay: delayPromise, cancel } = delayCancellable(ms)
	const p = new Promise((resolve, reject) => {
		delayPromise.then(() => reject(new Boom('Timed Out', { statusCode: 408, data: { stack } }))).catch(err => reject(err))
		promiseExecutor(resolve, reject)
	}).finally(cancel)
	return p
}

// inspired from whatsmeow's send.go
export const generateMessageIDV2 = userId => {
	const data = Buffer.alloc(8 + 20 + 16)
	data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)))
	if (userId) {
		const id = jidDecode(userId)
		if (id?.user) {
			data.write(id.user, 8)
			data.write('@c.us', 8 + id.user.length)
		}
	}
	const random = randomBytes(16)
	random.copy(data, 28)
	const hash = createHash('sha256').update(data).digest()
	return '3EB0' + hash.toString('hex').toUpperCase().substring(0, 18)
}

export const generateMessageID = () => '3EB0' + randomBytes(18).toString('hex').toUpperCase()

export function bindWaitForEvent(ev, event) {
	return async (check, timeoutMs) => {
		let listener
		let closeListener
		await promiseTimeout(timeoutMs, (resolve, reject) => {
			closeListener = ({ connection, lastDisconnect }) => {
				if (connection === 'close') {
					reject(lastDisconnect?.error || new Boom('Connection Closed', { statusCode: 428 }))
				}
			}
			ev.on('connection.update', closeListener)
			listener = async update => {
				if (await check(update)) resolve()
			}
			ev.on(event, listener)
		}).finally(() => {
			ev.off(event, listener)
			ev.off('connection.update', closeListener)
		})
	}
}

export const bindWaitForConnectionUpdate = ev => bindWaitForEvent(ev, 'connection.update')

const baileysVersion = [2, 3000, 1047970367]

/** utility that fetches latest baileys version from the master branch. */
export const fetchLatestBaileysVersion = async (options = {}) => {
	const URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts'
	try {
		const response = await fetch(URL, { dispatcher: options.dispatcher, method: 'GET', headers: options.headers })
		if (!response.ok) throw new Boom(`Failed to fetch latest Baileys version: ${response.statusText}`, { statusCode: response.status })
		const text = await response.text()
		// Extract version from the `const version = [...]` line (search all lines: robust to line shifts upstream)
		const versionMatch = text.match(/const version = \[(\d+),\s*(\d+),\s*(\d+)\]/)
		if (versionMatch) {
			const version = [parseInt(versionMatch[1]), parseInt(versionMatch[2]), parseInt(versionMatch[3])]
			return { version, isLatest: true }
		}
		throw new Error('Could not parse version from Defaults/index.ts')
	} catch (error) {
		return { version: baileysVersion, isLatest: false, error }
	}
}

/** fetches the latest web version of whatsapp. */
export const fetchLatestWaWebVersion = async (options = {}) => {
	try {
		const defaultHeaders = {
			'sec-fetch-site': 'none',
			'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
		}
		const headers = { ...defaultHeaders, ...options.headers }
		const response = await fetch('https://web.whatsapp.com/sw.js', { ...options, method: 'GET', headers })
		if (!response.ok) throw new Boom(`Failed to fetch sw.js: ${response.statusText}`, { statusCode: response.status })
		const data = await response.text()
		const regex = /\\?"client_revision\\?":\s*(\d+)/
		const match = data.match(regex)
		if (!match?.[1]) {
			return { version: baileysVersion, isLatest: false, error: { message: 'Could not find client revision in the fetched content' } }
		}
		return { version: [2, 3000, +match[1]], isLatest: true }
	} catch (error) {
		return { version: baileysVersion, isLatest: false, error }
	}
}

/** unique message tag prefix for MD clients */
export const generateMdTagPrefix = () => {
	const bytes = randomBytes(4)
	return `${bytes.readUInt16BE()}.${bytes.readUInt16BE(2)}-`
}

const STATUS_MAP = {
	sender: proto.WebMessageInfo.Status.SERVER_ACK,
	played: proto.WebMessageInfo.Status.PLAYED,
	read: proto.WebMessageInfo.Status.READ,
	'read-self': proto.WebMessageInfo.Status.READ
}

/** Given a type of receipt, returns what the new status of the message should be */
export const getStatusFromReceiptType = type => {
	const status = STATUS_MAP[type]
	if (typeof type === 'undefined') return proto.WebMessageInfo.Status.DELIVERY_ACK
	return status
}

const CODE_MAP = { conflict: 428 } // DisconnectReason.connectionReplaced

/** Stream errors generally provide a reason, map that to a baileys DisconnectReason */
export const getErrorCodeFromStreamError = node => {
	const [reasonNode] = getAllBinaryNodeChildren(node)
	let reason = reasonNode?.tag || 'unknown'
	const statusCode = +(node.attrs.code || CODE_MAP[reason] || 500) // DisconnectReason.badSession
	if (statusCode === 515) reason = 'restart required' // DisconnectReason.restartRequired
	return { reason, statusCode }
}

export const getCallStatusFromNode = ({ tag, attrs }) => {
	switch (tag) {
		case 'offer':
		case 'offer_notice':
			return 'offer'
		case 'terminate':
			return attrs.reason === 'timeout' ? 'timeout' : 'terminate' // fired when accepted/rejected/timeout/caller hangs up
		case 'preaccept':
			return 'preaccept'
		case 'transport':
			return 'transport'
		case 'relaylatency':
			return 'relaylatency'
		case 'reject':
			return 'reject'
		case 'accept':
			return 'accept'
		default:
			return 'ringing'
	}
}

const UNEXPECTED_SERVER_CODE_TEXT = 'Unexpected server response: '
export const getCodeFromWSError = error => {
	let statusCode = 500
	if (error?.message?.includes(UNEXPECTED_SERVER_CODE_TEXT)) {
		const code = +error?.message.slice(UNEXPECTED_SERVER_CODE_TEXT.length)
		if (!Number.isNaN(code) && code >= 400) statusCode = code
	} else if (error?.code?.startsWith('E') || error?.message?.includes('timed out')) {
		statusCode = 408 // ETIMEOUT, ENOTFOUND etc
	}
	return statusCode
}

/** Is the given platform WA business */
export const isWABusinessPlatform = platform => platform === 'smbi' || platform === 'smba'

export function trimUndefined(obj) {
	for (const key in obj) {
		if (typeof obj[key] === 'undefined') delete obj[key]
	}
	return obj
}

const CROCKFORD_CHARACTERS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'
export function bytesToCrockford(buffer) {
	let value = 0
	let bitCount = 0
	const crockford = []
	for (const element of buffer) {
		value = (value << 8) | (element & 0xff)
		bitCount += 8
		while (bitCount >= 5) {
			crockford.push(CROCKFORD_CHARACTERS.charAt((value >>> (bitCount - 5)) & 31))
			bitCount -= 5
		}
	}
	if (bitCount > 0) crockford.push(CROCKFORD_CHARACTERS.charAt((value << (5 - bitCount)) & 31))
	return crockford.join('')
}

export function encodeNewsletterMessage(message) {
	return proto.Message.encode(message).finish()
}

/* ------------------------------------------------------------------ */
/* Browser / companion-registration helpers                            */
/* ------------------------------------------------------------------ */

const PLATFORM_MAP = {
	aix: 'AIX',
	darwin: 'Mac OS',
	win32: 'Windows',
	android: 'Android',
	freebsd: 'FreeBSD',
	openbsd: 'OpenBSD',
	sunos: 'Solaris',
	linux: undefined,
	haiku: undefined,
	cygwin: undefined,
	netbsd: undefined
}

export const Browsers = {
	ubuntu: browser => ['Ubuntu', browser, '22.04.4'],
	macOS: browser => ['Mac OS', browser, '14.4.1'],
	baileys: browser => ['Baileys', browser, '6.5.0'],
	windows: browser => ['Windows', browser, '10.0.22631'],
	android: browser => [browser, 'Android', ''],
	appropriate: browser => [PLATFORM_MAP[platform()] || 'Ubuntu', browser, release()]
}

export const getPlatformId = browser => {
	const platformType = proto.DeviceProps.PlatformType[browser.toUpperCase()]
	return platformType ? platformType.toString() : '1' // chrome
}

export const CompanionWebClientType = {
	UNKNOWN: 0,
	CHROME: 1,
	EDGE: 2,
	FIREFOX: 3,
	IE: 4,
	OPERA: 5,
	SAFARI: 6,
	ELECTRON: 7,
	UWP: 8,
	OTHER_WEB_CLIENT: 9
}

const BROWSER_TO_COMPANION_WEB_CLIENT = {
	Chrome: CompanionWebClientType.CHROME,
	Edge: CompanionWebClientType.EDGE,
	Firefox: CompanionWebClientType.FIREFOX,
	IE: CompanionWebClientType.IE,
	Opera: CompanionWebClientType.OPERA,
	Safari: CompanionWebClientType.SAFARI
}

export const getCompanionWebClientType = ([os, browserName]) => {
	if (browserName === 'Desktop') return os === 'Windows' ? CompanionWebClientType.UWP : CompanionWebClientType.ELECTRON
	return BROWSER_TO_COMPANION_WEB_CLIENT[browserName] || CompanionWebClientType.OTHER_WEB_CLIENT
}

export const getCompanionPlatformId = browser => getCompanionWebClientType(browser).toString()

export const buildPairingQRData = (ref, noiseKeyB64, identityKeyB64, advB64, browser) =>
	'https://wa.me/settings/linked_devices#' + [ref, noiseKeyB64, identityKeyB64, advB64, getCompanionPlatformId(browser)].join(',')

/* ------------------------------------------------------------------ */
/* Stanza ACK                                                           */
/* ------------------------------------------------------------------ */

/**
 * Builds an ACK stanza for a received node. Pure function -- no I/O, no side effects.
 * Mirrors WhatsApp Web's ACK construction (WAWebHandleMsgSendAck.sendAck/sendNack).
 */
export function buildAckStanza(node, errorCode, meId) {
	const { tag, attrs } = node
	const stanza = { tag: 'ack', attrs: { id: attrs.id, to: attrs.from, class: tag } }
	if (errorCode) stanza.attrs.error = errorCode.toString()
	if (attrs.participant) stanza.attrs.participant = attrs.participant
	if (attrs.recipient) stanza.attrs.recipient = attrs.recipient
	if (attrs.type) stanza.attrs.type = attrs.type // WA Web always includes type when present
	if (tag === 'message' && meId) stanza.attrs.from = meId // WA Web always includes `from` for message-class ACKs
	return stanza
}

/* ------------------------------------------------------------------ */
/* Signal / prekey helpers                                             */
/* ------------------------------------------------------------------ */

function chunkArray(array, size) {
	const chunks = []
	for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size))
	return chunks
}

export const createSignalIdentity = (wid, accountSignatureKey) => ({
	identifier: { name: wid, deviceId: 0 },
	identifierKey: generateSignalPubKey(accountSignatureKey)
})

export const getPreKeys = async ({ get }, min, limit) => {
	const idList = []
	for (let id = min; id < limit; id++) idList.push(id.toString())
	return get('pre-key', idList)
}

export const generateOrGetPreKeys = (creds, range) => {
	const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
	const remaining = range - avaliable
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1
	const newPreKeys = {}
	if (remaining > 0) {
		for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) newPreKeys[i] = Curve.generateKeyPair()
	}
	return { newPreKeys, lastPreKeyId, preKeysRange: [creds.firstUnuploadedPreKeyId, range] }
}

export const xmppSignedPreKey = key => ({
	tag: 'skey',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
		{ tag: 'value', attrs: {}, content: key.keyPair.public },
		{ tag: 'signature', attrs: {}, content: key.signature }
	]
})

export const xmppPreKey = (pair, id) => ({
	tag: 'key',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
		{ tag: 'value', attrs: {}, content: pair.public }
	]
})

const isValidUInt = n => typeof n === 'number' && Number.isInteger(n)

export const extractE2ESessionFromRetryReceipt = receipt => {
	const keysNode = getBinaryNodeChild(receipt, 'keys')
	if (!keysNode) return null
	const typeBuf = getBinaryNodeChildBuffer(keysNode, 'type')
	if (!typeBuf || typeBuf.length !== 1 || typeBuf[0] !== KEY_BUNDLE_TYPE[0]) return null
	const identity = getBinaryNodeChildBuffer(keysNode, 'identity')
	const skey = getBinaryNodeChild(keysNode, 'skey')
	if (!identity || identity.length !== 32 || !skey) return null
	const registrationId = getBinaryNodeChildUInt(receipt, 'registration', 4)
	if (!isValidUInt(registrationId)) return null
	const signedPubKey = getBinaryNodeChildBuffer(skey, 'value')
	const signedSig = getBinaryNodeChildBuffer(skey, 'signature')
	const signedKeyId = getBinaryNodeChildUInt(skey, 'id', 3)
	if (!signedPubKey || signedPubKey.length !== 32 || !signedSig || !isValidUInt(signedKeyId)) return null
	const preKeyNode = getBinaryNodeChild(keysNode, 'key')
	let preKey
	if (preKeyNode) {
		const preKeyPub = getBinaryNodeChildBuffer(preKeyNode, 'value')
		const preKeyId = getBinaryNodeChildUInt(preKeyNode, 'id', 3)
		if (!preKeyPub || preKeyPub.length !== 32 || !isValidUInt(preKeyId)) return null
		preKey = { keyId: preKeyId, publicKey: generateSignalPubKey(preKeyPub) }
	}
	return {
		registrationId,
		identityKey: generateSignalPubKey(identity),
		signedPreKey: { keyId: signedKeyId, publicKey: generateSignalPubKey(signedPubKey), signature: signedSig },
		preKey
	}
}

export const parseAndInjectE2ESessions = async (node, repository) => {
	const extractKey = key =>
		key
			? {
					keyId: getBinaryNodeChildUInt(key, 'id', 3),
					publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')),
					signature: getBinaryNodeChildBuffer(key, 'signature')
				}
			: undefined

	const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user')
	for (const n of nodes) assertNodeErrorFree(n)

	// Chunked to yield to the event loop between batches (injectE2ESession is CPU-heavy, not IO).
	const chunkSize = 100
	const chunks = chunkArray(nodes, chunkSize)
	for (const nodesChunk of chunks) {
		for (const n of nodesChunk) {
			const signedKey = getBinaryNodeChild(n, 'skey')
			const key = getBinaryNodeChild(n, 'key')
			const identity = getBinaryNodeChildBuffer(n, 'identity')
			const jid = n.attrs.jid
			const registrationId = getBinaryNodeChildUInt(n, 'registration', 4)
			await repository.injectE2ESession({
				jid,
				session: {
					registrationId,
					identityKey: generateSignalPubKey(identity),
					signedPreKey: extractKey(signedKey),
					preKey: extractKey(key)
				}
			})
		}
	}
}

export const extractDeviceJids = (result, myJid, myLid, excludeZeroDevices) => {
	const { user: myUser, device: myDevice } = jidDecode(myJid)
	const extracted = []
	for (const userResult of result) {
		const { devices, id } = userResult
		const decoded = jidDecode(id)
		const { user, server } = decoded
		let { domainType } = decoded
		const deviceList = devices?.deviceList
		if (!Array.isArray(deviceList)) continue
		for (const { id: device, keyIndex, isHosted } of deviceList) {
			if (
				(!excludeZeroDevices || device !== 0) &&
				((myUser !== user && myLid !== user) || myDevice !== device) &&
				(device === 0 || !!keyIndex)
			) {
				if (isHosted) domainType = domainType === WAJIDDomains.LID ? WAJIDDomains.HOSTED_LID : WAJIDDomains.HOSTED
				extracted.push({ user, device, domainType, server: getServerFromDomainType(server, domainType) })
			}
		}
	}
	return extracted
}

/** get the next N keys for upload or processing */
export const getNextPreKeys = async ({ creds, keys }, count) => {
	const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count)
	const update = {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
	}
	await keys.set({ 'pre-key': newPreKeys })
	const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])
	return { update, preKeys }
}

export const getNextPreKeysNode = async (state, count) => {
	const { creds } = state
	const { update, preKeys } = await getNextPreKeys(state, count)
	const node = {
		tag: 'iq',
		attrs: { xmlns: 'encrypt', type: 'set', to: S_WHATSAPP_NET },
		content: [
			{ tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
			{ tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
			{ tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
			{ tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
			xmppSignedPreKey(creds.signedPreKey)
		]
	}
	return { update, node }
}

/* ------------------------------------------------------------------ */
/* Noise protocol handshake handler                                    */
/* ------------------------------------------------------------------ */

const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
const WA_CERT_DETAILS = {
	SERIAL: 0,
	ISSUER: 'WhatsAppLongTerm1',
	PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
}

const IV_LENGTH = 12
const EMPTY_BUFFER = Buffer.alloc(0)
const generateIV = counter => {
	const iv = new ArrayBuffer(IV_LENGTH)
	new DataView(iv).setUint32(8, counter)
	return new Uint8Array(iv)
}

class TransportState {
	constructor(encKey, decKey) {
		this.encKey = encKey
		this.decKey = decKey
		this.readCounter = 0
		this.writeCounter = 0
		this.iv = new Uint8Array(IV_LENGTH)
	}
	encrypt(plaintext) {
		const c = this.writeCounter++
		this.iv[8] = (c >>> 24) & 0xff
		this.iv[9] = (c >>> 16) & 0xff
		this.iv[10] = (c >>> 8) & 0xff
		this.iv[11] = c & 0xff
		return aesEncryptGCM(plaintext, this.encKey, this.iv, EMPTY_BUFFER)
	}
	decrypt(ciphertext) {
		const c = this.readCounter++
		this.iv[8] = (c >>> 24) & 0xff
		this.iv[9] = (c >>> 16) & 0xff
		this.iv[10] = (c >>> 8) & 0xff
		this.iv[11] = c & 0xff
		return aesDecryptGCM(ciphertext, this.decKey, this.iv, EMPTY_BUFFER)
	}
}

export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
	// Defense in depth: logger can end up undefined/null if a caller passes
	// it explicitly (e.g. a stale reference during reconnect) — don't crash,
	// fall back to a fresh silent-by-default logger instead.
	logger = (logger || createLogger()).child({ class: 'ns' })
	const data = Buffer.from(NOISE_MODE)
	let hash = data.byteLength === 32 ? data : sha256(data)
	let salt = hash
	let encKey = hash
	let decKey = hash
	let counter = 0
	let sentIntro = false
	let inBytes = Buffer.alloc(0)
	let transport = null
	let isWaitingForTransport = false
	let pendingOnFrame = null
	let introHeader
	let destroyed = false
	// Defense in depth: if data arrives faster than it can be processed (or a peer
	// misbehaves), inBytes would otherwise grow unbounded and eventually OOM the
	// process. Cap it and drop the buffered bytes rather than let it balloon.
	const MAX_IN_BYTES = 10 * 1024 * 1024

	if (routingInfo) {
		introHeader = Buffer.alloc(7 + routingInfo.byteLength + NOISE_HEADER.length)
		introHeader.write('ED', 0, 'utf8')
		introHeader.writeUint8(0, 2)
		introHeader.writeUint8(1, 3)
		introHeader.writeUint8(routingInfo.byteLength >> 16, 4)
		introHeader.writeUint16BE(routingInfo.byteLength & 65535, 5)
		introHeader.set(routingInfo, 7)
		introHeader.set(NOISE_HEADER, 7 + routingInfo.byteLength)
	} else {
		introHeader = Buffer.from(NOISE_HEADER)
	}

	const authenticate = data => {
		if (!transport) hash = sha256(Buffer.concat([hash, data]))
	}
	const encrypt = plaintext => {
		if (transport) return transport.encrypt(plaintext)
		const result = aesEncryptGCM(plaintext, encKey, generateIV(counter++), hash)
		authenticate(result)
		return result
	}
	const decrypt = ciphertext => {
		if (transport) return transport.decrypt(ciphertext)
		const result = aesDecryptGCM(ciphertext, decKey, generateIV(counter++), hash)
		authenticate(ciphertext)
		return result
	}
	const localHKDF = data => {
		const key = hkdf(Buffer.from(data), 64, { salt, info: '' })
		return [key.subarray(0, 32), key.subarray(32)]
	}
	const mixIntoKey = data => {
		const [write, read] = localHKDF(data)
		salt = write
		encKey = read
		decKey = read
		counter = 0
	}
	const finishInit = async () => {
		isWaitingForTransport = true
		const [write, read] = localHKDF(new Uint8Array(0))
		transport = new TransportState(write, read)
		isWaitingForTransport = false
		logger.trace('Noise handler transitioned to Transport state')
		if (pendingOnFrame) {
			logger.trace({ length: inBytes.length }, 'Flushing buffered frames after transport ready')
			await processData(pendingOnFrame)
			pendingOnFrame = null
		}
	}
	const processData = async onFrame => {
		let size
		while (true) {
			if (inBytes.length < 3) return
			size = (inBytes[0] << 16) | (inBytes[1] << 8) | inBytes[2]
			if (inBytes.length < size + 3) return
			let frame = inBytes.subarray(3, size + 3)
			inBytes = inBytes.subarray(size + 3)
			if (transport) {
				const result = transport.decrypt(frame)
				frame = await decodeBinaryNode(result)
			}
			if (logger.level === 'trace') logger.trace({ msg: frame?.attrs?.id }, 'recv frame')
			onFrame(frame)
		}
	}

	authenticate(NOISE_HEADER)
	authenticate(publicKey)

	return {
		encrypt,
		decrypt,
		authenticate,
		mixIntoKey,
		finishInit,
		processHandshake: ({ serverHello }, noiseKey) => {
			authenticate(serverHello.ephemeral)
			mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral))
			const decStaticContent = decrypt(serverHello.static)
			mixIntoKey(Curve.sharedKey(privateKey, decStaticContent))
			const certDecoded = decrypt(serverHello.payload)
			const { intermediate: certIntermediate, leaf } = proto.CertChain.decode(certDecoded)

			if (!leaf?.details || !leaf?.signature) throw new Boom('invalid noise leaf certificate', { statusCode: 400 })
			if (!certIntermediate?.details || !certIntermediate?.signature) {
				throw new Boom('invalid noise intermediate certificate', { statusCode: 400 })
			}

			const details = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details)
			const { issuerSerial } = details
			const verify = Curve.verify(details.key, leaf.details, leaf.signature)
			const verifyIntermediate = Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature)

			if (!verify) throw new Boom('noise certificate signature invalid', { statusCode: 400 })
			if (!verifyIntermediate) throw new Boom('noise intermediate certificate signature invalid', { statusCode: 400 })
			if (issuerSerial !== WA_CERT_DETAILS.SERIAL) throw new Boom('certification match failed', { statusCode: 400 })

			const keyEnc = encrypt(noiseKey.public)
			mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral))
			return keyEnc
		},
		encodeFrame: data => {
			if (transport) data = transport.encrypt(data)
			const dataLen = data.byteLength
			const introSize = sentIntro ? 0 : introHeader.length
			const frame = Buffer.allocUnsafe(introSize + 3 + dataLen)
			if (!sentIntro) {
				frame.set(introHeader)
				sentIntro = true
			}
			frame[introSize] = (dataLen >>> 16) & 0xff
			frame[introSize + 1] = (dataLen >>> 8) & 0xff
			frame[introSize + 2] = dataLen & 0xff
			frame.set(data, introSize + 3)
			return frame
		},
		decodeFrame: async (newData, onFrame) => {
			if (destroyed) return
			if (isWaitingForTransport) {
				inBytes = Buffer.concat([inBytes, newData])
				pendingOnFrame = onFrame
			} else {
				inBytes = inBytes.length === 0 ? Buffer.from(newData) : Buffer.concat([inBytes, newData])
			}
			if (inBytes.length > MAX_IN_BYTES) {
				logger.error({ bufferedBytes: inBytes.length, max: MAX_IN_BYTES }, 'noise handler inBytes buffer exceeded cap, clearing')
				inBytes = Buffer.alloc(0)
				pendingOnFrame = null
				return
			}
			if (!isWaitingForTransport) await processData(onFrame)
		},
		/**
		 * Release internal state (encryption buffers, transport state, pending frame
		 * callbacks) when the connection is torn down, so none of it lingers in memory
		 * and no further frames are processed on a dead connection.
		 */
		destroy: () => {
			destroyed = true
			inBytes = Buffer.alloc(0)
			pendingOnFrame = null
			transport = null
		}
	}
}

/* ------------------------------------------------------------------ */
/* Connection validation (login / registration / pairing)              */
/* ------------------------------------------------------------------ */

const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])

const getUserAgent = config => ({
	appVersion: { primary: config.version[0], secondary: config.version[1], tertiary: config.version[2] },
	platform: config.browser[1].toLocaleLowerCase().includes('android')
		? proto.ClientPayload.UserAgent.Platform.ANDROID
		: proto.ClientPayload.UserAgent.Platform.WEB,
	releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
	osVersion: '0.1',
	device: 'Desktop',
	osBuildNumber: '0.1',
	localeLanguageIso6391: 'en',
	mnc: '000',
	mcc: '000',
	localeCountryIso31661Alpha2: config.countryCode
})

const WEB_PLATFORM_MAP = {
	'Mac OS': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32
}

const getWebInfo = config => {
	let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	if (config.syncFullHistory && WEB_PLATFORM_MAP[config.browser[0]] && config.browser[1] === 'Desktop') {
		webSubPlatform = WEB_PLATFORM_MAP[config.browser[0]]
	}
	return { webSubPlatform }
}

const getClientPayload = config => {
	const payload = {
		connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config)
	}
	if (!config.browser[1].toLocaleLowerCase().includes('android')) payload.webInfo = getWebInfo(config)
	if (config.pushName) payload.pushName = config.pushName
	return payload
}

export const generateLoginNode = (userJid, config) => {
	const { user, device } = jidDecode(userJid)
	const payload = { ...getClientPayload(config), passive: true, pull: true, username: +user, device, lidDbMigrated: false }
	return proto.ClientPayload.fromObject(payload)
}

const getPlatformType = platform => {
	const platformType = platform.toUpperCase()
	if (platformType === 'ANDROID') return proto.DeviceProps.PlatformType.ANDROID_PHONE
	return proto.DeviceProps.PlatformType[platformType] || proto.DeviceProps.PlatformType.CHROME
}

export const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
	const appVersionBuf = createHash('md5').update(config.version.join('.')).digest()
	const companion = {
		os: config.browser[0],
		platformType: getPlatformType(config.browser[1]),
		requireFullSync: config.syncFullHistory,
		historySyncConfig: {
			storageQuotaMb: 10240,
			inlineInitialPayloadInE2EeMsg: true,
			recentSyncDaysLimit: undefined,
			supportCallLogHistory: false,
			supportBotUserAgentChatHistory: true,
			supportCagReactionsAndPolls: true,
			supportBizHostedMsg: true,
			supportRecentSyncChunkMessageCountTuning: true,
			supportHostedGroupMsg: true,
			supportFbidBotChatHistory: true,
			supportAddOnHistorySyncMigration: undefined,
			supportMessageAssociation: true,
			supportGroupHistory: false,
			onDemandReady: undefined,
			supportGuestChat: undefined
		},
		version: { primary: 10, secondary: 15, tertiary: 7 }
	}
	const companionProto = proto.DeviceProps.encode(companion).finish()
	const registerPayload = {
		...getClientPayload(config),
		passive: false,
		pull: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature
		}
	}
	return proto.ClientPayload.fromObject(registerPayload)
}

export const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
	const msgId = stanza.attrs.id
	const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')
	const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
	const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
	const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
	const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

	if (!deviceIdentityNode || !deviceNode) throw new Boom('Missing device-identity or device in pair success node', { data: stanza })

	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid
	const lid = deviceNode.attrs.lid
	const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content)

	let hmacPrefix = Buffer.from([])
	if (accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED) hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX

	const advSign = hmacSign(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'))
	if (Buffer.compare(hmac, advSign) !== 0) throw new Boom('Invalid account signature')

	const account = proto.ADVSignedDeviceIdentity.decode(details)
	const { accountSignatureKey, accountSignature, details: deviceDetails } = account
	const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails)
	const accountSignaturePrefix =
		deviceIdentity.deviceType === proto.ADVEncryptionType.HOSTED ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX : WA_ADV_ACCOUNT_SIG_PREFIX
	const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails, signedIdentityKey.public])
	if (!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) throw new Boom('Failed to verify account signature')

	const deviceMsg = Buffer.concat([WA_ADV_DEVICE_SIG_PREFIX, deviceDetails, signedIdentityKey.public, accountSignatureKey])
	account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg)
	const identity = createSignalIdentity(lid, accountSignatureKey)
	const accountEnc = encodeSignedDeviceIdentity(account, false)

	const reply = {
		tag: 'iq',
		attrs: { to: S_WHATSAPP_NET, type: 'result', id: msgId },
		content: [
			{
				tag: 'pair-device-sign',
				attrs: {},
				content: [{ tag: 'device-identity', attrs: { 'key-index': deviceIdentity.keyIndex.toString() }, content: accountEnc }]
			}
		]
	}
	const authUpdate = {
		account,
		me: { id: jid, name: bizName, lid },
		signalIdentities: [...(signalIdentities || []), identity],
		platform: platformNode?.attrs.name
	}
	return { creds: authUpdate, reply }
}

export const encodeSignedDeviceIdentity = (account, includeSignatureKey) => {
	account = { ...account }
	if (!includeSignatureKey || !account.accountSignatureKey?.length) account.accountSignatureKey = null
	return proto.ADVSignedDeviceIdentity.encode(account).finish()
}

/* ------------------------------------------------------------------ */
/* Message reporting token                                             */
/* ------------------------------------------------------------------ */

const reportingFields = [
	{ f: 1 },
	{ f: 3, s: [{ f: 2 }, { f: 3 }, { f: 8 }, { f: 11 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 25 }] },
	{ f: 4, s: [{ f: 1 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
	{ f: 5, s: [{ f: 3 }, { f: 4 }, { f: 5 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
	{ f: 6, s: [{ f: 1 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 30 }] },
	{ f: 7, s: [{ f: 2 }, { f: 7 }, { f: 10 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
	{ f: 8, s: [{ f: 2 }, { f: 7 }, { f: 9 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 21 }] },
	{ f: 9, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
	{ f: 12, s: [{ f: 1 }, { f: 2 }, { f: 14, m: true }, { f: 15 }] },
	{ f: 18, s: [{ f: 6 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
	{ f: 26, s: [{ f: 4 }, { f: 5 }, { f: 8 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
	{ f: 28, s: [{ f: 1 }, { f: 2 }, { f: 4 }, { f: 5 }, { f: 6 }, { f: 7, s: [{ f: 21 }, { f: 22 }] }] },
	{ f: 37, s: [{ f: 1, m: true }] },
	{ f: 49, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] }, { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
	{ f: 53, s: [{ f: 1, m: true }] },
	{ f: 55, s: [{ f: 1, m: true }] },
	{ f: 58, s: [{ f: 1, m: true }] },
	{ f: 59, s: [{ f: 1, m: true }] },
	{ f: 60, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] }, { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
	{ f: 64, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] }, { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
	{ f: 66, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
	{ f: 74, s: [{ f: 1, m: true }] },
	{ f: 87, s: [{ f: 1, m: true }] },
	{ f: 88, s: [{ f: 1 }, { f: 2, s: [{ f: 1 }] }, { f: 3, s: [{ f: 21 }, { f: 22 }] }] },
	{ f: 92, s: [{ f: 1, m: true }] },
	{ f: 93, s: [{ f: 1, m: true }] },
	{ f: 94, s: [{ f: 1, m: true }] }
]

const compileReportingFields = fields => {
	const map = new Map()
	for (const f of fields) map.set(f.f, { m: f.m, children: f.s ? compileReportingFields(f.s) : undefined })
	return map
}
const compiledReportingFields = compileReportingFields(reportingFields)
const EMPTY_MAP = new Map()
const ENC_SECRET_REPORT_TOKEN = 'Report Token'
const WIRE = { VARINT: 0, FIXED64: 1, BYTES: 2, FIXED32: 5 }

export const shouldIncludeReportingToken = message =>
	!message.reactionMessage && !message.encReactionMessage && !message.encEventResponseMessage && !message.pollUpdateMessage

const generateMsgSecretKey = (modificationType, origMsgId, origMsgSender, modificationSender, origMsgSecret) => {
	const useCaseSecret = Buffer.concat([
		Buffer.from(origMsgId, 'utf8'),
		Buffer.from(origMsgSender, 'utf8'),
		Buffer.from(modificationSender, 'utf8'),
		Buffer.from(modificationType, 'utf8')
	])
	return hkdf(origMsgSecret, 32, { info: useCaseSecret.toString('latin1') })
}

const decodeVarint = (buffer, offset) => {
	let value = 0
	let bytes = 0
	let shift = 0
	while (offset + bytes < buffer.length) {
		const current = buffer[offset + bytes]
		value |= (current & 0x7f) << shift
		bytes++
		if ((current & 0x80) === 0) return { value, bytes, ok: true }
		shift += 7
		if (shift > 35) return { value: 0, bytes: 0, ok: false }
	}
	return { value: 0, bytes: 0, ok: false }
}

const encodeVarint = value => {
	const parts = []
	let remaining = value >>> 0
	while (remaining > 0x7f) {
		parts.push((remaining & 0x7f) | 0x80)
		remaining >>>= 7
	}
	parts.push(remaining)
	return Buffer.from(parts)
}

const extractReportingTokenContent = (data, cfg) => {
	const out = []
	let i = 0
	while (i < data.length) {
		const tag = decodeVarint(data, i)
		if (!tag.ok) return null
		const fieldNum = tag.value >> 3
		const wireType = tag.value & 0x7
		const fieldStart = i
		i += tag.bytes
		const fieldCfg = cfg.get(fieldNum)
		const pushSlice = end => {
			if (end > data.length) return false
			out.push({ num: fieldNum, bytes: data.subarray(fieldStart, end) })
			i = end
			return true
		}
		const skip = end => {
			if (end > data.length) return false
			i = end
			return true
		}
		if (wireType === WIRE.VARINT) {
			const v = decodeVarint(data, i)
			if (!v.ok) return null
			const end = i + v.bytes
			if (!fieldCfg) {
				if (!skip(end)) return null
				continue
			}
			if (!pushSlice(end)) return null
			continue
		}
		if (wireType === WIRE.FIXED64) {
			const end = i + 8
			if (!fieldCfg) {
				if (!skip(end)) return null
				continue
			}
			if (!pushSlice(end)) return null
			continue
		}
		if (wireType === WIRE.FIXED32) {
			const end = i + 4
			if (!fieldCfg) {
				if (!skip(end)) return null
				continue
			}
			if (!pushSlice(end)) return null
			continue
		}
		if (wireType === WIRE.BYTES) {
			const len = decodeVarint(data, i)
			if (!len.ok) return null
			const valStart = i + len.bytes
			const valEnd = valStart + len.value
			if (valEnd > data.length) return null
			if (!fieldCfg) {
				i = valEnd
				continue
			}
			if (fieldCfg.m || fieldCfg.children) {
				const sub = extractReportingTokenContent(data.subarray(valStart, valEnd), fieldCfg.children ?? EMPTY_MAP)
				if (sub === null) return null
				if (sub.length > 0) {
					const newTag = encodeVarint(tag.value)
					const newLen = encodeVarint(sub.length)
					out.push({ num: fieldNum, bytes: Buffer.concat([newTag, newLen, sub]) })
				}
				i = valEnd
				continue
			}
			out.push({ num: fieldNum, bytes: data.subarray(fieldStart, valEnd) })
			i = valEnd
			continue
		}
		return null
	}
	if (out.length === 0) return Buffer.alloc(0)
	out.sort((a, b) => a.num - b.num)
	return Buffer.concat(out.map(f => f.bytes))
}

export const getMessageReportingToken = async (msgProtobuf, message, key) => {
	const msgSecret = message.messageContextInfo?.messageSecret
	if (!msgSecret || !key.id) return null
	const from = key.fromMe ? key.remoteJid : key.participant || key.remoteJid
	const to = key.fromMe ? key.participant || key.remoteJid : key.remoteJid
	const reportingSecret = generateMsgSecretKey(ENC_SECRET_REPORT_TOKEN, key.id, from, to, msgSecret)
	const content = extractReportingTokenContent(msgProtobuf, compiledReportingFields)
	if (!content || content.length === 0) return null
	const reportingToken = createHmac('sha256', reportingSecret).update(content).digest().subarray(0, 16)
	return {
		tag: 'reporting',
		attrs: {},
		content: [{ tag: 'reporting_token', attrs: { v: '2' }, content: reportingToken }]
	}
}

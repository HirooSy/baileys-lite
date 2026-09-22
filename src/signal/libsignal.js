/**
 * Native Signal protocol implementation (X3DH + Double Ratchet, 1:1 sessions).
 *
 * Replaces the `libsignal` npm package (WhiskeySockets/libsignal-node 6.0.0),
 * together with its dependencies `curve25519-js` and `protobufjs`.
 * It is a faithful port: same wire format, same session serialization, same
 * error classes and same public API, so existing auth-state / session data
 * stays compatible. Verified against the original package in
 * test/native-deps.mjs (cross-encrypt / decrypt in both directions).
 */
import * as nodeCrypto from 'node:crypto'
import { publicFromPrivate, randomX25519, sharedKey, sign as xeddsaSign, verify as xeddsaVerify } from '../foundation/curve25519.js'

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

export class SignalError extends Error {}

export class UntrustedIdentityKeyError extends SignalError {
	constructor(addr, identityKey) {
		super()
		this.name = 'UntrustedIdentityKeyError'
		this.addr = addr
		this.identityKey = identityKey
	}
}

export class SessionError extends SignalError {
	constructor(message) {
		super(message)
		this.name = 'SessionError'
	}
}

export class MessageCounterError extends SessionError {
	constructor(message) {
		super(message)
		this.name = 'MessageCounterError'
	}
}

export class PreKeyError extends SessionError {
	constructor(message) {
		super(message)
		this.name = 'PreKeyError'
	}
}

/* ------------------------------------------------------------------ */
/* crypto                                                              */
/* ------------------------------------------------------------------ */

const assertBuffer = value => {
	if (!(value instanceof Buffer)) throw TypeError(`Expected Buffer instead of: ${value.constructor.name}`)
	return value
}

export const crypto = {
	encrypt(key, data, iv) {
		assertBuffer(key)
		assertBuffer(data)
		assertBuffer(iv)
		const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv)
		return Buffer.concat([cipher.update(data), cipher.final()])
	},
	decrypt(key, data, iv) {
		assertBuffer(key)
		assertBuffer(data)
		assertBuffer(iv)
		const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', key, iv)
		return Buffer.concat([decipher.update(data), decipher.final()])
	},
	calculateMAC(key, data) {
		assertBuffer(key)
		assertBuffer(data)
		return Buffer.from(nodeCrypto.createHmac('sha256', key).update(data).digest())
	},
	hash(data) {
		assertBuffer(data)
		return nodeCrypto.createHash('sha512').update(data).digest()
	},
	// Salts always end up being 32 bytes
	deriveSecrets(input, salt, info, chunks) {
		// RFC 5869 that only returns the first 3 32-byte chunks
		assertBuffer(input)
		assertBuffer(salt)
		assertBuffer(info)
		if (salt.byteLength != 32) throw new Error('Got salt of incorrect length')
		chunks = chunks || 3
		if (!(chunks >= 1 && chunks <= 3)) throw new Error('chunks must be between 1 and 3')
		const PRK = crypto.calculateMAC(salt, input)
		const infoArray = new Uint8Array(info.byteLength + 1 + 32)
		infoArray.set(info, 32)
		infoArray[infoArray.length - 1] = 1
		const signed = [crypto.calculateMAC(PRK, Buffer.from(infoArray.slice(32)))]
		if (chunks > 1) {
			infoArray.set(signed[signed.length - 1])
			infoArray[infoArray.length - 1] = 2
			signed.push(crypto.calculateMAC(PRK, Buffer.from(infoArray)))
		}
		if (chunks > 2) {
			infoArray.set(signed[signed.length - 1])
			infoArray[infoArray.length - 1] = 3
			signed.push(crypto.calculateMAC(PRK, Buffer.from(infoArray)))
		}
		return signed
	},
	verifyMAC(data, key, mac, length) {
		const calculatedMac = crypto.calculateMAC(key, data).slice(0, length)
		if (mac.length !== length || calculatedMac.length !== length) throw new Error('Bad MAC length')
		if (!mac.equals(calculatedMac)) throw new Error('Bad MAC')
	}
}

/* ------------------------------------------------------------------ */
/* curve (33-byte "DJB type 5" public keys, 32-byte private keys)      */
/* ------------------------------------------------------------------ */

const KEY_BUNDLE_TYPE = Buffer.from([5])
const prefixKeyInPublicKey = pubKey => Buffer.concat([KEY_BUNDLE_TYPE, pubKey])

const validatePrivKey = privKey => {
	if (privKey === undefined) throw new Error('Undefined private key')
	if (!(privKey instanceof Buffer)) throw new Error(`Invalid private key type: ${privKey.constructor.name}`)
	if (privKey.byteLength != 32) throw new Error(`Incorrect private key length: ${privKey.byteLength}`)
}

const scrubPubKeyFormat = pubKey => {
	if (!(pubKey instanceof Buffer)) throw new Error(`Invalid public key type: ${pubKey.constructor.name}`)
	if (pubKey === undefined || ((pubKey.byteLength != 33 || pubKey[0] != 5) && pubKey.byteLength != 32)) {
		throw new Error('Invalid public key')
	}
	if (pubKey.byteLength == 33) return pubKey.slice(1)
	console.error('WARNING: Expected pubkey of length 33, please report the ST and client that generated the pubkey')
	return pubKey
}

const unclampEd25519PrivateKey = clampedSk => {
	const unclampedSk = new Uint8Array(clampedSk)
	unclampedSk[0] |= 6 // Ensure last 3 bits match expected `110` pattern
	unclampedSk[31] |= 128 // Restore the highest bit
	unclampedSk[31] &= ~64 // Clear the second-highest bit
	return unclampedSk
}

export const curve = {
	getPublicFromPrivateKey(privKey) {
		return prefixKeyInPublicKey(publicFromPrivate(unclampEd25519PrivateKey(privKey)))
	},
	generateKeyPair() {
		const { pub, priv } = randomX25519()
		return { pubKey: prefixKeyInPublicKey(pub), privKey: priv }
	},
	calculateAgreement(pubKey, privKey) {
		pubKey = scrubPubKeyFormat(pubKey)
		validatePrivKey(privKey)
		if (!pubKey || pubKey.byteLength != 32) throw new Error('Invalid public key')
		return sharedKey(privKey, pubKey)
	},
	calculateSignature(privKey, message) {
		validatePrivKey(privKey)
		if (!message) throw new Error('Invalid message')
		return Buffer.from(xeddsaSign(privKey, message))
	},
	verifySignature(pubKey, msg, sig, isInit) {
		pubKey = scrubPubKeyFormat(pubKey)
		if (!pubKey || pubKey.byteLength != 32) throw new Error('Invalid public key')
		if (!msg) throw new Error('Invalid message')
		if (!sig || sig.byteLength != 64) throw new Error('Invalid signature')
		return isInit ? true : xeddsaVerify(pubKey, msg, sig)
	}
}

/* ------------------------------------------------------------------ */
/* keyhelper                                                           */
/* ------------------------------------------------------------------ */

const isNonNegativeInteger = n => typeof n === 'number' && n % 1 === 0 && n >= 0

export const keyhelper = {
	generateIdentityKeyPair: curve.generateKeyPair,
	generateRegistrationId() {
		const registrationId = Uint16Array.from(nodeCrypto.randomBytes(2))[0]
		return registrationId & 0x3fff
	},
	generateSignedPreKey(identityKeyPair, signedKeyId) {
		if (
			!(identityKeyPair.privKey instanceof Buffer) ||
			identityKeyPair.privKey.byteLength != 32 ||
			!(identityKeyPair.pubKey instanceof Buffer) ||
			identityKeyPair.pubKey.byteLength != 33
		) {
			throw new TypeError('Invalid argument for identityKeyPair')
		}
		if (!isNonNegativeInteger(signedKeyId)) throw new TypeError('Invalid argument for signedKeyId: ' + signedKeyId)
		const keyPair = curve.generateKeyPair()
		const sig = curve.calculateSignature(identityKeyPair.privKey, keyPair.pubKey)
		return { keyId: signedKeyId, keyPair, signature: sig }
	},
	generatePreKey(keyId) {
		if (!isNonNegativeInteger(keyId)) throw new TypeError('Invalid argument for keyId: ' + keyId)
		return { keyId, keyPair: curve.generateKeyPair() }
	}
}

/* ------------------------------------------------------------------ */
/* minimal protobuf (proto2 varint + length-delimited only)            */
/* ------------------------------------------------------------------ */

const writeVarint = (out, n) => {
	n = n >>> 0
	while (n > 127) {
		out.push((n & 127) | 128)
		n >>>= 7
	}
	out.push(n)
}

class PbReader {
	constructor(buf) {
		this.buf = buf
		this.pos = 0
		this.len = buf.length
	}
	varint() {
		// uint32 semantics (protobufjs reads up to 5 bytes, keeps low 32 bits)
		let value = 0
		for (let i = 0; i < 5; i++) {
			if (this.pos >= this.len) throw RangeError(`index out of range: ${this.pos} + 1 > ${this.len}`)
			const b = this.buf[this.pos++]
			value = (value | ((b & 127) << (7 * i))) >>> 0
			if (b < 128) return value
		}
		// consume any remaining continuation bytes (up to 10 total)
		for (let i = 5; i < 10; i++) {
			if (this.pos >= this.len) throw RangeError(`index out of range: ${this.pos} + 1 > ${this.len}`)
			if (this.buf[this.pos++] < 128) return value
		}
		throw Error('invalid varint encoding')
	}
	bytes() {
		const length = this.varint()
		const start = this.pos
		const end = start + length
		if (end > this.len) throw RangeError(`index out of range: ${this.pos} + ${length} > ${this.len}`)
		this.pos = end
		return Buffer.from(this.buf.subarray(start, end))
	}
	skipType(wireType) {
		switch (wireType) {
			case 0:
				this.varint()
				break
			case 1:
				this.pos += 8
				break
			case 2: {
				// NOTE: not `this.pos += this.varint()` — that reads `pos` BEFORE varint() advances it
				const skip = this.varint()
				this.pos += skip
				break
			}
			case 5:
				this.pos += 4
				break
			default:
				throw Error('invalid wire type ' + wireType + ' at offset ' + this.pos)
		}
		if (this.pos > this.len) throw RangeError('index out of range')
	}
}

/** Build a tiny message class: fields = [[name, fieldNo, 'bytes'|'uint32', encodeOrder]] */
const defineMessage = (fields, defaults) => {
	const Msg = function (props) {
		if (props) for (const k of Object.keys(props)) if (props[k] != null) this[k] = props[k]
	}
	for (const f of fields) Msg.prototype[f.name] = defaults[f.name]
	Msg.create = props => new Msg(props)
	Msg.encode = message => {
		const out = []
		for (const f of fields) {
			// protobufjs only writes fields that are OWN properties and non-null
			if (message[f.name] != null && Object.prototype.hasOwnProperty.call(message, f.name)) {
				if (f.type === 'uint32') {
					writeVarint(out, (f.no << 3) | 0)
					writeVarint(out, message[f.name])
				} else {
					writeVarint(out, (f.no << 3) | 2)
					const b = message[f.name]
					writeVarint(out, b.length)
					for (let i = 0; i < b.length; i++) out.push(b[i])
				}
			}
		}
		const buf = Buffer.from(out)
		return { finish: () => new Uint8Array(buf.buffer, buf.byteOffset, buf.length) }
	}
	Msg.decode = data => {
		const reader = new PbReader(data)
		const message = new Msg()
		const byNo = new Map(fields.map(f => [f.no, f]))
		while (reader.pos < reader.len) {
			const tag = reader.varint()
			const f = byNo.get(tag >>> 3)
			if (f) message[f.name] = f.type === 'uint32' ? reader.varint() : reader.bytes()
			else reader.skipType(tag & 7)
		}
		return message
	}
	return Msg
}

// textsecure.WhisperMessage
export const WhisperMessage = defineMessage(
	[
		{ name: 'ephemeralKey', no: 1, type: 'bytes' },
		{ name: 'counter', no: 2, type: 'uint32' },
		{ name: 'previousCounter', no: 3, type: 'uint32' },
		{ name: 'ciphertext', no: 4, type: 'bytes' }
	],
	{ ephemeralKey: Buffer.alloc(0), counter: 0, previousCounter: 0, ciphertext: Buffer.alloc(0) }
)

// textsecure.PreKeyWhisperMessage
export const PreKeyWhisperMessage = defineMessage(
	[
		{ name: 'preKeyId', no: 1, type: 'uint32' },
		{ name: 'baseKey', no: 2, type: 'bytes' },
		{ name: 'identityKey', no: 3, type: 'bytes' },
		{ name: 'message', no: 4, type: 'bytes' },
		{ name: 'registrationId', no: 5, type: 'uint32' },
		{ name: 'signedPreKeyId', no: 6, type: 'uint32' }
	],
	{
		preKeyId: 0,
		baseKey: Buffer.alloc(0),
		identityKey: Buffer.alloc(0),
		message: Buffer.alloc(0),
		registrationId: 0,
		signedPreKeyId: 0
	}
)

/* ------------------------------------------------------------------ */
/* ProtocolAddress                                                     */
/* ------------------------------------------------------------------ */

export class ProtocolAddress {
	static from(encodedAddress) {
		if (typeof encodedAddress !== 'string' || !encodedAddress.match(/.*\.\d+/)) throw new Error('Invalid address encoding')
		const parts = encodedAddress.split('.')
		return new this(parts[0], parseInt(parts[1]))
	}
	constructor(id, deviceId) {
		if (typeof id !== 'string') throw new TypeError('id required for addr')
		if (id.indexOf('.') !== -1) throw new TypeError('encoded addr detected')
		this.id = id
		if (typeof deviceId !== 'number') throw new TypeError('number required for deviceId')
		this.deviceId = deviceId
	}
	toString() {
		return `${this.id}.${this.deviceId}`
	}
	is(other) {
		if (!(other instanceof ProtocolAddress)) return false
		return other.id === this.id && other.deviceId === this.deviceId
	}
}

/* ------------------------------------------------------------------ */
/* job queue (serializes session I/O per address)                      */
/* ------------------------------------------------------------------ */

const _queueAsyncBuckets = new Map()
const _gcLimit = 10000

async function _asyncQueueExecutor(queue, cleanup) {
	let offt = 0
	while (true) {
		const limit = Math.min(queue.length, _gcLimit) // Break up thundering herds for GC duty.
		for (let i = offt; i < limit; i++) {
			const job = queue[i]
			try {
				job.resolve(await job.awaitable())
			} catch (e) {
				job.reject(e)
			}
		}
		if (limit < queue.length) {
			/* Perform lazy GC of queue for faster iteration. */
			if (limit >= _gcLimit) {
				queue.splice(0, limit)
				offt = 0
			} else {
				offt = limit
			}
		} else {
			break
		}
	}
	cleanup()
}

const queueJob = (bucket, awaitable) => {
	let inactive
	if (!_queueAsyncBuckets.has(bucket)) {
		_queueAsyncBuckets.set(bucket, [])
		inactive = true
	}
	const queue = _queueAsyncBuckets.get(bucket)
	const job = new Promise((resolve, reject) => queue.push({ awaitable, resolve, reject }))
	if (inactive) _asyncQueueExecutor(queue, () => _queueAsyncBuckets.delete(bucket))
	return job
}

/* ------------------------------------------------------------------ */
/* SessionRecord / SessionEntry                                        */
/* ------------------------------------------------------------------ */

const BaseKeyType = { OURS: 1, THEIRS: 2 }
const ChainType = { SENDING: 1, RECEIVING: 2 }
const CLOSED_SESSIONS_MAX = 40
const SESSION_RECORD_VERSION = 'v1'

const assertBufferType = value => {
	if (!Buffer.isBuffer(value)) throw new TypeError('Buffer required')
}

class SessionEntry {
	constructor() {
		this._chains = {}
	}
	toString() {
		const baseKey = this.indexInfo && this.indexInfo.baseKey && this.indexInfo.baseKey.toString('base64')
		return `<SessionEntry [baseKey=${baseKey}]>`
	}
	inspect() {
		return this.toString()
	}
	addChain(key, value) {
		assertBufferType(key)
		const id = key.toString('base64')
		if (Object.prototype.hasOwnProperty.call(this._chains, id)) throw new Error('Overwrite attempt')
		this._chains[id] = value
	}
	getChain(key) {
		assertBufferType(key)
		return this._chains[key.toString('base64')]
	}
	deleteChain(key) {
		assertBufferType(key)
		const id = key.toString('base64')
		if (!Object.prototype.hasOwnProperty.call(this._chains, id)) throw new ReferenceError('Not Found')
		delete this._chains[id]
	}
	*chains() {
		for (const [k, v] of Object.entries(this._chains)) yield [Buffer.from(k, 'base64'), v]
	}
	serialize() {
		const data = {
			registrationId: this.registrationId,
			currentRatchet: {
				ephemeralKeyPair: {
					pubKey: this.currentRatchet.ephemeralKeyPair.pubKey.toString('base64'),
					privKey: this.currentRatchet.ephemeralKeyPair.privKey.toString('base64')
				},
				lastRemoteEphemeralKey: this.currentRatchet.lastRemoteEphemeralKey.toString('base64'),
				previousCounter: this.currentRatchet.previousCounter,
				rootKey: this.currentRatchet.rootKey.toString('base64')
			},
			indexInfo: {
				baseKey: this.indexInfo.baseKey.toString('base64'),
				baseKeyType: this.indexInfo.baseKeyType,
				closed: this.indexInfo.closed,
				used: this.indexInfo.used,
				created: this.indexInfo.created,
				remoteIdentityKey: this.indexInfo.remoteIdentityKey.toString('base64')
			},
			_chains: this._serialize_chains(this._chains)
		}
		if (this.pendingPreKey) {
			data.pendingPreKey = Object.assign({}, this.pendingPreKey)
			data.pendingPreKey.baseKey = this.pendingPreKey.baseKey.toString('base64')
		}
		return data
	}
	static deserialize(data) {
		const obj = new this()
		obj.registrationId = data.registrationId
		obj.currentRatchet = {
			ephemeralKeyPair: {
				pubKey: Buffer.from(data.currentRatchet.ephemeralKeyPair.pubKey, 'base64'),
				privKey: Buffer.from(data.currentRatchet.ephemeralKeyPair.privKey, 'base64')
			},
			lastRemoteEphemeralKey: Buffer.from(data.currentRatchet.lastRemoteEphemeralKey, 'base64'),
			previousCounter: data.currentRatchet.previousCounter,
			rootKey: Buffer.from(data.currentRatchet.rootKey, 'base64')
		}
		obj.indexInfo = {
			baseKey: Buffer.from(data.indexInfo.baseKey, 'base64'),
			baseKeyType: data.indexInfo.baseKeyType,
			closed: data.indexInfo.closed,
			used: data.indexInfo.used,
			created: data.indexInfo.created,
			remoteIdentityKey: Buffer.from(data.indexInfo.remoteIdentityKey, 'base64')
		}
		obj._chains = this._deserialize_chains(data._chains)
		if (data.pendingPreKey) {
			obj.pendingPreKey = Object.assign({}, data.pendingPreKey)
			obj.pendingPreKey.baseKey = Buffer.from(data.pendingPreKey.baseKey, 'base64')
		}
		return obj
	}
	_serialize_chains(chains) {
		const r = {}
		for (const key of Object.keys(chains)) {
			const c = chains[key]
			const messageKeys = {}
			for (const [idx, mk] of Object.entries(c.messageKeys)) messageKeys[idx] = mk.toString('base64')
			r[key] = {
				chainKey: { counter: c.chainKey.counter, key: c.chainKey.key && c.chainKey.key.toString('base64') },
				chainType: c.chainType,
				messageKeys
			}
		}
		return r
	}
	static _deserialize_chains(chains_data) {
		const r = {}
		for (const key of Object.keys(chains_data)) {
			const c = chains_data[key]
			const messageKeys = {}
			for (const [idx, mk] of Object.entries(c.messageKeys)) messageKeys[idx] = Buffer.from(mk, 'base64')
			r[key] = {
				chainKey: { counter: c.chainKey.counter, key: c.chainKey.key && Buffer.from(c.chainKey.key, 'base64') },
				chainType: c.chainType,
				messageKeys
			}
		}
		return r
	}
}

const migrations = [
	{
		version: 'v1',
		migrate: function migrateV1(data) {
			const sessions = data._sessions
			if (data.registrationId) {
				for (const key in sessions) {
					if (!sessions[key].registrationId) sessions[key].registrationId = data.registrationId
				}
			} else {
				for (const key in sessions) {
					if (sessions[key].indexInfo.closed === -1) {
						console.error('V1 session storage migration error: registrationId', data.registrationId, 'for open session version', data.version)
					}
				}
			}
		}
	}
]

export class SessionRecord {
	static createEntry() {
		return new SessionEntry()
	}
	static migrate(data) {
		let run = data.version === undefined
		for (let i = 0; i < migrations.length; ++i) {
			if (run) {
				console.info('Migrating session to:', migrations[i].version)
				migrations[i].migrate(data)
			} else if (migrations[i].version === data.version) {
				run = true
			}
		}
		if (!run) throw new Error('Error migrating SessionRecord')
	}
	static deserialize(data) {
		if (data.version !== SESSION_RECORD_VERSION) this.migrate(data)
		const obj = new this()
		if (data._sessions) {
			for (const [key, entry] of Object.entries(data._sessions)) obj.sessions[key] = SessionEntry.deserialize(entry)
		}
		return obj
	}
	constructor() {
		this.sessions = {}
		this.version = SESSION_RECORD_VERSION
	}
	serialize() {
		const _sessions = {}
		for (const [key, entry] of Object.entries(this.sessions)) _sessions[key] = entry.serialize()
		return { _sessions, version: this.version }
	}
	haveOpenSession() {
		const openSession = this.getOpenSession()
		return !!openSession && typeof openSession.registrationId === 'number'
	}
	getSession(key) {
		assertBufferType(key)
		const session = this.sessions[key.toString('base64')]
		if (session && session.indexInfo.baseKeyType === BaseKeyType.OURS) {
			throw new Error('Tried to lookup a session using our basekey')
		}
		return session
	}
	getOpenSession() {
		for (const session of Object.values(this.sessions)) {
			if (!this.isClosed(session)) return session
		}
	}
	setSession(session) {
		this.sessions[session.indexInfo.baseKey.toString('base64')] = session
	}
	getSessions() {
		// Return sessions ordered with most recently used first.
		return Array.from(Object.values(this.sessions)).sort((a, b) => {
			const aUsed = a.indexInfo.used || 0
			const bUsed = b.indexInfo.used || 0
			return aUsed === bUsed ? 0 : aUsed < bUsed ? 1 : -1
		})
	}
	closeSession(session) {
		if (this.isClosed(session)) {
			console.warn('Session already closed', session)
			return
		}
		console.info('Closing session:', session)
		session.indexInfo.closed = Date.now()
	}
	openSession(session) {
		if (!this.isClosed(session)) console.warn('Session already open')
		console.info('Opening session:', session)
		session.indexInfo.closed = -1
	}
	isClosed(session) {
		return session.indexInfo.closed !== -1
	}
	removeOldSessions() {
		while (Object.keys(this.sessions).length > CLOSED_SESSIONS_MAX) {
			let oldestKey
			let oldestSession
			for (const [key, session] of Object.entries(this.sessions)) {
				if (session.indexInfo.closed !== -1 && (!oldestSession || session.indexInfo.closed < oldestSession.indexInfo.closed)) {
					oldestKey = key
					oldestSession = session
				}
			}
			if (oldestKey) {
				console.info('Removing old closed session:', oldestSession)
				delete this.sessions[oldestKey]
			} else {
				throw new Error('Corrupt sessions object')
			}
		}
	}
	deleteAllSessions() {
		for (const key of Object.keys(this.sessions)) delete this.sessions[key]
	}
}

/* ------------------------------------------------------------------ */
/* SessionBuilder (X3DH)                                               */
/* ------------------------------------------------------------------ */

export class SessionBuilder {
	constructor(storage, protocolAddress) {
		this.addr = protocolAddress
		this.storage = storage
	}

	async initOutgoing(device) {
		const fqAddr = this.addr.toString()
		return await queueJob(fqAddr, async () => {
			if (!(await this.storage.isTrustedIdentity(this.addr.id, device.identityKey))) {
				throw new UntrustedIdentityKeyError(this.addr.id, device.identityKey)
			}
			curve.verifySignature(device.identityKey, device.signedPreKey.publicKey, device.signedPreKey.signature, true)
			const baseKey = curve.generateKeyPair()
			const devicePreKey = device.preKey && device.preKey.publicKey
			const session = await this.initSession(
				true,
				baseKey,
				undefined,
				device.identityKey,
				devicePreKey,
				device.signedPreKey.publicKey,
				device.registrationId
			)
			session.pendingPreKey = { signedKeyId: device.signedPreKey.keyId, baseKey: baseKey.pubKey }
			if (device.preKey) session.pendingPreKey.preKeyId = device.preKey.keyId
			let record = await this.storage.loadSession(fqAddr)
			if (!record) {
				record = new SessionRecord()
			} else {
				const openSession = record.getOpenSession()
				if (openSession) record.closeSession(openSession)
			}
			record.setSession(session)
			await this.storage.storeSession(fqAddr, record)
		})
	}

	async initIncoming(record, message) {
		const fqAddr = this.addr.toString()
		if (!(await this.storage.isTrustedIdentity(fqAddr, message.identityKey))) {
			throw new UntrustedIdentityKeyError(this.addr.id, message.identityKey)
		}
		if (record.getSession(message.baseKey)) {
			// This just means we haven't replied.
			return
		}
		const preKeyPair = await this.storage.loadPreKey(message.preKeyId)
		if (message.preKeyId && !preKeyPair) throw new PreKeyError('Invalid PreKey ID')
		const signedPreKeyPair = await this.storage.loadSignedPreKey(message.signedPreKeyId)
		if (!signedPreKeyPair) throw new PreKeyError('Missing SignedPreKey')
		const existingOpenSession = record.getOpenSession()
		if (existingOpenSession) {
			console.warn('Closing open session in favor of incoming prekey bundle')
			record.closeSession(existingOpenSession)
		}
		record.setSession(
			await this.initSession(false, preKeyPair, signedPreKeyPair, message.identityKey, message.baseKey, undefined, message.registrationId)
		)
		return message.preKeyId
	}

	async initSession(isInitiator, ourEphemeralKey, ourSignedKey, theirIdentityPubKey, theirEphemeralPubKey, theirSignedPubKey, registrationId) {
		if (isInitiator) {
			if (ourSignedKey) throw new Error('Invalid call to initSession')
			ourSignedKey = ourEphemeralKey
		} else {
			if (theirSignedPubKey) throw new Error('Invalid call to initSession')
			theirSignedPubKey = theirEphemeralPubKey
		}
		let sharedSecret
		if (!ourEphemeralKey || !theirEphemeralPubKey) sharedSecret = new Uint8Array(32 * 4)
		else sharedSecret = new Uint8Array(32 * 5)
		for (let i = 0; i < 32; i++) sharedSecret[i] = 0xff
		const ourIdentityKey = await this.storage.getOurIdentity()
		const a1 = curve.calculateAgreement(theirSignedPubKey, ourIdentityKey.privKey)
		const a2 = curve.calculateAgreement(theirIdentityPubKey, ourSignedKey.privKey)
		const a3 = curve.calculateAgreement(theirSignedPubKey, ourSignedKey.privKey)
		if (isInitiator) {
			sharedSecret.set(new Uint8Array(a1), 32)
			sharedSecret.set(new Uint8Array(a2), 32 * 2)
		} else {
			sharedSecret.set(new Uint8Array(a1), 32 * 2)
			sharedSecret.set(new Uint8Array(a2), 32)
		}
		sharedSecret.set(new Uint8Array(a3), 32 * 3)
		if (ourEphemeralKey && theirEphemeralPubKey) {
			const a4 = curve.calculateAgreement(theirEphemeralPubKey, ourEphemeralKey.privKey)
			sharedSecret.set(new Uint8Array(a4), 32 * 4)
		}
		const masterKey = crypto.deriveSecrets(Buffer.from(sharedSecret), Buffer.alloc(32), Buffer.from('WhisperText'))
		const session = SessionRecord.createEntry()
		session.registrationId = registrationId
		session.currentRatchet = {
			rootKey: masterKey[0],
			ephemeralKeyPair: isInitiator ? curve.generateKeyPair() : ourSignedKey,
			lastRemoteEphemeralKey: theirSignedPubKey,
			previousCounter: 0
		}
		session.indexInfo = {
			created: Date.now(),
			used: Date.now(),
			remoteIdentityKey: theirIdentityPubKey,
			baseKey: isInitiator ? ourEphemeralKey.pubKey : theirEphemeralPubKey,
			baseKeyType: isInitiator ? BaseKeyType.OURS : BaseKeyType.THEIRS,
			closed: -1
		}
		if (isInitiator) {
			// If we're initiating we go ahead and set our first sending ephemeral key now,
			// otherwise we figure it out when we first maybeStepRatchet with the remote's ephemeral key
			this.calculateSendingRatchet(session, theirSignedPubKey)
		}
		return session
	}

	calculateSendingRatchet(session, remoteKey) {
		const ratchet = session.currentRatchet
		const sharedSecret = curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey)
		const masterKey = crypto.deriveSecrets(sharedSecret, ratchet.rootKey, Buffer.from('WhisperRatchet'))
		session.addChain(ratchet.ephemeralKeyPair.pubKey, {
			messageKeys: {},
			chainKey: { counter: -1, key: masterKey[1] },
			chainType: ChainType.SENDING
		})
		ratchet.rootKey = masterKey[0]
	}
}

/* ------------------------------------------------------------------ */
/* SessionCipher (Double Ratchet)                                      */
/* ------------------------------------------------------------------ */

const VERSION = 3

export class SessionCipher {
	constructor(storage, protocolAddress) {
		if (!(protocolAddress instanceof ProtocolAddress)) throw new TypeError('protocolAddress must be a ProtocolAddress')
		this.addr = protocolAddress
		this.storage = storage
	}

	_encodeTupleByte(number1, number2) {
		if (number1 > 15 || number2 > 15) throw TypeError('Numbers must be 4 bits or less')
		return (number1 << 4) | number2
	}

	_decodeTupleByte(byte) {
		return [byte >> 4, byte & 0xf]
	}

	toString() {
		return `<SessionCipher(${this.addr.toString()})>`
	}

	async getRecord() {
		const record = await this.storage.loadSession(this.addr.toString())
		if (record && !(record instanceof SessionRecord)) throw new TypeError('SessionRecord type expected from loadSession')
		return record
	}

	async storeRecord(record) {
		record.removeOldSessions()
		await this.storage.storeSession(this.addr.toString(), record)
	}

	async queueJob(awaitable) {
		return await queueJob(this.addr.toString(), awaitable)
	}

	async encrypt(data) {
		assertBuffer(data)
		const ourIdentityKey = await this.storage.getOurIdentity()
		return await this.queueJob(async () => {
			const record = await this.getRecord()
			if (!record) throw new SessionError('No sessions')
			const session = record.getOpenSession()
			if (!session) throw new SessionError('No open session')
			const remoteIdentityKey = session.indexInfo.remoteIdentityKey
			if (!(await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey))) {
				throw new UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey)
			}
			const chain = session.getChain(session.currentRatchet.ephemeralKeyPair.pubKey)
			if (chain.chainType === ChainType.RECEIVING) throw new Error('Tried to encrypt on a receiving chain')
			this.fillMessageKeys(chain, chain.chainKey.counter + 1)
			const keys = crypto.deriveSecrets(chain.messageKeys[chain.chainKey.counter], Buffer.alloc(32), Buffer.from('WhisperMessageKeys'))
			delete chain.messageKeys[chain.chainKey.counter]
			const msg = WhisperMessage.create()
			msg.ephemeralKey = session.currentRatchet.ephemeralKeyPair.pubKey
			msg.counter = chain.chainKey.counter
			msg.previousCounter = session.currentRatchet.previousCounter
			msg.ciphertext = crypto.encrypt(keys[0], data, keys[2].slice(0, 16))
			const msgBuf = WhisperMessage.encode(msg).finish()
			const macInput = Buffer.alloc(msgBuf.byteLength + 33 * 2 + 1)
			macInput.set(ourIdentityKey.pubKey)
			macInput.set(session.indexInfo.remoteIdentityKey, 33)
			macInput[33 * 2] = this._encodeTupleByte(VERSION, VERSION)
			macInput.set(msgBuf, 33 * 2 + 1)
			const mac = crypto.calculateMAC(keys[1], macInput)
			const result = Buffer.alloc(msgBuf.byteLength + 9)
			result[0] = this._encodeTupleByte(VERSION, VERSION)
			result.set(msgBuf, 1)
			result.set(mac.slice(0, 8), msgBuf.byteLength + 1)
			await this.storeRecord(record)
			let type, body
			if (session.pendingPreKey) {
				type = 3 // prekey bundle
				const preKeyMsg = PreKeyWhisperMessage.create({
					identityKey: ourIdentityKey.pubKey,
					registrationId: await this.storage.getOurRegistrationId(),
					baseKey: session.pendingPreKey.baseKey,
					signedPreKeyId: session.pendingPreKey.signedKeyId,
					message: result
				})
				if (session.pendingPreKey.preKeyId) preKeyMsg.preKeyId = session.pendingPreKey.preKeyId
				body = Buffer.concat([
					Buffer.from([this._encodeTupleByte(VERSION, VERSION)]),
					Buffer.from(PreKeyWhisperMessage.encode(preKeyMsg).finish())
				])
			} else {
				type = 1 // normal
				body = result
			}
			return { type, body, registrationId: session.registrationId }
		})
	}

	async decryptWithSessions(data, sessions) {
		// Iterate through the sessions, attempting to decrypt using each one.
		// Stop and return the result if we get a valid result.
		if (!sessions.length) throw new SessionError('No sessions available')
		const errs = []
		for (const session of sessions) {
			let plaintext
			try {
				plaintext = await this.doDecryptWhisperMessage(data, session)
				session.indexInfo.used = Date.now()
				return { session, plaintext }
			} catch (e) {
				errs.push(e)
			}
		}
		console.error('Failed to decrypt message with any known session...')
		for (const e of errs) console.error('Session error:' + e, e.stack)
		throw new SessionError('No matching sessions found for message')
	}

	async decryptWhisperMessage(data) {
		assertBuffer(data)
		return await this.queueJob(async () => {
			const record = await this.getRecord()
			if (!record) throw new SessionError('No session record')
			const result = await this.decryptWithSessions(data, record.getSessions())
			const remoteIdentityKey = result.session.indexInfo.remoteIdentityKey
			if (!(await this.storage.isTrustedIdentity(this.addr.id, remoteIdentityKey))) {
				throw new UntrustedIdentityKeyError(this.addr.id, remoteIdentityKey)
			}
			if (record.isClosed(result.session)) {
				// It's possible for this to happen when processing a backlog of messages.
				console.warn('Decrypted message with closed session.')
			}
			await this.storeRecord(record)
			return result.plaintext
		})
	}

	async decryptPreKeyWhisperMessage(data) {
		assertBuffer(data)
		const versions = this._decodeTupleByte(data[0])
		if (versions[1] > 3 || versions[0] < 3) throw new Error('Incompatible version number on PreKeyWhisperMessage')
		return await this.queueJob(async () => {
			let record = await this.getRecord()
			const preKeyProto = PreKeyWhisperMessage.decode(data.slice(1))
			if (!record) {
				if (preKeyProto.registrationId == null) throw new Error('No registrationId')
				record = new SessionRecord()
			}
			const builder = new SessionBuilder(this.storage, this.addr)
			const preKeyId = await builder.initIncoming(record, preKeyProto)
			const session = record.getSession(preKeyProto.baseKey)
			const plaintext = await this.doDecryptWhisperMessage(preKeyProto.message, session)
			await this.storeRecord(record)
			if (preKeyId) await this.storage.removePreKey(preKeyId)
			return plaintext
		})
	}

	async doDecryptWhisperMessage(messageBuffer, session) {
		assertBuffer(messageBuffer)
		if (!session) throw new TypeError('session required')
		const versions = this._decodeTupleByte(messageBuffer[0])
		if (versions[1] > 3 || versions[0] < 3) throw new Error('Incompatible version number on WhisperMessage')
		const messageProto = messageBuffer.slice(1, -8)
		const message = WhisperMessage.decode(messageProto)
		this.maybeStepRatchet(session, message.ephemeralKey, message.previousCounter)
		const chain = session.getChain(message.ephemeralKey)
		if (chain.chainType === ChainType.SENDING) throw new Error('Tried to decrypt on a sending chain')
		this.fillMessageKeys(chain, message.counter)
		if (!Object.prototype.hasOwnProperty.call(chain.messageKeys, message.counter)) {
			// Most likely the message was already decrypted and we are trying to process twice.
			throw new MessageCounterError('Key used already or never filled')
		}
		const messageKey = chain.messageKeys[message.counter]
		delete chain.messageKeys[message.counter]
		const keys = crypto.deriveSecrets(messageKey, Buffer.alloc(32), Buffer.from('WhisperMessageKeys'))
		const ourIdentityKey = await this.storage.getOurIdentity()
		const macInput = Buffer.alloc(messageProto.byteLength + 33 * 2 + 1)
		macInput.set(session.indexInfo.remoteIdentityKey)
		macInput.set(ourIdentityKey.pubKey, 33)
		macInput[33 * 2] = this._encodeTupleByte(VERSION, VERSION)
		macInput.set(messageProto, 33 * 2 + 1)
		// This is where we most likely fail if the session is not a match.
		crypto.verifyMAC(macInput, keys[1], messageBuffer.slice(-8), 8)
		const plaintext = crypto.decrypt(keys[0], message.ciphertext, keys[2].slice(0, 16))
		delete session.pendingPreKey
		return plaintext
	}

	fillMessageKeys(chain, counter) {
		if (chain.chainKey.counter >= counter) return
		if (counter - chain.chainKey.counter > 2000) throw new SessionError('Over 2000 messages into the future!')
		if (chain.chainKey.key === undefined) throw new SessionError('Chain closed')
		const key = chain.chainKey.key
		chain.messageKeys[chain.chainKey.counter + 1] = crypto.calculateMAC(key, Buffer.from([1]))
		chain.chainKey.key = crypto.calculateMAC(key, Buffer.from([2]))
		chain.chainKey.counter += 1
		return this.fillMessageKeys(chain, counter)
	}

	maybeStepRatchet(session, remoteKey, previousCounter) {
		if (session.getChain(remoteKey)) return
		const ratchet = session.currentRatchet
		const previousRatchet = session.getChain(ratchet.lastRemoteEphemeralKey)
		if (previousRatchet) {
			this.fillMessageKeys(previousRatchet, previousCounter)
			delete previousRatchet.chainKey.key // Close
		}
		this.calculateRatchet(session, remoteKey, false)
		// Now swap the ephemeral key and calculate the new sending chain
		const prevCounter = session.getChain(ratchet.ephemeralKeyPair.pubKey)
		if (prevCounter) {
			ratchet.previousCounter = prevCounter.chainKey.counter
			session.deleteChain(ratchet.ephemeralKeyPair.pubKey)
		}
		ratchet.ephemeralKeyPair = curve.generateKeyPair()
		this.calculateRatchet(session, remoteKey, true)
		ratchet.lastRemoteEphemeralKey = remoteKey
	}

	calculateRatchet(session, remoteKey, sending) {
		const ratchet = session.currentRatchet
		const sharedSecret = curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey)
		const masterKey = crypto.deriveSecrets(sharedSecret, ratchet.rootKey, Buffer.from('WhisperRatchet'), /*chunks*/ 2)
		const chainKey = sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey
		session.addChain(chainKey, {
			messageKeys: {},
			chainKey: { counter: -1, key: masterKey[1] },
			chainType: sending ? ChainType.SENDING : ChainType.RECEIVING
		})
		ratchet.rootKey = masterKey[0]
	}

	async hasOpenSession() {
		return await this.queueJob(async () => {
			const record = await this.getRecord()
			if (!record) return false
			return record.haveOpenSession()
		})
	}

	async closeOpenSession() {
		return await this.queueJob(async () => {
			const record = await this.getRecord()
			if (record) {
				const openSession = record.getOpenSession()
				if (openSession) {
					record.closeSession(openSession)
					await this.storeRecord(record)
				}
			}
		})
	}
}

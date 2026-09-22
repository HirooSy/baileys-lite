/**
 * Signal protocol "Sender Key" group-messaging implementation.
 * Combines what used to be 12 separate files under Signal/Group/.
 *
 * Cryptographic primitives (encrypt/decrypt/MAC/signature/key derivation)
 * come from the native ./libsignal.js port (no npm dependency).
 */
import * as nodeCrypto from 'node:crypto'
import { crypto as signalCrypto, curve as signalCurve } from './libsignal.js'

const { calculateMAC, decrypt, deriveSecrets, encrypt } = signalCrypto
const { calculateSignature, generateKeyPair, verifySignature } = signalCurve
import { proto } from '../../WAProto/index.js'
import { BufferJSON } from '../utils/wa-protocol-core.js'

/* ------------------------------------------------------------------ */
/* CiphertextMessage — shared constants base class                     */
/* ------------------------------------------------------------------ */

export class CiphertextMessage {
	constructor() {
		this.UNSUPPORTED_VERSION = 1
		this.CURRENT_VERSION = 3
		this.WHISPER_TYPE = 2
		this.PREKEY_TYPE = 3
		this.SENDERKEY_TYPE = 4
		this.SENDERKEY_DISTRIBUTION_TYPE = 5
		this.ENCRYPTED_MESSAGE_OVERHEAD = 53
	}
}

/* ------------------------------------------------------------------ */
/* keyhelper                                                           */
/* ------------------------------------------------------------------ */

export const keyhelper = {
	generateSenderKey() {
		return nodeCrypto.randomBytes(32)
	},
	generateSenderKeyId() {
		return nodeCrypto.randomInt(2147483647)
	},
	generateSenderSigningKey(key) {
		if (!key) key = generateKeyPair()
		return {
			public: Buffer.from(key.pubKey),
			private: Buffer.from(key.privKey)
		}
	}
}

/* ------------------------------------------------------------------ */
/* SenderKeyName                                                       */
/* ------------------------------------------------------------------ */

function isNull(str) {
	return str === null || str === ''
}
function intValue(num) {
	const MAX_VALUE = 0x7fffffff
	const MIN_VALUE = -0x80000000
	if (num > MAX_VALUE || num < MIN_VALUE) return num & 0xffffffff
	return num
}
function hashCode(strKey) {
	let hash = 0
	if (!isNull(strKey)) {
		for (let i = 0; i < strKey.length; i++) {
			hash = hash * 31 + strKey.charCodeAt(i)
			hash = intValue(hash)
		}
	}
	return hash
}

export class SenderKeyName {
	constructor(groupId, sender) {
		this.groupId = groupId
		this.sender = sender
	}
	getGroupId() {
		return this.groupId
	}
	getSender() {
		return this.sender
	}
	serialize() {
		return `${this.groupId}::${this.sender.id}::${this.sender.deviceId}`
	}
	toString() {
		return this.serialize()
	}
	equals(other) {
		if (other === null) return false
		return this.groupId === other.groupId && this.sender.toString() === other.sender.toString()
	}
	hashCode() {
		return hashCode(this.groupId) ^ hashCode(this.sender.toString())
	}
}

/* ------------------------------------------------------------------ */
/* SenderMessageKey / SenderChainKey                                   */
/* ------------------------------------------------------------------ */

export class SenderMessageKey {
	constructor(iteration, seed) {
		const derivative = deriveSecrets(seed, Buffer.alloc(32), Buffer.from('WhisperGroup'))
		const keys = new Uint8Array(32)
		keys.set(new Uint8Array(derivative[0].slice(16)))
		keys.set(new Uint8Array(derivative[1].slice(0, 16)), 16)
		this.iv = Buffer.from(derivative[0].slice(0, 16))
		this.cipherKey = Buffer.from(keys.buffer)
		this.iteration = iteration
		this.seed = seed
	}
	getIteration() {
		return this.iteration
	}
	getIv() {
		return this.iv
	}
	getCipherKey() {
		return this.cipherKey
	}
	getSeed() {
		return this.seed
	}
}

export class SenderChainKey {
	constructor(iteration, chainKey) {
		this.MESSAGE_KEY_SEED = Buffer.from([0x01])
		this.CHAIN_KEY_SEED = Buffer.from([0x02])
		this.iteration = iteration
		this.chainKey = Buffer.from(chainKey)
	}
	getIteration() {
		return this.iteration
	}
	getSenderMessageKey() {
		return new SenderMessageKey(this.iteration, this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey))
	}
	getNext() {
		return new SenderChainKey(this.iteration + 1, this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey))
	}
	getSeed() {
		return this.chainKey
	}
	getDerivative(seed, key) {
		return calculateMAC(key, seed)
	}
}

/* ------------------------------------------------------------------ */
/* SenderKeyState / SenderKeyRecord                                    */
/* ------------------------------------------------------------------ */

export class SenderKeyState {
	constructor(id, iteration, chainKey, signatureKeyPair, signatureKeyPublic, signatureKeyPrivate, senderKeyStateStructure) {
		this.MAX_MESSAGE_KEYS = 2000
		if (senderKeyStateStructure) {
			this.senderKeyStateStructure = {
				...senderKeyStateStructure,
				senderMessageKeys: Array.isArray(senderKeyStateStructure.senderMessageKeys) ? senderKeyStateStructure.senderMessageKeys : []
			}
		} else {
			if (signatureKeyPair) {
				signatureKeyPublic = signatureKeyPair.public
				signatureKeyPrivate = signatureKeyPair.private
			}
			this.senderKeyStateStructure = {
				senderKeyId: id || 0,
				senderChainKey: {
					iteration: iteration || 0,
					seed: Buffer.from(chainKey || [])
				},
				senderSigningKey: {
					public: Buffer.from(signatureKeyPublic || []),
					private: Buffer.from(signatureKeyPrivate || [])
				},
				senderMessageKeys: []
			}
		}
	}
	getKeyId() {
		return this.senderKeyStateStructure.senderKeyId
	}
	getSenderChainKey() {
		return new SenderChainKey(this.senderKeyStateStructure.senderChainKey.iteration, this.senderKeyStateStructure.senderChainKey.seed)
	}
	setSenderChainKey(chainKey) {
		this.senderKeyStateStructure.senderChainKey = {
			iteration: chainKey.getIteration(),
			seed: chainKey.getSeed()
		}
	}
	getSigningKeyPublic() {
		const publicKey = Buffer.from(this.senderKeyStateStructure.senderSigningKey.public)
		if (publicKey.length === 32) {
			const fixed = Buffer.alloc(33)
			fixed[0] = 0x05
			publicKey.copy(fixed, 1)
			return fixed
		}
		return publicKey
	}
	getSigningKeyPrivate() {
		const privateKey = this.senderKeyStateStructure.senderSigningKey.private
		return Buffer.from(privateKey || [])
	}
	hasSenderMessageKey(iteration) {
		return this.senderKeyStateStructure.senderMessageKeys.some(key => key.iteration === iteration)
	}
	addSenderMessageKey(senderMessageKey) {
		this.senderKeyStateStructure.senderMessageKeys.push({
			iteration: senderMessageKey.getIteration(),
			seed: senderMessageKey.getSeed()
		})
		if (this.senderKeyStateStructure.senderMessageKeys.length > this.MAX_MESSAGE_KEYS) {
			this.senderKeyStateStructure.senderMessageKeys.shift()
		}
	}
	removeSenderMessageKey(iteration) {
		const index = this.senderKeyStateStructure.senderMessageKeys.findIndex(key => key.iteration === iteration)
		if (index !== -1) {
			const messageKey = this.senderKeyStateStructure.senderMessageKeys[index]
			this.senderKeyStateStructure.senderMessageKeys.splice(index, 1)
			return new SenderMessageKey(messageKey.iteration, messageKey.seed)
		}
		return null
	}
	getStructure() {
		return this.senderKeyStateStructure
	}
}

export class SenderKeyRecord {
	constructor(serialized) {
		this.MAX_STATES = 5
		this.senderKeyStates = []
		if (serialized) {
			for (const structure of serialized) {
				this.senderKeyStates.push(new SenderKeyState(null, null, null, null, null, null, structure))
			}
		}
	}
	isEmpty() {
		return this.senderKeyStates.length === 0
	}
	getSenderKeyState(keyId) {
		if (keyId === undefined && this.senderKeyStates.length) {
			return this.senderKeyStates[this.senderKeyStates.length - 1]
		}
		return this.senderKeyStates.find(state => state.getKeyId() === keyId)
	}
	addSenderKeyState(id, iteration, chainKey, signatureKey) {
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, null, signatureKey))
		if (this.senderKeyStates.length > this.MAX_STATES) this.senderKeyStates.shift()
	}
	setSenderKeyState(id, iteration, chainKey, keyPair) {
		this.senderKeyStates.length = 0
		this.senderKeyStates.push(new SenderKeyState(id, iteration, chainKey, keyPair))
	}
	serialize() {
		return this.senderKeyStates.map(state => state.getStructure())
	}
	static deserialize(data) {
		const str = Buffer.from(data).toString('utf-8')
		const parsed = JSON.parse(str, BufferJSON.reviver)
		return new SenderKeyRecord(parsed)
	}
}

/* ------------------------------------------------------------------ */
/* SenderKeyDistributionMessage / SenderKeyMessage (wire formats)      */
/* ------------------------------------------------------------------ */

export class SenderKeyDistributionMessage extends CiphertextMessage {
	constructor(id, iteration, chainKey, signatureKey, serialized) {
		super()
		if (serialized) {
			try {
				const message = serialized.slice(1)
				const distributionMessage = proto.SenderKeyDistributionMessage.decode(message).toJSON()
				this.serialized = serialized
				this.id = distributionMessage.id
				this.iteration = distributionMessage.iteration
				this.chainKey =
					typeof distributionMessage.chainKey === 'string' ? Buffer.from(distributionMessage.chainKey, 'base64') : distributionMessage.chainKey
				this.signatureKey =
					typeof distributionMessage.signingKey === 'string' ? Buffer.from(distributionMessage.signingKey, 'base64') : distributionMessage.signingKey
			} catch (e) {
				throw new Error(String(e))
			}
		} else {
			const version = this.intsToByteHighAndLow(this.CURRENT_VERSION, this.CURRENT_VERSION)
			this.id = id
			this.iteration = iteration
			this.chainKey = chainKey
			this.signatureKey = signatureKey
			const message = proto.SenderKeyDistributionMessage.encode(
				proto.SenderKeyDistributionMessage.create({ id, iteration, chainKey, signingKey: this.signatureKey })
			).finish()
			this.serialized = Buffer.concat([Buffer.from([version]), message])
		}
	}
	intsToByteHighAndLow(highValue, lowValue) {
		return (((highValue << 4) | lowValue) & 0xff) % 256
	}
	serialize() {
		return this.serialized
	}
	getType() {
		return this.SENDERKEY_DISTRIBUTION_TYPE
	}
	getIteration() {
		return this.iteration
	}
	getChainKey() {
		return this.chainKey
	}
	getSignatureKey() {
		return this.signatureKey
	}
	getId() {
		return this.id
	}
}

export class SenderKeyMessage extends CiphertextMessage {
	constructor(keyId, iteration, ciphertext, signatureKey, serialized) {
		super()
		this.SIGNATURE_LENGTH = 64
		if (serialized) {
			const version = serialized[0]
			const message = serialized.slice(1, serialized.length - this.SIGNATURE_LENGTH)
			const signature = serialized.slice(-1 * this.SIGNATURE_LENGTH)
			const senderKeyMessage = proto.SenderKeyMessage.decode(message).toJSON()
			this.serialized = serialized
			this.messageVersion = (version & 0xff) >> 4
			this.keyId = senderKeyMessage.id
			this.iteration = senderKeyMessage.iteration
			this.ciphertext =
				typeof senderKeyMessage.ciphertext === 'string' ? Buffer.from(senderKeyMessage.ciphertext, 'base64') : senderKeyMessage.ciphertext
			this.signature = signature
		} else {
			const version = (((this.CURRENT_VERSION << 4) | this.CURRENT_VERSION) & 0xff) % 256
			const ciphertextBuffer = Buffer.from(ciphertext)
			const message = proto.SenderKeyMessage.encode(
				proto.SenderKeyMessage.create({ id: keyId, iteration, ciphertext: ciphertextBuffer })
			).finish()
			const signature = this.getSignature(signatureKey, Buffer.concat([Buffer.from([version]), message]))
			this.serialized = Buffer.concat([Buffer.from([version]), message, Buffer.from(signature)])
			this.messageVersion = this.CURRENT_VERSION
			this.keyId = keyId
			this.iteration = iteration
			this.ciphertext = ciphertextBuffer
			this.signature = signature
		}
	}
	getKeyId() {
		return this.keyId
	}
	getIteration() {
		return this.iteration
	}
	getCipherText() {
		return this.ciphertext
	}
	verifySignature(signatureKey) {
		const part1 = this.serialized.slice(0, this.serialized.length - this.SIGNATURE_LENGTH)
		const part2 = this.serialized.slice(-1 * this.SIGNATURE_LENGTH)
		const res = verifySignature(signatureKey, part1, part2)
		if (!res) throw new Error('Invalid signature!')
	}
	getSignature(signatureKey, serialized) {
		return Buffer.from(calculateSignature(signatureKey, serialized))
	}
	serialize() {
		return this.serialized
	}
	getType() {
		return 4
	}
}

/* ------------------------------------------------------------------ */
/* GroupSessionBuilder / GroupCipher                                    */
/* ------------------------------------------------------------------ */

export class GroupSessionBuilder {
	constructor(senderKeyStore) {
		this.senderKeyStore = senderKeyStore
	}
	async process(senderKeyName, senderKeyDistributionMessage) {
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)
		senderKeyRecord.addSenderKeyState(
			senderKeyDistributionMessage.getId(),
			senderKeyDistributionMessage.getIteration(),
			senderKeyDistributionMessage.getChainKey(),
			senderKeyDistributionMessage.getSignatureKey()
		)
		await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
	}
	async create(senderKeyName) {
		const senderKeyRecord = await this.senderKeyStore.loadSenderKey(senderKeyName)
		if (senderKeyRecord.isEmpty()) {
			const keyId = keyhelper.generateSenderKeyId()
			const senderKey = keyhelper.generateSenderKey()
			const signingKey = keyhelper.generateSenderSigningKey()
			senderKeyRecord.setSenderKeyState(keyId, 0, senderKey, signingKey)
			await this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord)
		}
		const state = senderKeyRecord.getSenderKeyState()
		if (!state) throw new Error('No session state available')
		return new SenderKeyDistributionMessage(
			state.getKeyId(),
			state.getSenderChainKey().getIteration(),
			state.getSenderChainKey().getSeed(),
			state.getSigningKeyPublic()
		)
	}
}

export class GroupCipher {
	constructor(senderKeyStore, senderKeyName) {
		this.senderKeyStore = senderKeyStore
		this.senderKeyName = senderKeyName
	}
	async encrypt(paddedPlaintext) {
		const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
		if (!record) throw new Error('No SenderKeyRecord found for encryption')
		const senderKeyState = record.getSenderKeyState()
		if (!senderKeyState) throw new Error('No session to encrypt message')
		const iteration = senderKeyState.getSenderChainKey().getIteration()
		const senderKey = this.getSenderKey(senderKeyState, iteration === 0 ? 0 : iteration + 1)
		const ciphertext = await this.getCipherText(senderKey.getIv(), senderKey.getCipherKey(), paddedPlaintext)
		const senderKeyMessage = new SenderKeyMessage(senderKeyState.getKeyId(), senderKey.getIteration(), ciphertext, senderKeyState.getSigningKeyPrivate())
		await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
		return senderKeyMessage.serialize()
	}
	async decrypt(senderKeyMessageBytes) {
		const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
		if (!record) throw new Error('No SenderKeyRecord found for decryption')
		const senderKeyMessage = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes)
		const senderKeyState = record.getSenderKeyState(senderKeyMessage.getKeyId())
		if (!senderKeyState) throw new Error('No session found to decrypt message')
		senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic())
		const senderKey = this.getSenderKey(senderKeyState, senderKeyMessage.getIteration())
		const plaintext = await this.getPlainText(senderKey.getIv(), senderKey.getCipherKey(), senderKeyMessage.getCipherText())
		await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
		return plaintext
	}
	getSenderKey(senderKeyState, iteration) {
		let senderChainKey = senderKeyState.getSenderChainKey()
		if (senderChainKey.getIteration() > iteration) {
			if (senderKeyState.hasSenderMessageKey(iteration)) {
				const messageKey = senderKeyState.removeSenderMessageKey(iteration)
				if (!messageKey) throw new Error('No sender message key found for iteration')
				return messageKey
			}
			throw new Error(`Received message with old counter: ${senderChainKey.getIteration()}, ${iteration}`)
		}
		if (iteration - senderChainKey.getIteration() > 2000) throw new Error('Over 2000 messages into the future!')
		while (senderChainKey.getIteration() < iteration) {
			senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey())
			senderChainKey = senderChainKey.getNext()
		}
		senderKeyState.setSenderChainKey(senderChainKey.getNext())
		return senderChainKey.getSenderMessageKey()
	}
	async getPlainText(iv, key, ciphertext) {
		try {
			return decrypt(key, ciphertext, iv)
		} catch {
			throw new Error('InvalidMessageException')
		}
	}
	async getCipherText(iv, key, plaintext) {
		try {
			return encrypt(key, plaintext, iv)
		} catch {
			throw new Error('InvalidMessageException')
		}
	}
}

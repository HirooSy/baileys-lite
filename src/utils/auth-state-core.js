/**
 * Auth-state and message-decode utilities. Combines what used to be:
 *   auth-utils.js, pre-key-manager.js, identity-change-handler.js,
 *   decode-wa-message.js, tc-token-utils.js
 *
 * `async_hooks` (AsyncLocalStorage) is Node built-in, kept as-is.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { Boom } from '../foundation/boom.js'
import { Cache } from '../foundation/cache.js'
import { makeMutex, makeSerialTaskQueue, makeKeyedSerialTaskQueues } from '../foundation/concurrency.js'
import { proto } from '../../WAProto/index.js'
import {
	areJidsSameUser,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isHostedLidUser,
	isHostedPnUser,
	isJidBroadcast,
	isJidGroup,
	isJidMetaAI,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser
} from '../binary/wa-binary.js'
import { Curve, delay, generateRegistrationId, signedKeyPair, unpadRandomMax16 } from './wa-protocol-core.js'

const DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60,
	MSG_RETRY: 60 * 60,
	CALL_OFFER: 5 * 60,
	USER_DEVICES: 5 * 60
}

/* ------------------------------------------------------------------ */
/* PreKeyManager                                                       */
/* ------------------------------------------------------------------ */

/** Manages pre-key operations with proper concurrency control */
export class PreKeyManager {
	constructor(store, logger) {
		this.store = store
		this.logger = logger
		this.queues = makeKeyedSerialTaskQueues()
	}

	async processOperations(data, keyType, transactionCache, mutations, isInTransaction) {
		const keyData = data[keyType]
		if (!keyData) return
		return this.queues.get(keyType).add(async () => {
			transactionCache[keyType] = transactionCache[keyType] || {}
			mutations[keyType] = mutations[keyType] || {}

			const deletions = []
			const updates = {}
			for (const keyId in keyData) {
				if (keyData[keyId] === null) deletions.push(keyId)
				else updates[keyId] = keyData[keyId]
			}
			if (Object.keys(updates).length > 0) {
				Object.assign(transactionCache[keyType], updates)
				Object.assign(mutations[keyType], updates)
			}
			if (deletions.length > 0) {
				await this.processDeletions(keyType, deletions, transactionCache, mutations, isInTransaction)
			}
		})
	}

	async processDeletions(keyType, ids, transactionCache, mutations, isInTransaction) {
		if (isInTransaction) {
			for (const keyId of ids) {
				if (transactionCache[keyType]?.[keyId]) {
					transactionCache[keyType][keyId] = null
					mutations[keyType][keyId] = null
				} else {
					this.logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`)
				}
			}
		} else {
			const existingKeys = await this.store.get(keyType, ids)
			for (const keyId of ids) {
				if (existingKeys[keyId]) {
					transactionCache[keyType][keyId] = null
					mutations[keyType][keyId] = null
				} else {
					this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
				}
			}
		}
	}

	/** Validate and process pre-key deletions outside transactions */
	async validateDeletions(data, keyType) {
		const keyData = data[keyType]
		if (!keyData) return
		return this.queues.get(keyType).add(async () => {
			const deletionIds = Object.keys(keyData).filter(id => keyData[id] === null)
			if (deletionIds.length === 0) return
			const existingKeys = await this.store.get(keyType, deletionIds)
			for (const keyId of deletionIds) {
				if (!existingKeys[keyId]) {
					this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
					delete data[keyType][keyId]
				}
			}
		})
	}
}

/* ------------------------------------------------------------------ */
/* Signal key store caching + transaction capability                   */
/* ------------------------------------------------------------------ */

// One instance per process: a per-socket AsyncLocalStorage leaks the heap under Node's legacy
// async-context propagation, where every live instance tags every pending async resource. The
// value is keyed by store token so a store only ever sees its own context, even when another
// wrapped store runs inside its transaction.
const txStorage = new AsyncLocalStorage()

/** Adds caching capability to a SignalKeyStore */
export function makeCacheableSignalKeyStore(store, logger, _cache) {
	const cache = _cache || new Cache({ ttl: DEFAULT_CACHE_TTLS.SIGNAL_STORE * 1000 })
	const cacheMutex = makeMutex()

	function getUniqueId(type, id) {
		return `${type}.${id}`
	}

	return {
		async get(type, ids) {
			return cacheMutex.mutex(async () => {
				const data = {}
				const idsToFetch = []
				for (const id of ids) {
					const item = cache.get(getUniqueId(type, id))
					if (typeof item !== 'undefined') data[id] = item
					else idsToFetch.push(id)
				}
				if (idsToFetch.length) {
					logger?.trace({ items: idsToFetch.length }, 'loading from store')
					const fetched = await store.get(type, idsToFetch)
					for (const id of idsToFetch) {
						const item = fetched[id]
						if (item) {
							data[id] = item
							cache.set(getUniqueId(type, id), item)
						}
					}
				}
				return data
			})
		},
		async set(data) {
			return cacheMutex.mutex(async () => {
				let keys = 0
				for (const type in data) {
					for (const id in data[type]) {
						cache.set(getUniqueId(type, id), data[type][id])
						keys += 1
					}
				}
				logger?.trace({ keys }, 'updated cache')
				await store.set(data)
			})
		},
		async clear() {
			cache.clear()
			await store.clear?.()
		}
	}
}

/** Adds DB-like transaction capability to the SignalKeyStore, via AsyncLocalStorage context. */
export const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
	const keyQueues = new Map() // concurrency control per signal data type
	const txMutexes = new Map()
	const txMutexRefCounts = new Map()
	const preKeyManager = new PreKeyManager(state, logger)

	function getQueue(key) {
		if (!keyQueues.has(key)) keyQueues.set(key, makeSerialTaskQueue())
		return keyQueues.get(key)
	}
	function getTxMutex(key) {
		if (!txMutexes.has(key)) {
			txMutexes.set(key, makeMutex())
			txMutexRefCounts.set(key, 0)
		}
		return txMutexes.get(key)
	}
	function acquireTxMutexRef(key) {
		const count = txMutexRefCounts.get(key) ?? 0
		txMutexRefCounts.set(key, count + 1)
	}
	function releaseTxMutexRef(key) {
		const count = (txMutexRefCounts.get(key) ?? 1) - 1
		txMutexRefCounts.set(key, count)
		if (count <= 0) {
			txMutexes.delete(key)
			txMutexRefCounts.delete(key)
		}
	}
	function isInTransaction() {
		return !!txStorage.getStore()
	}
	async function commitWithRetry(mutations) {
		if (Object.keys(mutations).length === 0) {
			logger.trace('no mutations in transaction')
			return
		}
		logger.trace('committing transaction')
		for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
			try {
				await state.set(mutations)
				logger.trace({ mutationCount: Object.keys(mutations).length }, 'committed transaction')
				return
			} catch (error) {
				const retriesLeft = maxCommitRetries - attempt - 1
				logger.warn(`failed to commit mutations, retries left=${retriesLeft}`)
				if (retriesLeft === 0) throw error
				await delay(delayBetweenTriesMs)
			}
		}
	}

	return {
		get: async (type, ids) => {
			const ctx = txStorage.getStore()
			if (!ctx) return state.get(type, ids) // no transaction - direct read, no exclusive lock

			const cached = ctx.cache[type] || {}
			const missing = ids.filter(id => !(id in cached))
			if (missing.length > 0) {
				ctx.dbQueries++
				logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction')
				const fetched = await getTxMutex(type).mutex(() => state.get(type, missing))
				ctx.cache[type] = ctx.cache[type] || {}
				Object.assign(ctx.cache[type], fetched)
			}
			const result = {}
			for (const id of ids) {
				const value = ctx.cache[type]?.[id]
				if (value !== undefined && value !== null) result[id] = value
			}
			return result
		},
		set: async data => {
			const ctx = txStorage.getStore()
			if (!ctx) {
				// no transaction - direct write with per-type queue protection
				const types = Object.keys(data)
				for (const type of types) {
					if (type === 'pre-key') await preKeyManager.validateDeletions(data, type)
				}
				await Promise.all(
					types.map(type =>
						getQueue(type).add(async () => {
							await state.set({ [type]: data[type] })
						})
					)
				)
				return
			}
			logger.trace({ types: Object.keys(data) }, 'caching in transaction')
			for (const key in data) {
				ctx.cache[key] = ctx.cache[key] || {}
				ctx.mutations[key] = ctx.mutations[key] || {}
				if (key === 'pre-key') {
					await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true)
				} else {
					Object.assign(ctx.cache[key], data[key])
					Object.assign(ctx.mutations[key], data[key])
				}
			}
		},
		isInTransaction,
		transaction: async (work, key) => {
			const existing = txStorage.getStore()
			if (existing) {
				logger.trace('reusing existing transaction context')
				return work()
			}
			const mutex = getTxMutex(key)
			acquireTxMutexRef(key)
			try {
				return await mutex.mutex(async () => {
					const ctx = { cache: {}, mutations: {}, dbQueries: 0 }
					logger.trace('entering transaction')
					try {
						const result = await txStorage.run(ctx, work)
						await commitWithRetry(ctx.mutations)
						logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed')
						return result
					} catch (error) {
						logger.error({ error }, 'transaction failed, rolling back')
						throw error
					}
				})
			} finally {
				releaseTxMutexRef(key)
			}
		}
	}
}

/**
 * Returns the authenticated user's JID, or throws a Boom-401 if creds are not yet authenticated.
 */
export const assertMeId = creds => {
	const id = creds.me?.id
	if (!id) throw new Boom('Cannot proceed: socket is not authenticated yet (creds.me.id is missing)', { statusCode: 401 })
	return id
}

export const initAuthCreds = () => {
	const identityKey = Curve.generateKeyPair()
	return {
		noiseKey: Curve.generateKeyPair(),
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: { unarchiveChats: false },
		registered: false,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: undefined,
		additionalData: undefined
	}
}

/* ------------------------------------------------------------------ */
/* Identity change handling                                            */
/* ------------------------------------------------------------------ */

export async function handleIdentityChange(node, ctx) {
	const from = node.attrs.from
	if (!from) return { action: 'invalid_notification' }

	const identityNode = getBinaryNodeChild(node, 'identity')
	if (!identityNode) return { action: 'no_identity_node' }

	ctx.logger.info({ jid: from }, 'identity changed')
	const decoded = jidDecode(from)
	if (decoded?.device && decoded.device !== 0) {
		ctx.logger.debug({ jid: from, device: decoded.device }, 'ignoring identity change from companion device')
		return { action: 'skipped_companion_device', device: decoded.device }
	}

	const isSelfPrimary = ctx.meId && (areJidsSameUser(from, ctx.meId) || (ctx.meLid && areJidsSameUser(from, ctx.meLid)))
	if (isSelfPrimary) {
		ctx.logger.info({ jid: from }, 'self primary identity changed')
		return { action: 'skipped_self_primary' }
	}

	if (ctx.debounceCache.get(from)) {
		ctx.logger.debug({ jid: from }, 'skipping identity assert (debounced)')
		return { action: 'debounced' }
	}
	ctx.debounceCache.set(from, true)

	const isOfflineNotification = !isStringNullOrEmptyLocal(node.attrs.offline)
	const hasExistingSession = await ctx.validateSession(from)
	if (!hasExistingSession.exists) {
		ctx.logger.debug({ jid: from }, 'no old session, skipping session refresh')
		return { action: 'skipped_no_session' }
	}

	ctx.logger.debug({ jid: from }, 'old session exists, will refresh session')
	if (isOfflineNotification) {
		ctx.logger.debug({ jid: from }, 'skipping session refresh during offline processing')
		return { action: 'skipped_offline' }
	}

	ctx.onBeforeSessionRefresh?.(from)
	try {
		await ctx.assertSessions([from], true)
		return { action: 'session_refreshed' }
	} catch (error) {
		ctx.logger.warn({ error, jid: from }, 'failed to assert sessions after identity change')
		return { action: 'session_refresh_failed', error }
	}
}

function isStringNullOrEmptyLocal(value) {
	// eslint-disable-next-line eqeqeq
	return value == null || value === ''
}

/* ------------------------------------------------------------------ */
/* Message node decode / decrypt                                       */
/* ------------------------------------------------------------------ */

export const getDecryptionJid = async (sender, repository) => {
	if (isLidUser(sender) || isHostedLidUser(sender)) return sender
	const mapped = await repository.lidMapping.getLIDForPN(sender)
	return mapped || sender
}

const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger) => {
	const { senderAlt } = extractAddressingContext(stanza)
	if (senderAlt && isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
		try {
			await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
			await repository.migrateSession(sender, senderAlt)
			logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope')
		} catch (error) {
			logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping')
		}
	}
}

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'
export const ACCOUNT_RESTRICTED_TEXT = 'Your account has been restricted'

export const DECRYPTION_RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 100,
	sessionRecordErrors: ['No session record', 'SessionError: No session record']
}

/** NACK reason codes we send to the server (client → server) */
export const NACK_REASONS = {
	SenderReachoutTimelocked: 463,
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}

/** Server-side error codes returned in ack stanzas (server → client) with dedicated handlers. */
export const SERVER_ERROR_CODES = {
	MessageAccountRestriction: '463',
	SmaxInvalid: '479'
}

export const extractAddressingContext = stanza => {
	let senderAlt
	let recipientAlt
	const sender = stanza.attrs.participant || stanza.attrs.from
	const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')
	if (addressingMode === 'lid') {
		senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
		recipientAlt = stanza.attrs.recipient_pn
	} else {
		senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
		recipientAlt = stanza.attrs.recipient_lid
	}
	return { addressingMode, senderAlt, recipientAlt }
}

/** Decode the received node as a message. NOTE: this only parses the message, not decrypt. */
export function decodeMessageNode(stanza, meId, meLid) {
	let msgType
	let chatId
	let author
	let fromMe = false
	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant = stanza.attrs.participant
	const recipient = stanza.attrs.recipient

	if (!msgId) throw new Boom('Invalid message stanza: missing id attribute', { data: stanza })
	if (!from) throw new Boom('Invalid message stanza: missing from attribute', { data: stanza })

	const addressingContext = extractAddressingContext(stanza)
	const isMe = jid => areJidsSameUser(jid, meId)
	const isMeLid = jid => areJidsSameUser(jid, meLid)

	if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
		if (recipient && !isJidMetaAI(recipient)) {
			if (!isMe(from) && !isMeLid(from)) throw new Boom('receipient present, but msg not from me', { data: stanza })
			if (isMe(from) || isMeLid(from)) fromMe = true
			chatId = recipient
		} else {
			// Peer-routed self stanzas (history sync, app-state sync, etc.) arrive with `from` set to our
			// own device but no `recipient` attribute — still mark as fromMe so self-only handlers run.
			if (isMe(from) || isMeLid(from)) fromMe = true
			chatId = from
		}
		msgType = 'chat'
		author = from
	} else if (isJidGroup(from)) {
		if (!participant) throw new Boom('No participant in group message')
		if (isMe(participant) || isMeLid(participant)) fromMe = true
		msgType = 'group'
		author = participant
		chatId = from
	} else if (isJidBroadcast(from)) {
		if (!participant) throw new Boom('No participant in group message')
		const isParticipantMe = isMe(participant)
		msgType = isJidStatusBroadcast(from)
			? isParticipantMe
				? 'direct_peer_status'
				: 'other_status'
			: isParticipantMe
				? 'peer_broadcast'
				: 'other_broadcast'
		fromMe = isParticipantMe
		chatId = from
		author = participant
	} else if (isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from
		if (isMe(from) || isMeLid(from)) fromMe = true
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const pushname = stanza?.attrs?.notify
	const key = {
		remoteJid: chatId,
		remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
		remoteJidUsername: !isJidGroup(chatId) ? stanza.attrs.peer_recipient_username || stanza.attrs.recipient_username : undefined,
		fromMe,
		id: msgId,
		participant,
		participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
		participantUsername: stanza.attrs.participant ? stanza.attrs.participant_username : undefined,
		addressingMode: addressingContext.addressingMode,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}
	const fullMessage = {
		key,
		category: stanza.attrs.category,
		messageTimestamp: +stanza.attrs.t,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}
	if (key.fromMe) fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK

	return { fullMessage, author, sender: msgType === 'chat' ? author : chatId }
}

function isSessionRecordError(error) {
	const errorMessage = error?.message || error?.toString() || ''
	return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(pattern => errorMessage.includes(pattern))
}

export const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details)
						fullMessage.verifiedBizName = details.verifiedName
					}
					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true // TODO: remove from here and add a STUB TYPE
					}
					if (attrs.count && tag === 'enc') fullMessage.retryCount = Number(attrs.count)
					if (tag !== 'enc' && tag !== 'plaintext') continue
					if (!(content instanceof Uint8Array)) continue

					decryptables += 1
					let msgBuffer
					const decryptionJid = await getDecryptionJid(author, repository)
					if (tag !== 'plaintext') {
						await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger)
					}
					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {
							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({ group: sender, authorJid: author, msg: content })
								break
							case 'pkmsg':
							case 'msg':
								msgBuffer = await repository.decryptMessage({ jid: decryptionJid, type: e2eType, ciphertext: content })
								break
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}
						let msg = proto.Message.decode(e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer)
						msg = msg.deviceSentMessage?.message || msg
						if (msg.senderKeyDistributionMessage) {
							try {
								await repository.processSenderKeyDistributionMessage({ authorJid: author, item: msg.senderKeyDistributionMessage })
							} catch (err) {
								logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message')
							}
						}
						if (fullMessage.message) Object.assign(fullMessage.message, msg)
						else fullMessage.message = msg
					} catch (err) {
						logger.error(
							{
								key: fullMessage.key,
								err,
								messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
								sender,
								author,
								isSessionRecordError: isSessionRecordError(err)
							},
							'failed to decrypt message'
						)
						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message.toString()]
					}
				}
			}
			if (!decryptables && !fullMessage.key?.isViewOnce) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/* Trusted-contact ("tctoken") handling                                */
/* ------------------------------------------------------------------ */

const BOT_PHONE_REGEX = /^1313555\d{4}$|^131655500\d{2}$/

/** Mirrors WA Web's `Wid.isRegularUser()` (user ∧ ¬PSA ∧ ¬Bot). */
function isRegularUser(jid) {
	if (!jid) return false
	const user = jid.split('@')[0] ?? ''
	if (user === '0') return false // PSA
	if (BOT_PHONE_REGEX.test(user)) return false
	if (isJidMetaAI(jid)) return false
	return !!(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid) || jid.endsWith('@c.us'))
}

const TC_TOKEN_BUCKET_DURATION = 604800 // 7 days
const TC_TOKEN_NUM_BUCKETS = 4 // ~28-day rolling window
/** Sentinel key under `tctoken` store holding a JSON array of tracked storage JIDs. */
export const TC_TOKEN_INDEX_KEY = '__index'

export async function readTcTokenIndex(keys) {
	const data = await keys.get('tctoken', [TC_TOKEN_INDEX_KEY])
	const entry = data[TC_TOKEN_INDEX_KEY]
	if (!entry?.token?.length) return []
	try {
		const parsed = JSON.parse(Buffer.from(entry.token).toString())
		if (!Array.isArray(parsed)) return []
		return parsed.filter(j => typeof j === 'string' && j.length > 0 && j !== TC_TOKEN_INDEX_KEY)
	} catch {
		return []
	}
}

export async function buildMergedTcTokenIndexWrite(keys, addedJids) {
	const persisted = await readTcTokenIndex(keys)
	const merged = new Set(persisted)
	for (const jid of addedJids) {
		if (jid && jid !== TC_TOKEN_INDEX_KEY) merged.add(jid)
	}
	return { [TC_TOKEN_INDEX_KEY]: { token: Buffer.from(JSON.stringify([...merged])) } }
}

export function isTcTokenExpired(timestamp) {
	if (timestamp === null || timestamp === undefined) return true
	const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp
	if (isNaN(ts)) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1)
	return ts < cutoffBucket * TC_TOKEN_BUCKET_DURATION
}

export function shouldSendNewTcToken(senderTimestamp) {
	if (senderTimestamp === undefined) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const senderBucket = Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION)
	return currentBucket > senderBucket
}

export async function resolveTcTokenJid(jid, getLIDForPN) {
	if (isLidUser(jid)) return jid
	const lid = await getLIDForPN(jid)
	return lid ?? jid
}

export async function resolveIssuanceJid(jid, issueToLid, getLIDForPN, getPNForLID) {
	if (issueToLid) {
		if (isLidUser(jid)) return jid
		const lid = await getLIDForPN(jid)
		return lid ?? jid
	}
	if (!isLidUser(jid)) return jid
	if (getPNForLID) {
		const pn = await getPNForLID(jid)
		return pn ?? jid
	}
	return jid
}

export async function buildTcTokenFromJid({ authState, jid, baseContent = [], getLIDForPN }) {
	try {
		const storageJid = await resolveTcTokenJid(jid, getLIDForPN)
		const tcTokenData = await authState.keys.get('tctoken', [storageJid])
		const entry = tcTokenData?.[storageJid]
		const tcTokenBuffer = entry?.token
		const timestamp = entry?.timestamp
		if (!tcTokenBuffer?.length || timestamp === undefined || isTcTokenExpired(timestamp)) {
			if (tcTokenBuffer) {
				const cleared = entry?.senderTimestamp !== undefined ? { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp } : null
				await authState.keys.set({ tctoken: { [storageJid]: cleared } })
			}
			return baseContent.length > 0 ? baseContent : undefined
		}
		baseContent.push({ tag: 'tctoken', attrs: { t: String(timestamp) }, content: tcTokenBuffer })
		return baseContent
	} catch {
		return baseContent.length > 0 ? baseContent : undefined
	}
}

export async function storeTcTokensFromIqResult({ result, fallbackJid, keys, getLIDForPN, onNewJidStored }) {
	const tokensNode = getBinaryNodeChild(result, 'tokens')
	if (!tokensNode) return
	const tokenNodes = getBinaryNodeChildren(tokensNode, 'token')
	for (const tokenNode of tokenNodes) {
		if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) continue
		// In notifications tokenNode.attrs.jid is your own device JID, not the sender's
		const rawJid = jidNormalizedUser(fallbackJid || tokenNode.attrs.jid)
		if (!isRegularUser(rawJid)) continue
		const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN)
		const existingTcData = await keys.get('tctoken', [storageJid])
		const existingEntry = existingTcData[storageJid]
		const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0
		const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0
		if (!incomingTs) continue // timestamp-less tokens would be immediately expired
		if (existingTs > 0 && existingTs > incomingTs) continue
		await keys.set({
			tctoken: { [storageJid]: { ...existingEntry, token: Buffer.from(tokenNode.content), timestamp: tokenNode.attrs.t } }
		})
		onNewJidStored?.(storageJid)
	}
}

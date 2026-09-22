/**
 * Message processing pipeline. Combines what used to be process-message.js,
 * message-retry-manager.js, offline-node-processor.js, history.js, and business.js.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createInflate, inflate } from 'node:zlib'
import { proto } from '../../WAProto/index.js'
import { Boom } from '../foundation/boom.js'
import { Cache } from '../foundation/cache.js'
import { WAMessageStubType } from '../constants.js'
import {
	areJidsSameUser,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isHostedLidUser,
	isHostedPnUser,
	isJidBroadcast,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser
} from '../binary/wa-binary.js'
import { aesDecryptGCM, hmacSign, getKeyAuthor, toNumber, generateMessageIDV2 } from './wa-protocol-core.js'
import { getContentType, normalizeMessageContent } from './message-compose.js'
import { downloadContentFromMessage, getStream, getUrlFromDirectPath } from './media.js'
import { buildMergedTcTokenIndexWrite, resolveTcTokenJid } from './auth-state-core.js'

const inflatePromise = promisify(inflate)

/* ------------------------------------------------------------------ */
/* Incoming-message cleanup / classification                           */
/* ------------------------------------------------------------------ */

const REAL_MSG_STUB_TYPES = new Set([
	WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
	WAMessageStubType.CALL_MISSED_GROUP_VOICE,
	WAMessageStubType.CALL_MISSED_VIDEO,
	WAMessageStubType.CALL_MISSED_VOICE
])
const REAL_MSG_REQ_ME_STUB_TYPES = new Set([WAMessageStubType.GROUP_PARTICIPANT_ADD])

async function storeTcTokensFromHistorySync(chats, signalRepository, keyStore, logger) {
	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	const candidates = []
	for (const chat of chats) {
		const ts = chat.tcTokenTimestamp ? toNumber(chat.tcTokenTimestamp) : 0
		if (chat.tcToken?.length && ts > 0) {
			const jid = jidNormalizedUser(chat.id)
			const storageJid = await resolveTcTokenJid(jid, getLIDForPN)
			candidates.push({ storageJid, token: Buffer.from(chat.tcToken), ts, senderTs: chat.tcTokenSenderTimestamp ? toNumber(chat.tcTokenSenderTimestamp) : undefined })
		}
	}
	if (!candidates.length) return
	const jids = candidates.map(c => c.storageJid)
	const existing = await keyStore.get('tctoken', jids)
	const entries = {}
	for (const c of candidates) {
		const existingEntry = existing[c.storageJid]
		const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0
		if (existingTs > 0 && existingTs >= c.ts) continue
		entries[c.storageJid] = { ...existingEntry, token: c.token, timestamp: String(c.ts), ...(c.senderTs !== undefined ? { senderTimestamp: c.senderTs } : {}) }
	}
	if (Object.keys(entries).length) {
		logger?.debug({ count: Object.keys(entries).length }, 'storing tctokens from history sync')
		try {
			const indexWrite = await buildMergedTcTokenIndexWrite(keyStore, Object.keys(entries))
			await keyStore.set({ tctoken: { ...entries, ...indexWrite } })
		} catch (err) {
			logger?.warn({ err }, 'failed to store tctokens from history sync')
		}
	}
}

/** Cleans a received message to further processing */
export const cleanMessage = (message, meId, meLid) => {
	if (isHostedPnUser(message.key.remoteJid) || isHostedLidUser(message.key.remoteJid)) {
		message.key.remoteJid = jidEncode(jidDecode(message.key?.remoteJid)?.user, isHostedPnUser(message.key.remoteJid) ? 's.whatsapp.net' : 'lid')
	} else {
		message.key.remoteJid = jidNormalizedUser(message.key.remoteJid)
	}
	if (isHostedPnUser(message.key.participant) || isHostedLidUser(message.key.participant)) {
		message.key.participant = jidEncode(jidDecode(message.key.participant)?.user, isHostedPnUser(message.key.participant) ? 's.whatsapp.net' : 'lid')
	} else {
		message.key.participant = jidNormalizedUser(message.key.participant)
	}
	const content = normalizeMessageContent(message.message)
	if (content?.reactionMessage) normaliseKey(content.reactionMessage.key)
	if (content?.pollUpdateMessage) normaliseKey(content.pollUpdateMessage.pollCreationMessageKey)

	function normaliseKey(msgKey) {
		if (!message.key.fromMe) {
			msgKey.fromMe = !msgKey.fromMe
				? areJidsSameUser(msgKey.participant || msgKey.remoteJid, meId) || areJidsSameUser(msgKey.participant || msgKey.remoteJid, meLid)
				: false
			msgKey.remoteJid = message.key.remoteJid
			msgKey.participant = msgKey.participant || message.key.participant
		}
	}
}

export const isRealMessage = message => {
	const normalizedContent = normalizeMessageContent(message.message)
	const hasSomeContent = !!getContentType(normalizedContent)
	return (
		(!!normalizedContent || REAL_MSG_STUB_TYPES.has(message.messageStubType) || REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) &&
		hasSomeContent &&
		!normalizedContent?.protocolMessage &&
		!normalizedContent?.reactionMessage &&
		!normalizedContent?.pollUpdateMessage
	)
}

export const shouldIncrementChatUnread = message => !message.key.fromMe && !message.messageStubType

/** Get the ID of the chat from the given key. Typically the remoteJid, but for broadcasts, the participant. */
export const getChatId = ({ remoteJid, participant, fromMe }) => {
	if (!remoteJid) throw new Boom('Cannot derive chat id: message key is missing remoteJid', { data: { remoteJid, participant, fromMe } })
	if (isJidBroadcast(remoteJid) && !isJidStatusBroadcast(remoteJid) && !fromMe) {
		if (!participant) throw new Boom('Cannot derive chat id: broadcast message key is missing participant', { data: { remoteJid, fromMe } })
		return participant
	}
	return remoteJid
}

/* ------------------------------------------------------------------ */
/* Encrypted-payload decryption (poll votes, event responses, edits)   */
/* ------------------------------------------------------------------ */

export function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
	const toBinary = txt => Buffer.from(txt)
	const sign = Buffer.concat([toBinary(pollMsgId), toBinary(pollCreatorJid), toBinary(voterJid), toBinary('Poll Vote'), new Uint8Array([1])])
	const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256')
	const decKey = hmacSign(sign, key0, 'sha256')
	const aad = toBinary(`${pollMsgId}\u0000${voterJid}`)
	const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad)
	return proto.Message.PollVoteMessage.decode(decrypted)
}

export function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
	const toBinary = txt => Buffer.from(txt)
	const sign = Buffer.concat([toBinary(eventMsgId), toBinary(eventCreatorJid), toBinary(responderJid), toBinary('Event Response'), new Uint8Array([1])])
	const key0 = hmacSign(eventEncKey, new Uint8Array(32), 'sha256')
	const decKey = hmacSign(sign, key0, 'sha256')
	const aad = toBinary(`${eventMsgId}\u0000${responderJid}`)
	const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad)
	return proto.Message.EventResponseMessage.decode(decrypted)
}

/**
 * Decrypt a `secretEncryptedMessage` carrying a `MESSAGE_EDIT` payload.
 * info = msgId || origSenderJid || editorJid || "Message Edit"; aad = (empty);
 * key  = HKDF-SHA256(salt=zeros, ikm=messageSecret, info, L=32).
 */
export function decryptMessageEdit({ encPayload, encIv }, { originalSenderJid, originalMsgId, editEncKey, editorJid }) {
	const toBinary = txt => Buffer.from(txt)
	const sign = Buffer.concat([toBinary(originalMsgId), toBinary(originalSenderJid), toBinary(editorJid), toBinary('Message Edit'), new Uint8Array([1])])
	const key0 = hmacSign(editEncKey, new Uint8Array(32), 'sha256')
	const decKey = hmacSign(sign, key0, 'sha256')
	const aad = Buffer.alloc(0) // intentionally empty, unlike Poll Vote / Event Response
	const decrypted = aesDecryptGCM(encPayload, decKey, encIv, aad)
	return proto.Message.decode(decrypted)
}

const buildEditUpdate = args => {
	const editedInner = decryptMessageEdit(
		{ encPayload: args.encPayload, encIv: args.encIv },
		{ editEncKey: args.editEncKey, originalSenderJid: args.originalSenderJid, originalMsgId: args.originalMsgId, editorJid: args.editorJid }
	)
	const editProtocol = editedInner.protocolMessage
	const innerEdited = editProtocol?.editedMessage
	if (!innerEdited) {
		args.logger?.warn({ targetKey: args.targetKey }, 'decrypted MESSAGE_EDIT plaintext had no protocolMessage.editedMessage — skipping update')
		return null
	}
	return {
		key: { ...args.messageKey, id: args.targetKeyId },
		update: {
			message: { editedMessage: { message: innerEdited } },
			messageTimestamp: editProtocol?.timestampMs ? Math.floor(toNumber(editProtocol.timestampMs) / 1000) : args.fallbackTimestamp
		}
	}
}

/* ------------------------------------------------------------------ */
/* Main incoming-message processor                                     */
/* ------------------------------------------------------------------ */

const processMessage = async (message, { shouldProcessHistoryMsg, placeholderResendCache, ev, creds, signalRepository, keyStore, logger, options, getMessage }) => {
	const meId = creds.me.id
	const { accountSettings } = creds
	const chat = { id: jidNormalizedUser(getChatId(message.key)) }
	const isRealMsg = isRealMessage(message)
	if (isRealMsg) {
		chat.messages = [{ message }]
		chat.conversationTimestamp = toNumber(message.messageTimestamp)
		if (shouldIncrementChatUnread(message)) chat.unreadCount = (chat.unreadCount || 0) + 1
	}
	const content = normalizeMessageContent(message.message)
	if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
		chat.archived = false
		chat.readOnly = false
	}
	const protocolMsg = content?.protocolMessage
	if (protocolMsg) {
		// Self-only protocol message types must be dropped if not fromMe (spoofing guard) — mirrors
		// whatsmeow's handleProtocolMessage. Cross-user types (REVOKE, MESSAGE_EDIT, EPHEMERAL_SETTING,
		// GROUP_MEMBER_LABEL_CHANGE) legitimately arrive from others and are NOT in this set.
		const SELF_ONLY_TYPES = new Set([
			proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
			proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
			proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
			proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
		])
		if (protocolMsg.type !== null && protocolMsg.type !== undefined && SELF_ONLY_TYPES.has(protocolMsg.type) && !message.key.fromMe) {
			logger?.warn({ msgId: message.key.id, type: protocolMsg.type, from: message.key.participant || message.key.remoteJid }, 'dropping spoofed self-only protocolMessage from non-self origin')
			return
		}
		switch (protocolMsg.type) {
			case proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION: {
				const histNotification = protocolMsg.historySyncNotification
				const process = shouldProcessHistoryMsg
				const isLatest = !creds.processedHistoryMessages?.length
				logger?.info({ histNotification, process, id: message.key.id, isLatest }, 'got history notification')
				if (process) {
					if (histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
						ev.emit('creds.update', {
							processedHistoryMessages: [...(creds.processedHistoryMessages || []), { key: message.key, messageTimestamp: message.messageTimestamp }]
						})
					}
					const data = await downloadAndProcessHistorySyncNotification(histNotification, options, logger)
					if (data.lidPnMappings?.length) {
						logger?.debug({ count: data.lidPnMappings.length }, 'processing LID-PN mappings from history sync')
						await signalRepository.lidMapping.storeLIDPNMappings(data.lidPnMappings).catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from history sync'))
					}
					await storeTcTokensFromHistorySync(data.chats, signalRepository, keyStore, logger)
					ev.emit('messaging-history.set', {
						...data,
						isLatest: histNotification.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ? isLatest : undefined,
						chunkOrder: histNotification.chunkOrder,
						peerDataRequestSessionId: histNotification.peerDataRequestSessionId
					})
				}
				break
			}
			case proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE: {
				const keys = protocolMsg.appStateSyncKeyShare.keys
				if (keys?.length) {
					let newAppStateSyncKeyId = ''
					await keyStore.transaction(async () => {
						const newKeys = []
						for (const { keyData, keyId } of keys) {
							const strKeyId = Buffer.from(keyId.keyId).toString('base64')
							newKeys.push(strKeyId)
							await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } })
							newAppStateSyncKeyId = strKeyId
						}
						logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys')
					}, meId)
					ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId })
				} else {
					logger?.info({ protocolMsg }, 'recv app state sync with 0 keys')
				}
				break
			}
			case proto.Message.ProtocolMessage.Type.REVOKE:
				ev.emit('messages.update', [
					{ key: { ...message.key, id: protocolMsg.key.id }, update: { message: null, messageStubType: WAMessageStubType.REVOKE, key: message.key } }
				])
				break
			case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
				Object.assign(chat, { ephemeralSettingTimestamp: toNumber(message.messageTimestamp), ephemeralExpiration: protocolMsg.ephemeralExpiration || null })
				break
			case proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: {
				const response = protocolMsg.peerDataOperationRequestResponseMessage
				if (response) {
					const peerDataOperationResult = response.peerDataOperationResult || []
					for (const result of peerDataOperationResult) {
						const retryResponse = result?.placeholderMessageResendResponse
						if (!retryResponse?.webMessageInfoBytes) continue
						try {
							const webMessageInfo = proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes)
							const msgId = webMessageInfo.key?.id
							const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined
							if (msgId) await placeholderResendCache?.del(msgId)
							let finalMsg
							if (cachedData && typeof cachedData === 'object') {
								cachedData.message = webMessageInfo.message
								if (webMessageInfo.messageTimestamp) cachedData.messageTimestamp = webMessageInfo.messageTimestamp
								finalMsg = cachedData
							} else {
								finalMsg = webMessageInfo
							}
							logger?.debug({ msgId, requestId: response.stanzaId }, 'received placeholder resend')
							ev.emit('messages.upsert', { messages: [finalMsg], type: 'notify', requestId: response.stanzaId })
						} catch (err) {
							logger?.warn({ err, stanzaId: response.stanzaId }, 'failed to decode placeholder resend response')
						}
					}
				}
				break
			}
			case proto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
				ev.emit('messages.update', [
					{
						key: { ...message.key, id: protocolMsg.key?.id },
						update: {
							message: { editedMessage: { message: protocolMsg.editedMessage } },
							messageTimestamp: protocolMsg.timestampMs ? Math.floor(toNumber(protocolMsg.timestampMs) / 1000) : message.messageTimestamp
						}
					}
				])
				break
			case proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE: {
				const labelAssociationMsg = protocolMsg.memberLabel
				if (labelAssociationMsg?.label) {
					ev.emit('group.member-tag.update', {
						groupId: chat.id,
						label: labelAssociationMsg.label,
						participant: message.key.participant,
						participantAlt: message.key.participantAlt,
						messageTimestamp: Number(message.messageTimestamp)
					})
				}
				break
			}
			case proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC: {
				const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload
				const { pnToLidMappings, chatDbMigrationTimestamp } = proto.LIDMigrationMappingSyncPayload.decode(encodedPayload)
				logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp')
				const pairs = []
				for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
					const lid = latestLid || assignedLid
					pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` })
				}
				await signalRepository.lidMapping.storeLIDPNMappings(pairs)
				if (pairs.length) for (const { pn, lid } of pairs) await signalRepository.migrateSession(pn, lid)
			}
		}
	} else if (content?.reactionMessage) {
		const reaction = { ...content.reactionMessage, key: message.key }
		ev.emit('messages.reaction', [{ reaction, key: content.reactionMessage?.key }])
	} else if (content?.encEventResponseMessage) {
		const encEventResponse = content.encEventResponseMessage
		const creationMsgKey = encEventResponse.eventCreationMessageKey
		const eventMsg = await getMessage(creationMsgKey)
		if (eventMsg) {
			try {
				const meIdNormalised = jidNormalizedUser(meId)
				const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid
				const eventCreatorPn = isLidUser(eventCreatorKey) ? await signalRepository.lidMapping.getPNForLID(eventCreatorKey) : eventCreatorKey
				const eventCreatorJid = getKeyAuthor({ remoteJid: jidNormalizedUser(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn }, meIdNormalised)
				const responderJid = getKeyAuthor(message.key, meIdNormalised)
				const eventEncKey = eventMsg?.messageContextInfo?.messageSecret
				if (!eventEncKey) {
					logger?.warn({ creationMsgKey }, 'event response: missing messageSecret for decryption')
				} else {
					const responseMsg = decryptEventResponse(encEventResponse, { eventEncKey, eventCreatorJid, eventMsgId: creationMsgKey.id, responderJid })
					const eventResponse = { eventResponseMessageKey: message.key, senderTimestampMs: responseMsg.timestampMs, response: responseMsg }
					ev.emit('messages.update', [{ key: creationMsgKey, update: { eventResponses: [eventResponse] } }])
				}
			} catch (err) {
				logger?.warn({ err, creationMsgKey }, 'failed to decrypt event response')
			}
		} else {
			logger?.warn({ creationMsgKey }, 'event creation message not found, cannot decrypt response')
		}
	} else if (content?.secretEncryptedMessage && content.secretEncryptedMessage.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT) {
		const secEnc = content.secretEncryptedMessage
		const targetKey = secEnc.targetMessageKey
		const targetMsg = await getMessage(targetKey)
		if (targetMsg) {
			try {
				const meIdNormalised = jidNormalizedUser(meId)
				const origSenderRaw = targetKey.participant || targetKey.remoteJid
				const origSenderPn = isLidUser(origSenderRaw) ? await signalRepository.lidMapping.getPNForLID(origSenderRaw) : origSenderRaw
				const originalSenderJid = getKeyAuthor({ remoteJid: jidNormalizedUser(origSenderPn), fromMe: meIdNormalised === origSenderPn }, meIdNormalised)
				const editorJid = getKeyAuthor(message.key, meIdNormalised)
				const editEncKey = targetMsg?.messageContextInfo?.messageSecret
				if (!editEncKey) {
					logger?.warn({ targetKey }, 'message edit: missing messageSecret on original message — cannot decrypt')
					return
				}
				const update = buildEditUpdate({
					editEncKey,
					encPayload: secEnc.encPayload,
					encIv: secEnc.encIv,
					originalSenderJid,
					originalMsgId: targetKey.id,
					editorJid,
					messageKey: message.key,
					targetKeyId: targetKey.id,
					fallbackTimestamp: toNumber(message.messageTimestamp),
					logger,
					targetKey
				})
				if (update) ev.emit('messages.update', [update])
			} catch (err) {
				logger?.warn({ err, targetKey }, 'failed to decrypt secretEncryptedMessage MESSAGE_EDIT')
			}
		} else {
			logger?.warn({ targetKey }, 'original message not found in store, cannot decrypt secretEncryptedMessage edit')
		}
	} else if (message.messageStubType) {
		const jid = message.key?.remoteJid
		let participants
		const emitParticipantsUpdate = action =>
			ev.emit('group-participants.update', { id: jid, author: message.key.participant, authorPn: message.key.participantAlt, authorUsername: message.key.participantUsername, participants, action })
		const emitGroupUpdate = update =>
			ev.emit('groups.update', [{ id: jid, ...update, author: message.key.participant ?? undefined, authorPn: message.key.participantAlt, authorUsername: message.key.participantUsername }])
		const emitGroupRequestJoin = (participant, action, method) =>
			ev.emit('group.join-request', {
				id: jid,
				author: message.key.participant,
				authorPn: message.key.participantAlt,
				authorUsername: message.key.participantUsername,
				participant: participant.lid,
				participantPn: participant.pn,
				action,
				method
			})
		const participantsIncludesMe = () => participants.find(jid_ => areJidsSameUser(meId, jid_.phoneNumber))

		switch (message.messageStubType) {
			case WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('modify')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
			case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('remove')
				if (participantsIncludesMe()) chat.readOnly = true
				break
			case WAMessageStubType.GROUP_PARTICIPANT_ADD:
			case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
			case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				if (participantsIncludesMe()) chat.readOnly = false
				emitParticipantsUpdate('add')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('demote')
				break
			case WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('promote')
				break
			case WAMessageStubType.GROUP_CHANGE_ANNOUNCE: {
				const announceValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' })
				break
			}
			case WAMessageStubType.GROUP_CHANGE_RESTRICT: {
				const restrictValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' })
				break
			}
			case WAMessageStubType.GROUP_CHANGE_SUBJECT: {
				const name = message.messageStubParameters?.[0]
				chat.name = name
				emitGroupUpdate({ subject: name })
				break
			}
			case WAMessageStubType.GROUP_CHANGE_DESCRIPTION: {
				const description = message.messageStubParameters?.[0]
				chat.description = description
				emitGroupUpdate({ desc: description })
				break
			}
			case WAMessageStubType.GROUP_CHANGE_INVITE_LINK: {
				const code = message.messageStubParameters?.[0]
				emitGroupUpdate({ inviteCode: code })
				break
			}
			case WAMessageStubType.GROUP_MEMBER_ADD_MODE: {
				const memberAddValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' })
				break
			}
			case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE: {
				const approvalMode = message.messageStubParameters?.[0]
				emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' })
				break
			}
			case WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD: {
				const participant = JSON.parse(message.messageStubParameters?.[0])
				const action = message.messageStubParameters?.[1]
				const method = message.messageStubParameters?.[2]
				emitGroupRequestJoin(participant, action, method)
				break
			}
		}
	}
	if (Object.keys(chat).length > 1) ev.emit('chats.update', [chat])
}

export default processMessage

/* ------------------------------------------------------------------ */
/* Message retry manager                                               */
/* ------------------------------------------------------------------ */

const RECENT_MESSAGES_SIZE = 1024
const MESSAGE_KEY_SEPARATOR = '\u0000'
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000
const PHONE_REQUEST_DELAY = 3000

/** Retry reason codes matching WhatsApp Web's Signal error codes. */
export const RetryReason = {
	UnknownError: 0,
	SignalErrorNoSession: 1,
	SignalErrorInvalidKey: 2,
	SignalErrorInvalidKeyId: 3,
	SignalErrorInvalidMessage: 4, // MAC verification failed - most common cause of decryption failures
	SignalErrorInvalidSignature: 5,
	SignalErrorFutureMessage: 6,
	SignalErrorBadMac: 7, // Explicit MAC failure - session is definitely out of sync
	SignalErrorInvalidSession: 8,
	SignalErrorInvalidMsgKey: 9,
	BadBroadcastEphemeralSetting: 10,
	UnknownCompanionNoPrekey: 11,
	AdvFailure: 12,
	StatusRevokeDelay: 13
}
// reverse lookup for logging, mirrors the old TS enum's string access
for (const [name, value] of Object.entries({ ...RetryReason })) RetryReason[value] = name

const MAC_ERROR_CODES = new Set([RetryReason.SignalErrorInvalidMessage, RetryReason.SignalErrorBadMac])

export class MessageRetryManager {
	constructor(logger, maxMsgRetryCount) {
		this.logger = logger
		this.recentMessagesMap = new Cache({
			max: RECENT_MESSAGES_SIZE,
			ttl: 5 * 60 * 1000,
			dispose: (_value, key) => {
				const separatorIndex = key.lastIndexOf(MESSAGE_KEY_SEPARATOR)
				if (separatorIndex > -1) this.messageKeyIndex.delete(key.slice(separatorIndex + MESSAGE_KEY_SEPARATOR.length))
			}
		})
		this.messageKeyIndex = new Map()
		this.sessionRecreateHistory = new Cache({ ttl: RECREATE_SESSION_TIMEOUT * 2 })
		this.retryCounters = new Cache({ ttl: 15 * 60 * 1000, updateAgeOnGet: true })
		this.baseKeys = new Cache({ max: 1024, ttl: 15 * 60 * 1000 })
		this.pendingPhoneRequests = {}
		this.maxMsgRetryCount = maxMsgRetryCount
		this.statistics = { totalRetries: 0, successfulRetries: 0, failedRetries: 0, mediaRetries: 0, sessionRecreations: 0, phoneRequests: 0 }
		// Tracks messages that were locally edited or revoked, so a late-arriving retry
		// receipt for the pre-edit/pre-revoke version doesn't resend stale content (e.g.
		// a deleted message reappearing, or an edit getting overwritten by its own
		// pre-edit body). Bounded TTL: only need to cover the window a stale retry could
		// realistically still be in flight.
		this.invalidatedMessages = new Cache({ max: 512, ttl: 5 * 60 * 1000 })
	}

	invalidatedKey(to, id) {
		return this.keyToString({ to, id })
	}

	/** Mark (to, id) as edited/revoked so a subsequent resend request for it is dropped. */
	invalidateMessage(to, id) {
		if (!to || !id) return
		this.invalidatedMessages.set(this.invalidatedKey(to, id), true)
	}

	isMessageInvalidated(to, id) {
		if (!to || !id) return false
		return this.invalidatedMessages.get(this.invalidatedKey(to, id)) === true
	}

	addRecentMessage(to, id, message) {
		const keyStr = this.keyToString({ to, id })
		this.recentMessagesMap.set(keyStr, { message, timestamp: Date.now() })
		this.messageKeyIndex.set(id, keyStr)
		this.logger.debug(`Added message to retry cache: ${to}/${id}`)
	}

	getRecentMessage(to, id) {
		return this.recentMessagesMap.get(this.keyToString({ to, id }))
	}

	/** MAC errors (codes 4 and 7) trigger immediate session recreation regardless of timeout. */
	shouldRecreateSession(jid, hasSession, errorCode) {
		if (!hasSession) {
			this.sessionRecreateHistory.set(jid, Date.now())
			this.statistics.sessionRecreations++
			return { reason: "we don't have a Signal session with them", recreate: true }
		}
		if (errorCode !== undefined && MAC_ERROR_CODES.has(errorCode)) {
			this.sessionRecreateHistory.set(jid, Date.now())
			this.statistics.sessionRecreations++
			this.logger.warn({ jid, errorCode: RetryReason[errorCode] }, 'MAC error detected, forcing immediate session recreation')
			return { reason: `MAC error (code ${errorCode}: ${RetryReason[errorCode]}), immediate session recreation`, recreate: true }
		}
		const now = Date.now()
		const prevTime = this.sessionRecreateHistory.get(jid)
		if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
			this.sessionRecreateHistory.set(jid, now)
			this.statistics.sessionRecreations++
			return { reason: 'retry count > 1 and over an hour since last recreation', recreate: true }
		}
		return { reason: '', recreate: false }
	}

	parseRetryErrorCode(errorAttr) {
		if (errorAttr === undefined || errorAttr === '') return undefined
		const code = parseInt(errorAttr, 10)
		if (Number.isNaN(code)) return undefined
		if (code >= RetryReason.UnknownError && code <= RetryReason.StatusRevokeDelay) return code
		return RetryReason.UnknownError
	}

	isMacError(errorCode) {
		return errorCode !== undefined && MAC_ERROR_CODES.has(errorCode)
	}

	incrementRetryCount(messageId) {
		this.retryCounters.set(messageId, (this.retryCounters.get(messageId) || 0) + 1)
		this.statistics.totalRetries++
		return this.retryCounters.get(messageId)
	}

	getRetryCount(messageId) {
		return this.retryCounters.get(messageId) || 0
	}

	hasExceededMaxRetries(messageId) {
		return this.getRetryCount(messageId) >= this.maxMsgRetryCount
	}

	markRetrySuccess(messageId) {
		this.statistics.successfulRetries++
		this.retryCounters.delete(messageId)
		this.cancelPendingPhoneRequest(messageId)
		this.removeRecentMessage(messageId)
	}

	markRetryFailed(messageId) {
		this.statistics.failedRetries++
		this.retryCounters.delete(messageId)
		this.cancelPendingPhoneRequest(messageId)
		this.removeRecentMessage(messageId)
	}

	schedulePhoneRequest(messageId, callback, delay = PHONE_REQUEST_DELAY) {
		this.cancelPendingPhoneRequest(messageId)
		this.pendingPhoneRequests[messageId] = setTimeout(() => {
			delete this.pendingPhoneRequests[messageId]
			this.statistics.phoneRequests++
			callback()
		}, delay)
		this.logger.debug(`Scheduled phone request for message ${messageId} with ${delay}ms delay`)
	}

	cancelPendingPhoneRequest(messageId) {
		const timeout = this.pendingPhoneRequests[messageId]
		if (timeout) {
			clearTimeout(timeout)
			delete this.pendingPhoneRequests[messageId]
			this.logger.debug(`Cancelled pending phone request for message ${messageId}`)
		}
	}

	clear() {
		this.recentMessagesMap.clear()
		this.messageKeyIndex.clear()
		this.sessionRecreateHistory.clear()
		this.retryCounters.clear()
		this.baseKeys.clear()
		this.invalidatedMessages.clear()
		for (const messageId of Object.keys(this.pendingPhoneRequests)) this.cancelPendingPhoneRequest(messageId)
		this.statistics = { totalRetries: 0, successfulRetries: 0, failedRetries: 0, mediaRetries: 0, sessionRecreations: 0, phoneRequests: 0 }
	}

	saveBaseKey(addr, msgId, baseKey) {
		this.baseKeys.set(`${addr}:${msgId}`, baseKey)
	}

	hasSameBaseKey(addr, msgId, baseKey) {
		const stored = this.baseKeys.get(`${addr}:${msgId}`)
		if (!stored || stored.length !== baseKey.length) return false
		for (let i = 0; i < stored.length; i++) if (stored[i] !== baseKey[i]) return false
		return true
	}

	deleteBaseKey(addr, msgId) {
		this.baseKeys.delete(`${addr}:${msgId}`)
	}

	keyToString(key) {
		return `${key.to}${MESSAGE_KEY_SEPARATOR}${key.id}`
	}

	removeRecentMessage(messageId) {
		const keyStr = this.messageKeyIndex.get(messageId)
		if (!keyStr) return
		this.recentMessagesMap.delete(keyStr)
		this.messageKeyIndex.delete(messageId)
	}
}

/* ------------------------------------------------------------------ */
/* Offline node processor                                              */
/* ------------------------------------------------------------------ */

/**
 * Creates a processor for offline stanza nodes that:
 * - Queues nodes for sequential processing
 * - Yields to the event loop periodically to avoid blocking
 * - Catches handler errors to prevent the processing loop from crashing
 */
export function makeOfflineNodeProcessor(nodeProcessorMap, deps, batchSize = 10) {
	const nodes = []
	let isProcessing = false
	const enqueue = (type, node) => {
		nodes.push({ type, node })
		if (isProcessing) return
		isProcessing = true
		const run = async () => {
			let processedInBatch = 0
			while (nodes.length && deps.isWsOpen()) {
				const { type, node } = nodes.shift()
				const nodeProcessor = nodeProcessorMap.get(type)
				if (!nodeProcessor) {
					deps.onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node')
					continue
				}
				await nodeProcessor(node).catch(err => deps.onUnexpectedError(err, `processing offline ${type}`))
				processedInBatch++
				if (processedInBatch >= batchSize) {
					processedInBatch = 0
					await deps.yieldToEventLoop()
				}
			}
			isProcessing = false
		}
		run().catch(error => deps.onUnexpectedError(error, 'processing offline nodes'))
	}
	return { enqueue }
}

/* ------------------------------------------------------------------ */
/* History sync                                                        */
/* ------------------------------------------------------------------ */

const extractPnFromMessages = messages => {
	for (const msgItem of messages) {
		const message = msgItem.message
		if (!message?.key?.fromMe || !message.userReceipt?.length) continue
		const userJid = message.userReceipt[0]?.userJid
		if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid))) return userJid
	}
	return undefined
}

export const downloadHistory = async (msg, options) => {
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	const inflater = createInflate()
	const chunks = []
	inflater.on('data', chunk => chunks.push(chunk))
	await pipeline(stream, inflater)
	return proto.HistorySync.decode(Buffer.concat(chunks))
}

export const processHistoryMessage = (item, logger) => {
	const messages = []
	const contacts = []
	const chats = []
	const lidPnMappings = []
	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
	}
	switch (item.syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case proto.HistorySync.HistorySyncType.RECENT:
		case proto.HistorySync.HistorySyncType.FULL:
		case proto.HistorySync.HistorySyncType.ON_DEMAND:
			for (const chat of item.conversations) {
				contacts.push({ id: chat.id, name: chat.displayName || chat.name || chat.username || undefined, username: chat.username || undefined, lid: chat.lidJid || chat.accountLid || undefined, phoneNumber: chat.pnJid || undefined })
				const chatId = chat.id
				const isLid = isLidUser(chatId) || isHostedLidUser(chatId)
				const isPn = isPnUser(chatId) || isHostedPnUser(chatId)
				if (isLid && chat.pnJid) lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				else if (isPn && chat.lidJid) lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				else if (isLid && !chat.pnJid) {
					const pnFromReceipt = extractPnFromMessages(chat.messages || [])
					if (pnFromReceipt) lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })
				}
				const msgs = chat.messages || []
				delete chat.messages
				for (const item_ of msgs) {
					const message = item_.message
					messages.push(message)
					if (!chat.messages?.length) chat.messages = [{ message }] // keep only the most recent message in the chat array
					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP || message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({ id: message.key.participant || message.key.remoteJid, verifiedName: message.messageStubParameters?.[0] })
					}
				}
				chats.push(chat)
			}
			break
		case proto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames) contacts.push({ id: c.id, notify: c.pushname })
			break
	}
	return { chats, contacts, messages, lidPnMappings, pastParticipants: item.pastParticipants, syncType: item.syncType, progress: item.progress }
}

export const downloadAndProcessHistorySyncNotification = async (msg, options, logger) => {
	const historyMsg = msg.initialHistBootstrapInlinePayload
		? proto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload))
		: await downloadHistory(msg, options)
	return processHistoryMessage(historyMsg, logger)
}

export const getHistoryMsg = message => {
	const normalizedContent = message ? normalizeMessageContent(message) : undefined
	return normalizedContent?.protocolMessage?.historySyncNotification
}

/* ------------------------------------------------------------------ */
/* Business / catalog                                                  */
/* ------------------------------------------------------------------ */

export const parseCatalogNode = node => {
	const catalogNode = getBinaryNodeChild(node, 'product_catalog')
	const products = getBinaryNodeChildren(catalogNode, 'product').map(parseProductNode)
	const paging = getBinaryNodeChild(catalogNode, 'paging')
	return { products, nextPageCursor: paging ? getBinaryNodeChildString(paging, 'after') : undefined }
}

export const parseCollectionsNode = node => {
	const collectionsNode = getBinaryNodeChild(node, 'collections')
	const collections = getBinaryNodeChildren(collectionsNode, 'collection').map(collectionNode => ({
		id: getBinaryNodeChildString(collectionNode, 'id'),
		name: getBinaryNodeChildString(collectionNode, 'name'),
		products: getBinaryNodeChildren(collectionNode, 'product').map(parseProductNode),
		status: parseStatusInfo(collectionNode)
	}))
	return { collections }
}

export const parseOrderDetailsNode = node => {
	const orderNode = getBinaryNodeChild(node, 'order')
	const products = getBinaryNodeChildren(orderNode, 'product').map(productNode => {
		const imageNode = getBinaryNodeChild(productNode, 'image')
		return {
			id: getBinaryNodeChildString(productNode, 'id'),
			name: getBinaryNodeChildString(productNode, 'name'),
			imageUrl: getBinaryNodeChildString(imageNode, 'url'),
			price: +getBinaryNodeChildString(productNode, 'price'),
			currency: getBinaryNodeChildString(productNode, 'currency'),
			quantity: +getBinaryNodeChildString(productNode, 'quantity')
		}
	})
	const priceNode = getBinaryNodeChild(orderNode, 'price')
	return { price: { total: +getBinaryNodeChildString(priceNode, 'total'), currency: getBinaryNodeChildString(priceNode, 'currency') }, products }
}

export const toProductNode = (productId, product) => {
	const attrs = {}
	const content = []
	if (typeof productId !== 'undefined') content.push({ tag: 'id', attrs: {}, content: Buffer.from(productId) })
	if (typeof product.name !== 'undefined') content.push({ tag: 'name', attrs: {}, content: Buffer.from(product.name) })
	if (typeof product.description !== 'undefined') content.push({ tag: 'description', attrs: {}, content: Buffer.from(product.description) })
	if (typeof product.retailerId !== 'undefined') content.push({ tag: 'retailer_id', attrs: {}, content: Buffer.from(product.retailerId) })
	if (product.images.length) {
		content.push({
			tag: 'media',
			attrs: {},
			content: product.images.map(img => {
				if (!('url' in img)) throw new Boom('Expected img for product to already be uploaded', { statusCode: 400 })
				return { tag: 'image', attrs: {}, content: [{ tag: 'url', attrs: {}, content: Buffer.from(img.url.toString()) }] }
			})
		})
	}
	if (typeof product.price !== 'undefined') content.push({ tag: 'price', attrs: {}, content: Buffer.from(product.price.toString()) })
	if (typeof product.currency !== 'undefined') content.push({ tag: 'currency', attrs: {}, content: Buffer.from(product.currency) })
	if ('originCountryCode' in product) {
		if (typeof product.originCountryCode === 'undefined') attrs['compliance_category'] = 'COUNTRY_ORIGIN_EXEMPT'
		else content.push({ tag: 'compliance_info', attrs: {}, content: [{ tag: 'country_code_origin', attrs: {}, content: Buffer.from(product.originCountryCode) }] })
	}
	if (typeof product.isHidden !== 'undefined') attrs['is_hidden'] = product.isHidden.toString()
	return { tag: 'product', attrs, content }
}

export const parseProductNode = productNode => {
	const isHidden = productNode.attrs.is_hidden === 'true'
	const id = getBinaryNodeChildString(productNode, 'id')
	const mediaNode = getBinaryNodeChild(productNode, 'media')
	const statusInfoNode = getBinaryNodeChild(productNode, 'status_info')
	return {
		id,
		imageUrls: parseImageUrls(mediaNode),
		reviewStatus: { whatsapp: getBinaryNodeChildString(statusInfoNode, 'status') },
		availability: 'in stock',
		name: getBinaryNodeChildString(productNode, 'name'),
		retailerId: getBinaryNodeChildString(productNode, 'retailer_id'),
		url: getBinaryNodeChildString(productNode, 'url'),
		description: getBinaryNodeChildString(productNode, 'description'),
		price: +getBinaryNodeChildString(productNode, 'price'),
		currency: getBinaryNodeChildString(productNode, 'currency'),
		isHidden
	}
}

/** Uploads images not already uploaded to WA's servers */
export async function uploadingNecessaryImagesOfProduct(product, waUploadToServer, timeoutMs = 30000) {
	return { ...product, images: product.images ? await uploadingNecessaryImages(product.images, waUploadToServer, timeoutMs) : product.images }
}

/** Uploads images not already uploaded to WA's servers */
export const uploadingNecessaryImages = async (images, waUploadToServer, timeoutMs = 30000) => {
	return Promise.all(
		images.map(async img => {
			if ('url' in img) {
				const url = img.url.toString()
				if (url.includes('.whatsapp.net')) return { url }
			}
			const { stream } = await getStream(img)
			const hasher = createHash('sha256')
			const filePath = join(tmpdir(), 'img' + generateMessageIDV2())
			const encFileWriteStream = createWriteStream(filePath)
			for await (const block of stream) {
				hasher.update(block)
				encFileWriteStream.write(block)
			}
			const sha = hasher.digest('base64')
			const { directPath } = await waUploadToServer(filePath, { mediaType: 'product-catalog-image', fileEncSha256B64: sha, timeoutMs })
			await fs.unlink(filePath).catch(err => console.log('Error deleting temp file ', err))
			return { url: getUrlFromDirectPath(directPath) }
		})
	)
}

const parseImageUrls = mediaNode => {
	const imgNode = getBinaryNodeChild(mediaNode, 'image')
	return { requested: getBinaryNodeChildString(imgNode, 'request_image_url'), original: getBinaryNodeChildString(imgNode, 'original_image_url') }
}

const parseStatusInfo = mediaNode => {
	const node = getBinaryNodeChild(mediaNode, 'status_info')
	return { status: getBinaryNodeChildString(node, 'status'), canAppeal: getBinaryNodeChildString(node, 'can_appeal') === 'true' }
}

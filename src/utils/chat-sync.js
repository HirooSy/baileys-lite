/**
 * Chat/app-state sync utilities. Combines what used to be chat-utils.js,
 * event-buffer.js, and sync-action-utils.js.
 *
 * expandAppStateKeys comes from ../foundation/wa-crypto.js (native).
 */
import { EventEmitter } from 'node:events'
import { proto } from '../../WAProto/index.js'
import { expandAppStateKeys } from '../foundation/wa-crypto.js'
import { Boom } from '../foundation/boom.js'
import { LabelAssociationType, WAMessageStatus } from '../constants.js'
import { getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isLidUser, isPnUser, jidNormalizedUser } from '../binary/wa-binary.js'
import { aesDecrypt, aesEncrypt, hmacSign, toNumber, trimUndefined, LT_HASH_ANTI_TAMPERING } from './wa-protocol-core.js'
import { downloadContentFromMessage } from './media.js'
import { updateMessageWithReaction, updateMessageWithReceipt } from './message-compose.js'
import { isRealMessage, shouldIncrementChatUnread } from './message-processing.js'

/* ------------------------------------------------------------------ */
/* App-state (chat-utils): LTHash / patch encode-decode                */
/* ------------------------------------------------------------------ */

const mutationKeys = keydata => {
	const keys = expandAppStateKeys(keydata)
	return { indexKey: keys.indexKey, valueEncryptionKey: keys.valueEncryptionKey, valueMacKey: keys.valueMacKey, snapshotMacKey: keys.snapshotMacKey, patchMacKey: keys.patchMacKey }
}

const generateMac = (operation, data, keyId, key) => {
	const opByte = operation === proto.SyncdMutation.SyncdOperation.SET ? 0x01 : 0x02
	const keyIdBuffer = typeof keyId === 'string' ? Buffer.from(keyId, 'base64') : keyId
	const keyData = new Uint8Array(1 + keyIdBuffer.length)
	keyData[0] = opByte
	keyData.set(keyIdBuffer, 1)
	const last = new Uint8Array(8)
	last[7] = keyData.length
	const total = new Uint8Array(keyData.length + data.length + last.length)
	total.set(keyData, 0)
	total.set(data, keyData.length)
	total.set(last, keyData.length + data.length)
	const hmac = hmacSign(total, key, 'sha512')
	return hmac.subarray(0, 32)
}

const to64BitNetworkOrder = e => {
	const buff = Buffer.alloc(8)
	buff.writeUint32BE(e, 4)
	return buff
}

export const makeLtHashGenerator = ({ indexValueMap, hash }) => {
	indexValueMap = { ...indexValueMap }
	const addBuffs = []
	const subBuffs = []
	return {
		mix: ({ indexMac, valueMac, operation }) => {
			const indexMacBase64 = Buffer.from(indexMac).toString('base64')
			const prevOp = indexValueMap[indexMacBase64]
			if (operation === proto.SyncdMutation.SyncdOperation.REMOVE) {
				if (!prevOp) return // WA Web logs+skips; handled downstream by MAC validation / snapshot recovery
				delete indexValueMap[indexMacBase64]
			} else {
				addBuffs.push(valueMac)
				indexValueMap[indexMacBase64] = { valueMac }
			}
			if (prevOp) subBuffs.push(prevOp.valueMac)
		},
		finish: () => {
			const result = LT_HASH_ANTI_TAMPERING.subtractThenAdd(hash, subBuffs, addBuffs)
			return { hash: Buffer.from(result), indexValueMap }
		}
	}
}

const generateSnapshotMac = (lthash, version, name, key) => hmacSign(Buffer.concat([lthash, to64BitNetworkOrder(version), Buffer.from(name, 'utf-8')]), key, 'sha256')
const generatePatchMac = (snapshotMac, valueMacs, version, type, key) => hmacSign(Buffer.concat([snapshotMac, ...valueMacs, to64BitNetworkOrder(version), Buffer.from(type, 'utf-8')]), key)

export const newLTHashState = () => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} })
export const ensureLTHashStateVersion = state => {
	if (typeof state.version !== 'number' || isNaN(state.version)) state.version = 0
	return state
}

export const MAX_SYNC_ATTEMPTS = 2

/** WA Web treats missing app-state sync keys as "Blocked" (waits for key arrival), not fatal. */
export const isMissingKeyError = error => error?.data?.isMissingKey === true

/** TypeError indicates a WASM crash; otherwise give up after MAX_SYNC_ATTEMPTS. Missing keys handled separately. */
export const isAppStateSyncIrrecoverable = (error, attempts) => attempts >= MAX_SYNC_ATTEMPTS || error?.name === 'TypeError'

export const encodeSyncdPatch = async ({ type, index, syncAction, apiVersion, operation }, myAppStateKeyId, state, getAppStateSyncKey) => {
	const key = myAppStateKeyId ? await getAppStateSyncKey(myAppStateKeyId) : undefined
	if (!key) throw new Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { data: { isMissingKey: true } })
	const encKeyId = Buffer.from(myAppStateKeyId, 'base64')
	state = { ...state, indexValueMap: { ...state.indexValueMap } }
	const indexBuffer = Buffer.from(JSON.stringify(index))
	const dataProto = proto.SyncActionData.fromObject({ index: indexBuffer, value: syncAction, padding: new Uint8Array(0), version: apiVersion })
	const encoded = proto.SyncActionData.encode(dataProto).finish()
	const keyValue = mutationKeys(key.keyData)
	const encValue = aesEncrypt(encoded, keyValue.valueEncryptionKey)
	const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey)
	const indexMac = hmacSign(indexBuffer, keyValue.indexKey)
	const generator = makeLtHashGenerator(state)
	generator.mix({ indexMac, valueMac, operation })
	Object.assign(state, generator.finish())
	state.version += 1
	const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey)
	const patch = {
		patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
		snapshotMac,
		keyId: { id: encKeyId },
		mutations: [{ operation, record: { index: { blob: indexMac }, value: { blob: Buffer.concat([encValue, valueMac]) }, keyId: { id: encKeyId } } }]
	}
	state.indexValueMap[indexMac.toString('base64')] = { valueMac }
	return { patch, state }
}

export const decodeSyncdMutations = async (msgMutations, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
	const ltGenerator = makeLtHashGenerator(initialState)
	const derivedKeyCache = new Map()

	async function getKey(keyId) {
		const base64Key = Buffer.from(keyId).toString('base64')
		const cached = derivedKeyCache.get(base64Key)
		if (cached) return cached
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) throw new Boom(`failed to find key "${base64Key}" to decode mutation`, { data: { isMissingKey: true, msgMutations } })
		const keys = mutationKeys(keyEnc.keyData)
		derivedKeyCache.set(base64Key, keys)
		return keys
	}

	for (const msgMutation of msgMutations) {
		const operation = 'operation' in msgMutation ? msgMutation.operation : proto.SyncdMutation.SyncdOperation.SET
		const record = 'record' in msgMutation && msgMutation.record ? msgMutation.record : msgMutation
		let key
		try {
			key = await getKey(record.keyId.id)
		} catch (err) {
			if (isMissingKeyError(err)) throw err
			continue // other errors -> individual record corruption, skip and keep going
		}
		const content = record.value.blob
		const encContent = content.subarray(0, -32)
		const ogValueMac = content.subarray(-32)
		if (validateMacs) {
			const contentHmac = generateMac(operation, encContent, record.keyId.id, key.valueMacKey)
			if (Buffer.compare(contentHmac, ogValueMac) !== 0) continue
		}
		let result
		try {
			result = aesDecrypt(encContent, key.valueEncryptionKey)
		} catch {
			continue
		}
		const syncAction = proto.SyncActionData.decode(result)
		if (validateMacs) {
			const hmac = hmacSign(syncAction.index, key.indexKey)
			if (Buffer.compare(hmac, record.index.blob) !== 0) throw new Boom('HMAC index verification failed')
		}
		const indexStr = Buffer.from(syncAction.index).toString()
		onMutation({ syncAction, index: JSON.parse(indexStr) })
		ltGenerator.mix({ indexMac: record.index.blob, valueMac: ogValueMac, operation })
	}
	return ltGenerator.finish()
}

export const decodeSyncdPatch = async (msg, name, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
	if (validateMacs) {
		const base64Key = Buffer.from(msg.keyId.id).toString('base64')
		const mainKeyObj = await getAppStateSyncKey(base64Key)
		if (!mainKeyObj) throw new Boom(`failed to find key "${base64Key}" to decode patch`, { data: { isMissingKey: true, msg } })
		const mainKey = mutationKeys(mainKeyObj.keyData)
		const mutationmacs = msg.mutations.map(mutation => mutation.record.value.blob.slice(-32))
		const patchMac = generatePatchMac(msg.snapshotMac, mutationmacs, toNumber(msg.version.version), name, mainKey.patchMacKey)
		if (Buffer.compare(patchMac, msg.patchMac) !== 0) throw new Boom('Invalid patch mac')
	}
	return decodeSyncdMutations(msg.mutations, initialState, getAppStateSyncKey, onMutation, validateMacs)
}

export const extractSyncdPatches = async (result, options) => {
	const syncNode = getBinaryNodeChild(result, 'sync')
	const collectionNodes = getBinaryNodeChildren(syncNode, 'collection')
	const final = {}
	await Promise.all(
		collectionNodes.map(async collectionNode => {
			const patchesNode = getBinaryNodeChild(collectionNode, 'patches')
			const patches = getBinaryNodeChildren(patchesNode || collectionNode, 'patch')
			const snapshotNode = getBinaryNodeChild(collectionNode, 'snapshot')
			const syncds = []
			const name = collectionNode.attrs.name
			const hasMorePatches = collectionNode.attrs.has_more_patches === 'true'
			let snapshot
			if (snapshotNode?.content) {
				if (!Buffer.isBuffer(snapshotNode)) snapshotNode.content = Buffer.from(Object.values(snapshotNode.content))
				const blobRef = proto.ExternalBlobReference.decode(snapshotNode.content)
				const data = await downloadExternalBlob(blobRef, options)
				snapshot = proto.SyncdSnapshot.decode(data)
			}
			for (let { content } of patches) {
				if (content) {
					if (!Buffer.isBuffer(content)) content = Buffer.from(Object.values(content))
					const syncd = proto.SyncdPatch.decode(content)
					if (!syncd.version) syncd.version = { version: +collectionNode.attrs.version + 1 }
					syncds.push(syncd)
				}
			}
			final[name] = { patches: syncds, hasMorePatches, snapshot }
		})
	)
	return final
}

export const downloadExternalBlob = async (blob, options) => {
	const stream = await downloadContentFromMessage(blob, 'md-app-state', { options })
	const bufferArray = []
	for await (const chunk of stream) bufferArray.push(chunk)
	return Buffer.concat(bufferArray)
}

export const downloadExternalPatch = async (blob, options) => {
	const buffer = await downloadExternalBlob(blob, options)
	return proto.SyncdMutations.decode(buffer)
}

export const decodeSyncdSnapshot = async (name, snapshot, getAppStateSyncKey, minimumVersionNumber, validateMacs = true, logger) => {
	const newState = newLTHashState()
	newState.version = toNumber(snapshot.version.version)
	const mutationMap = {}
	const areMutationsRequired = typeof minimumVersionNumber === 'undefined' || newState.version > minimumVersionNumber
	const { hash, indexValueMap } = await decodeSyncdMutations(
		snapshot.records,
		newState,
		getAppStateSyncKey,
		areMutationsRequired
			? mutation => {
					const index = mutation.syncAction.index?.toString()
					mutationMap[index] = mutation
				}
			: () => {},
		validateMacs
	)
	newState.hash = hash
	newState.indexValueMap = indexValueMap
	if (validateMacs) {
		const base64Key = Buffer.from(snapshot.keyId.id).toString('base64')
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) throw new Boom(`failed to find key "${base64Key}" to decode mutation`, { data: { isMissingKey: true } })
		const result = mutationKeys(keyEnc.keyData)
		const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
		if (Buffer.compare(snapshot.mac, computedSnapshotMac) !== 0) {
			logger?.warn({ name, version: newState.version }, 'LTHash verification failed on snapshot, continuing with partial state')
		}
	}
	return { state: newState, mutationMap }
}

export const decodePatches = async (name, syncds, initial, getAppStateSyncKey, options, minimumVersionNumber, logger, validateMacs = true) => {
	const newState = { ...initial, indexValueMap: { ...initial.indexValueMap } }
	const mutationMap = {}
	for (const syncd of syncds) {
		const { version, keyId, snapshotMac } = syncd
		if (syncd.externalMutations) {
			logger?.trace({ name, version }, 'downloading external patch')
			const ref = await downloadExternalPatch(syncd.externalMutations, options)
			logger?.debug({ name, version, mutations: ref.mutations.length }, 'downloaded external patch')
			syncd.mutations?.push(...ref.mutations)
		}
		const patchVersion = toNumber(version.version)
		newState.version = patchVersion
		const shouldMutate = typeof minimumVersionNumber === 'undefined' || patchVersion > minimumVersionNumber
		let decodeResult
		try {
			decodeResult = await decodeSyncdPatch(
				syncd,
				name,
				newState,
				getAppStateSyncKey,
				shouldMutate
					? mutation => {
							const index = mutation.syncAction.index?.toString()
							mutationMap[index] = mutation
						}
					: () => {},
				validateMacs
			)
		} catch (err) {
			if (isMissingKeyError(err)) throw err
			logger?.warn({ name, version: patchVersion, error: err.message }, 'failed to decode patch, skipping')
			continue
		}
		newState.hash = decodeResult.hash
		newState.indexValueMap = decodeResult.indexValueMap
		if (validateMacs) {
			const base64Key = Buffer.from(keyId.id).toString('base64')
			const keyEnc = await getAppStateSyncKey(base64Key)
			if (!keyEnc) throw new Boom(`failed to find key "${base64Key}" to decode mutation`, { data: { isMissingKey: true } })
			const result = mutationKeys(keyEnc.keyData)
			const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
			if (Buffer.compare(snapshotMac, computedSnapshotMac) !== 0) {
				logger?.warn({ name, version: newState.version }, 'LTHash verification failed, skipping remaining patches')
				break
			}
		}
		syncd.mutations = [] // clear memory used up by the mutations
	}
	return { state: newState, mutationMap }
}

export const chatModificationToAppPatch = (mod, jid) => {
	const OP = proto.SyncdMutation.SyncdOperation
	const getMessageRange = lastMessages => {
		if (!Array.isArray(lastMessages)) return lastMessages
		const lastMsg = lastMessages[lastMessages.length - 1]
		return {
			lastMessageTimestamp: lastMsg?.messageTimestamp,
			messages: lastMessages?.length
				? lastMessages.map(m => {
						if (!m.key?.id || !m.key?.remoteJid) throw new Boom('Incomplete key', { statusCode: 400, data: m })
						if (isJidGroup(m.key.remoteJid) && !m.key.fromMe && !m.key.participant) {
							throw new Boom('Expected not from me message to have participant', { statusCode: 400, data: m })
						}
						if (!m.messageTimestamp || !toNumber(m.messageTimestamp)) throw new Boom('Missing timestamp in last message list', { statusCode: 400, data: m })
						if (m.key.participant) m.key.participant = jidNormalizedUser(m.key.participant)
						return m
					})
				: undefined
		}
	}
	let patch
	if ('mute' in mod) {
		patch = { syncAction: { muteAction: { muted: !!mod.mute, muteEndTimestamp: mod.mute || undefined } }, index: ['mute', jid], type: 'regular_high', apiVersion: 2, operation: OP.SET }
	} else if ('archive' in mod) {
		patch = {
			syncAction: { archiveChatAction: { archived: !!mod.archive, messageRange: getMessageRange(mod.lastMessages) } },
			index: ['archive', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('markRead' in mod) {
		patch = {
			syncAction: { markChatAsReadAction: { read: mod.markRead, messageRange: getMessageRange(mod.lastMessages) } },
			index: ['markChatAsRead', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('deleteForMe' in mod) {
		const { timestamp, key, deleteMedia } = mod.deleteForMe
		patch = {
			syncAction: { deleteMessageForMeAction: { deleteMedia, messageTimestamp: timestamp } },
			index: ['deleteMessageForMe', jid, key.id, key.fromMe ? '1' : '0', '0'],
			type: 'regular_high',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('clear' in mod) {
		patch = {
			syncAction: { clearChatAction: { messageRange: getMessageRange(mod.lastMessages) } },
			index: ['clearChat', jid, '1', '0'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pin' in mod) {
		patch = { syncAction: { pinAction: { pinned: !!mod.pin } }, index: ['pin_v1', jid], type: 'regular_low', apiVersion: 5, operation: OP.SET }
	} else if ('contact' in mod) {
		patch = { syncAction: { contactAction: mod.contact || {} }, index: ['contact', jid], type: 'critical_unblock_low', apiVersion: 2, operation: mod.contact ? OP.SET : OP.REMOVE }
	} else if ('disableLinkPreviews' in mod) {
		patch = {
			syncAction: { privacySettingDisableLinkPreviewsAction: mod.disableLinkPreviews || {} },
			index: ['setting_disableLinkPreviews'],
			type: 'regular',
			apiVersion: 8,
			operation: OP.SET
		}
	} else if ('star' in mod) {
		const key = mod.star.messages[0]
		patch = {
			syncAction: { starAction: { starred: !!mod.star.star } },
			index: ['star', jid, key.id, key.fromMe ? '1' : '0', '0'],
			type: 'regular_low',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('delete' in mod) {
		patch = { syncAction: { deleteChatAction: { messageRange: getMessageRange(mod.lastMessages) } }, index: ['deleteChat', jid, '1'], type: 'regular_high', apiVersion: 6, operation: OP.SET }
	} else if ('pushNameSetting' in mod) {
		patch = { syncAction: { pushNameSetting: { name: mod.pushNameSetting } }, index: ['setting_pushName'], type: 'critical_block', apiVersion: 1, operation: OP.SET }
	} else if ('quickReply' in mod) {
		patch = {
			syncAction: {
				quickReplyAction: {
					count: 0,
					deleted: mod.quickReply.deleted || false,
					keywords: [],
					message: mod.quickReply.message || '',
					shortcut: mod.quickReply.shortcut || ''
				}
			},
			index: ['quick_reply', mod.quickReply.timestamp || String(Math.floor(Date.now() / 1000))],
			type: 'regular',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('addLabel' in mod) {
		patch = {
			syncAction: { labelEditAction: { name: mod.addLabel.name, color: mod.addLabel.color, predefinedId: mod.addLabel.predefinedId, deleted: mod.addLabel.deleted } },
			index: ['label_edit', mod.addLabel.id],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addChatLabel' in mod) {
		patch = {
			syncAction: { labelAssociationAction: { labeled: true } },
			index: [LabelAssociationType.Chat, mod.addChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeChatLabel' in mod) {
		patch = {
			syncAction: { labelAssociationAction: { labeled: false } },
			index: [LabelAssociationType.Chat, mod.removeChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addMessageLabel' in mod) {
		patch = {
			syncAction: { labelAssociationAction: { labeled: true } },
			index: [LabelAssociationType.Message, mod.addMessageLabel.labelId, jid, mod.addMessageLabel.messageId, '0', '0'],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeMessageLabel' in mod) {
		patch = {
			syncAction: { labelAssociationAction: { labeled: false } },
			index: [LabelAssociationType.Message, mod.removeMessageLabel.labelId, jid, mod.removeMessageLabel.messageId, '0', '0'],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else {
		throw new Boom('not supported')
	}
	patch.syncAction.timestamp = Date.now()
	return patch
}

export const processSyncAction = (syncAction, ev, me, initialSyncOpts, logger) => {
	const isInitialSync = !!initialSyncOpts
	const accountSettings = initialSyncOpts?.accountSettings
	logger?.trace({ syncAction, initialSync: !!initialSyncOpts }, 'processing sync action')
	const {
		syncAction: { value: action },
		index: [type, id, msgId, fromMe]
	} = syncAction

	const getChatUpdateConditional = (id, msgRange) =>
		isInitialSync
			? data => {
					const chat = data.historySets.chats[id] || data.chatUpserts[id]
					if (chat) return msgRange ? isValidPatchBasedOnMessageRange(chat, msgRange) : true
				}
			: undefined
	const isValidPatchBasedOnMessageRange = (chat, msgRange) => {
		const lastMsgTimestamp = Number(msgRange?.lastMessageTimestamp || msgRange?.lastSystemMessageTimestamp || 0)
		const chatLastMsgTimestamp = Number(chat?.lastMessageRecvTimestamp || 0)
		return lastMsgTimestamp >= chatLastMsgTimestamp
	}

	if (action?.muteAction) {
		ev.emit('chats.update', [{ id, muteEndTime: action.muteAction?.muted ? toNumber(action.muteAction.muteEndTimestamp) : null, conditional: getChatUpdateConditional(id, undefined) }])
	} else if (action?.archiveChatAction || type === 'archive' || type === 'unarchive') {
		const archiveAction = action?.archiveChatAction
		const isArchived = archiveAction ? archiveAction.archived : type === 'archive'
		const msgRange = !accountSettings?.unarchiveChats ? undefined : archiveAction?.messageRange
		ev.emit('chats.update', [{ id, archived: isArchived, conditional: getChatUpdateConditional(id, msgRange) }])
	} else if (action?.markChatAsReadAction) {
		const markReadAction = action.markChatAsReadAction
		const isNullUpdate = isInitialSync && markReadAction.read
		ev.emit('chats.update', [
			{ id, unreadCount: isNullUpdate ? null : markReadAction?.read ? 0 : -1, conditional: getChatUpdateConditional(id, markReadAction?.messageRange) }
		])
	} else if (action?.deleteMessageForMeAction || type === 'deleteMessageForMe') {
		ev.emit('messages.delete', { keys: [{ remoteJid: id, id: msgId, fromMe: fromMe === '1' }] })
	} else if (action?.contactAction) {
		emitSyncActionResults(ev, processContactAction(action.contactAction, id, logger))
	} else if (action?.pushNameSetting) {
		const name = action?.pushNameSetting?.name
		if (name && me?.name !== name) ev.emit('creds.update', { me: { ...me, name } })
	} else if (action?.pinAction) {
		ev.emit('chats.update', [{ id, pinned: action.pinAction?.pinned ? toNumber(action.timestamp) : null, conditional: getChatUpdateConditional(id, undefined) }])
	} else if (action?.unarchiveChatsSetting) {
		const unarchiveChats = !!action.unarchiveChatsSetting.unarchiveChats
		ev.emit('creds.update', { accountSettings: { unarchiveChats } })
		logger?.info(`archive setting updated => '${action.unarchiveChatsSetting.unarchiveChats}'`)
		if (accountSettings) accountSettings.unarchiveChats = unarchiveChats
	} else if (action?.starAction || type === 'star') {
		let starred = action?.starAction?.starred
		if (typeof starred !== 'boolean') starred = syncAction.index[syncAction.index.length - 1] === '1'
		ev.emit('messages.update', [{ key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' }, update: { starred } }])
	} else if (action?.deleteChatAction || type === 'deleteChat') {
		if (!isInitialSync) ev.emit('chats.delete', [id])
	} else if (action?.labelEditAction) {
		const { name, color, deleted, predefinedId } = action.labelEditAction
		ev.emit('labels.edit', { id, name, color, deleted, predefinedId: predefinedId ? String(predefinedId) : undefined })
	} else if (action?.labelAssociationAction) {
		ev.emit('labels.association', {
			type: action.labelAssociationAction.labeled ? 'add' : 'remove',
			association:
				type === LabelAssociationType.Chat
					? { type: LabelAssociationType.Chat, chatId: syncAction.index[2], labelId: syncAction.index[1] }
					: { type: LabelAssociationType.Message, chatId: syncAction.index[2], messageId: syncAction.index[3], labelId: syncAction.index[1] }
		})
	} else if (action?.localeSetting?.locale) {
		ev.emit('settings.update', { setting: 'locale', value: action.localeSetting.locale })
	} else if (action?.timeFormatAction) {
		ev.emit('settings.update', { setting: 'timeFormat', value: action.timeFormatAction })
	} else if (action?.pnForLidChatAction) {
		if (action.pnForLidChatAction.pnJid) ev.emit('lid-mapping.update', { lid: id, pn: action.pnForLidChatAction.pnJid })
	} else if (action?.privacySettingRelayAllCalls) {
		ev.emit('settings.update', { setting: 'privacySettingRelayAllCalls', value: action.privacySettingRelayAllCalls })
	} else if (action?.statusPrivacy) {
		ev.emit('settings.update', { setting: 'statusPrivacy', value: action.statusPrivacy })
	} else if (action?.lockChatAction) {
		ev.emit('chats.lock', { id, locked: !!action.lockChatAction.locked })
	} else if (action?.privacySettingDisableLinkPreviewsAction) {
		ev.emit('settings.update', { setting: 'disableLinkPreviews', value: action.privacySettingDisableLinkPreviewsAction })
	} else if (action?.notificationActivitySettingAction?.notificationActivitySetting) {
		ev.emit('settings.update', { setting: 'notificationActivitySetting', value: action.notificationActivitySettingAction.notificationActivitySetting })
	} else if (action?.lidContactAction) {
		ev.emit('contacts.upsert', [
			{
				id,
				name: action.lidContactAction.fullName || action.lidContactAction.firstName || action.lidContactAction.username || undefined,
				username: action.lidContactAction.username || undefined,
				lid: id,
				phoneNumber: undefined
			}
		])
	} else if (action?.privacySettingChannelsPersonalisedRecommendationAction) {
		ev.emit('settings.update', { setting: 'channelsPersonalisedRecommendation', value: action.privacySettingChannelsPersonalisedRecommendationAction })
	} else {
		logger?.debug({ syncAction, id }, 'unprocessable update')
	}
}

/* ------------------------------------------------------------------ */
/* Sync action -> event mapping (pure)                                 */
/* ------------------------------------------------------------------ */

/** Process contactAction and return events to emit. Pure function - no side effects. */
export const processContactAction = (action, id, logger) => {
	const results = []
	if (!id) {
		logger?.warn({ hasFullName: !!action.fullName, hasLidJid: !!action.lidJid, hasPnJid: !!action.pnJid }, 'contactAction sync: missing id in index')
		return results
	}
	const lidJid = action.lidJid
	const idIsPn = isPnUser(id)
	const phoneNumber = idIsPn ? id : action.pnJid || undefined // PN is in index[1], not usually in contactAction.pnJid
	results.push({
		event: 'contacts.upsert',
		data: [{ id, name: action.fullName || action.firstName || action.username || undefined, username: action.username || undefined, lid: lidJid || undefined, phoneNumber }]
	})
	if (lidJid && isLidUser(lidJid) && idIsPn) results.push({ event: 'lid-mapping.update', data: { lid: lidJid, pn: id } })
	return results
}

export const emitSyncActionResults = (ev, results) => {
	for (const result of results) {
		if (result.event === 'contacts.upsert') ev.emit('contacts.upsert', result.data)
		else ev.emit('lid-mapping.update', result.data)
	}
}

/* ------------------------------------------------------------------ */
/* Event buffer                                                        */
/* ------------------------------------------------------------------ */

const BUFFERABLE_EVENT_SET = new Set([
	'messaging-history.set',
	'chats.upsert',
	'chats.update',
	'chats.delete',
	'contacts.upsert',
	'contacts.update',
	'messages.upsert',
	'messages.update',
	'messages.delete',
	'messages.reaction',
	'message-receipt.update',
	'groups.update'
])

const makeBufferData = () => ({
	historySets: { chats: {}, messages: {}, contacts: {}, isLatest: false, empty: true },
	chatUpserts: {},
	chatUpdates: {},
	chatDeletes: new Set(),
	contactUpserts: {},
	contactUpdates: {},
	messageUpserts: {},
	messageUpdates: {},
	messageReactions: {},
	messageDeletes: {},
	messageReceipts: {},
	groupUpdates: {}
})

const stringifyMessageKey = key => `${key.remoteJid},${key.id},${key.fromMe ? '1' : '0'}`

function concatChats(a, b) {
	if (b.unreadCount === null && a.unreadCount < 0) {
		a.unreadCount = undefined
		b.unreadCount = undefined
	}
	if (typeof a.unreadCount === 'number' && typeof b.unreadCount === 'number') {
		b = { ...b }
		if (b.unreadCount >= 0) b.unreadCount = Math.max(b.unreadCount, 0) + Math.max(a.unreadCount, 0)
	}
	return Object.assign(a, b)
}

function consolidateEvents(data) {
	const map = {}
	if (!data.historySets.empty) {
		map['messaging-history.set'] = {
			chats: Object.values(data.historySets.chats),
			messages: Object.values(data.historySets.messages),
			contacts: Object.values(data.historySets.contacts),
			pastParticipants: data.historySets.pastParticipants,
			syncType: data.historySets.syncType,
			progress: data.historySets.progress,
			isLatest: data.historySets.isLatest,
			chunkOrder: data.historySets.chunkOrder,
			peerDataRequestSessionId: data.historySets.peerDataRequestSessionId
		}
	}
	const chatUpsertList = Object.values(data.chatUpserts)
	if (chatUpsertList.length) map['chats.upsert'] = chatUpsertList
	const chatUpdateList = Object.values(data.chatUpdates)
	if (chatUpdateList.length) map['chats.update'] = chatUpdateList
	const chatDeleteList = Array.from(data.chatDeletes)
	if (chatDeleteList.length) map['chats.delete'] = chatDeleteList
	const messageUpsertList = Object.values(data.messageUpserts)
	if (messageUpsertList.length) map['messages.upsert'] = { messages: messageUpsertList.map(m => m.message), type: messageUpsertList[0].type }
	const messageUpdateList = Object.values(data.messageUpdates)
	if (messageUpdateList.length) map['messages.update'] = messageUpdateList
	const messageDeleteList = Object.values(data.messageDeletes)
	if (messageDeleteList.length) map['messages.delete'] = { keys: messageDeleteList }
	const messageReactionList = Object.values(data.messageReactions).flatMap(({ key, reactions }) => reactions.flatMap(reaction => ({ key, reaction })))
	if (messageReactionList.length) map['messages.reaction'] = messageReactionList
	const messageReceiptList = Object.values(data.messageReceipts).flatMap(({ key, userReceipt }) => userReceipt.flatMap(receipt => ({ key, receipt })))
	if (messageReceiptList.length) map['message-receipt.update'] = messageReceiptList
	const contactUpsertList = Object.values(data.contactUpserts)
	if (contactUpsertList.length) map['contacts.upsert'] = contactUpsertList
	const contactUpdateList = Object.values(data.contactUpdates)
	if (contactUpdateList.length) map['contacts.update'] = contactUpdateList
	const groupUpdateList = Object.values(data.groupUpdates)
	if (groupUpdateList.length) map['groups.update'] = groupUpdateList
	return map
}

function append(data, historyCache, event, eventData, logger) {
	switch (event) {
		case 'messaging-history.set': {
			for (const chat of eventData.chats) {
				const id = chat.id || ''
				const existingChat = data.historySets.chats[id]
				if (existingChat) existingChat.endOfHistoryTransferType = chat.endOfHistoryTransferType
				if (!existingChat && !historyCache.has(id)) {
					data.historySets.chats[id] = chat
					historyCache.add(id)
					absorbingChatUpdate(chat)
				}
			}
			for (const contact of eventData.contacts) {
				const existingContact = data.historySets.contacts[contact.id]
				if (existingContact) {
					Object.assign(existingContact, trimUndefined(contact))
				} else {
					const historyContactId = `c:${contact.id}`
					const hasAnyName = contact.notify || contact.name || contact.verifiedName
					if (!historyCache.has(historyContactId) || hasAnyName) {
						data.historySets.contacts[contact.id] = contact
						historyCache.add(historyContactId)
					}
				}
			}
			for (const message of eventData.messages) {
				const key = stringifyMessageKey(message.key)
				const existingMsg = data.historySets.messages[key]
				if (!existingMsg && !historyCache.has(key)) {
					data.historySets.messages[key] = message
					historyCache.add(key)
				}
			}
			data.historySets.empty = false
			data.historySets.syncType = eventData.syncType
			if (eventData.pastParticipants?.length) {
				const merged = new Map()
				const sigOf = p => `${p.userJid || ''}:${p.leaveTs || ''}:${p.leaveReason || ''}`
				const ingest = entry => {
					const key = entry.groupJid ?? JSON.stringify(entry)
					const existing = merged.get(key)
					if (!existing) {
						merged.set(key, { ...entry, pastParticipants: [...(entry.pastParticipants || [])] })
						return
					}
					const seen = new Set((existing.pastParticipants || []).map(sigOf))
					for (const p of entry.pastParticipants || []) {
						const sig = sigOf(p)
						if (!seen.has(sig)) {
							existing.pastParticipants.push(p)
							seen.add(sig)
						}
					}
				}
				for (const entry of data.historySets.pastParticipants || []) ingest(entry)
				for (const entry of eventData.pastParticipants) ingest(entry)
				data.historySets.pastParticipants = [...merged.values()]
			}
			data.historySets.progress = eventData.progress
			data.historySets.chunkOrder = eventData.chunkOrder
			data.historySets.peerDataRequestSessionId = eventData.peerDataRequestSessionId
			data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest
			break
		}
		case 'chats.upsert':
			for (const chat of eventData) {
				const id = chat.id || ''
				let upsert = data.chatUpserts[id]
				if (id && !upsert) {
					upsert = data.historySets.chats[id]
					if (upsert) logger.debug({ chatId: id }, 'absorbed chat upsert in chat set')
				}
				if (upsert) upsert = concatChats(upsert, chat)
				else {
					upsert = chat
					data.chatUpserts[id] = upsert
				}
				absorbingChatUpdate(upsert)
				if (data.chatDeletes.has(id)) data.chatDeletes.delete(id)
			}
			break
		case 'chats.update':
			for (const update of eventData) {
				const chatId = update.id
				const conditionMatches = update.conditional ? update.conditional(data) : true
				if (conditionMatches) {
					delete update.conditional
					const upsert = data.historySets.chats[chatId] || data.chatUpserts[chatId]
					if (upsert) concatChats(upsert, update)
					else {
						const chatUpdate = data.chatUpdates[chatId] || {}
						data.chatUpdates[chatId] = concatChats(chatUpdate, update)
					}
				} else if (conditionMatches === undefined) {
					data.chatUpdates[chatId] = update
				}
				if (data.chatDeletes.has(chatId)) data.chatDeletes.delete(chatId)
			}
			break
		case 'chats.delete':
			for (const chatId of eventData) {
				if (!data.chatDeletes.has(chatId)) data.chatDeletes.add(chatId)
				if (data.chatUpdates[chatId]) delete data.chatUpdates[chatId]
				if (data.chatUpserts[chatId]) delete data.chatUpserts[chatId]
				if (data.historySets.chats[chatId]) delete data.historySets.chats[chatId]
			}
			break
		case 'contacts.upsert':
			for (const contact of eventData) {
				let upsert = data.contactUpserts[contact.id]
				if (!upsert) {
					upsert = data.historySets.contacts[contact.id]
					if (upsert) logger.debug({ contactId: contact.id }, 'absorbed contact upsert in contact set')
				}
				if (upsert) upsert = Object.assign(upsert, trimUndefined(contact))
				else {
					upsert = contact
					data.contactUpserts[contact.id] = upsert
				}
				if (data.contactUpdates[contact.id]) {
					Object.assign(data.contactUpdates[contact.id], trimUndefined(contact))
					delete data.contactUpdates[contact.id]
				}
			}
			break
		case 'contacts.update':
			for (const update of eventData) {
				const id = update.id
				const upsert = data.historySets.contacts[id] || data.contactUpserts[id]
				if (upsert) {
					Object.assign(upsert, update)
				} else {
					const contactUpdate = data.contactUpdates[id] || {}
					data.contactUpdates[id] = Object.assign(contactUpdate, update)
				}
			}
			break
		case 'messages.upsert': {
			const { messages, type } = eventData
			for (const message of messages) {
				const key = stringifyMessageKey(message.key)
				let existing = data.messageUpserts[key]?.message
				if (!existing) {
					existing = data.historySets.messages[key]
					if (existing) logger.debug({ messageId: key }, 'absorbed message upsert in message set')
				}
				if (existing) message.messageTimestamp = existing.messageTimestamp
				if (data.messageUpdates[key]) {
					logger.debug('absorbed prior message update in message upsert')
					Object.assign(message, data.messageUpdates[key].update)
					delete data.messageUpdates[key]
				}
				if (data.historySets.messages[key]) data.historySets.messages[key] = message
				else data.messageUpserts[key] = { message, type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type }
			}
			break
		}
		case 'messages.update':
			for (const { key, update } of eventData) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.historySets.messages[keyStr] || data.messageUpserts[keyStr]?.message
				if (existing) {
					Object.assign(existing, update)
					if (update.status === WAMessageStatus.READ && !key.fromMe) decrementChatReadCounterIfMsgDidUnread(existing)
				} else {
					const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} }
					Object.assign(msgUpdate.update, update)
					data.messageUpdates[keyStr] = msgUpdate
				}
			}
			break
		case 'messages.delete':
			if ('keys' in eventData) {
				for (const key of eventData.keys) {
					const keyStr = stringifyMessageKey(key)
					if (!data.messageDeletes[keyStr]) data.messageDeletes[keyStr] = key
					if (data.messageUpserts[keyStr]) delete data.messageUpserts[keyStr]
					if (data.messageUpdates[keyStr]) delete data.messageUpdates[keyStr]
				}
			}
			break
		case 'messages.reaction':
			for (const { key, reaction } of eventData) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateMessageWithReaction(existing.message, reaction)
				} else {
					data.messageReactions[keyStr] = data.messageReactions[keyStr] || { key, reactions: [] }
					updateMessageWithReaction(data.messageReactions[keyStr], reaction)
				}
			}
			break
		case 'message-receipt.update':
			for (const { key, receipt } of eventData) {
				const keyStr = stringifyMessageKey(key)
				const existing = data.messageUpserts[keyStr]
				if (existing) {
					updateMessageWithReceipt(existing.message, receipt)
				} else {
					data.messageReceipts[keyStr] = data.messageReceipts[keyStr] || { key, userReceipt: [] }
					updateMessageWithReceipt(data.messageReceipts[keyStr], receipt)
				}
			}
			break
		case 'groups.update':
			for (const update of eventData) {
				const id = update.id
				if (!data.groupUpdates[id]) data.groupUpdates[id] = Object.assign({}, update)
			}
			break
		default:
			throw new Error(`"${event}" cannot be buffered`)
	}

	function absorbingChatUpdate(existing) {
		const chatId = existing.id || ''
		const update = data.chatUpdates[chatId]
		if (update) {
			const conditionMatches = update.conditional ? update.conditional(data) : true
			if (conditionMatches) {
				delete update.conditional
				logger.debug({ chatId }, 'absorbed chat update in existing chat')
				Object.assign(existing, concatChats(update, existing))
				delete data.chatUpdates[chatId]
			} else if (conditionMatches === false) {
				logger.debug({ chatId }, 'chat update condition fail, removing')
				delete data.chatUpdates[chatId]
			}
		}
	}
	function decrementChatReadCounterIfMsgDidUnread(message) {
		const chatId = message.key.remoteJid
		const chat = data.chatUpdates[chatId] || data.chatUpserts[chatId]
		if (isRealMessage(message) && shouldIncrementChatUnread(message) && typeof chat?.unreadCount === 'number' && chat.unreadCount > 0) {
			logger.debug({ chatId: chat.id }, 'decrementing chat counter')
			chat.unreadCount -= 1
			if (chat.unreadCount === 0) delete chat.unreadCount
		}
	}
}

/** The event buffer logically consolidates different events into a single event, making data processing more efficient. */
export const makeEventBuffer = logger => {
	const ev = new EventEmitter()
	const historyCache = new Set()
	let data = makeBufferData()
	let isBuffering = false
	let bufferTimeout = null
	let flushPendingTimeout = null
	let bufferCount = 0
	const MAX_HISTORY_CACHE_SIZE = 10000
	const BUFFER_TIMEOUT_MS = 30000

	ev.on('event', map => {
		for (const event in map) ev.emit(event, map[event])
	})

	function buffer() {
		if (!isBuffering) {
			logger.debug('Event buffer activated')
			isBuffering = true
			bufferCount = 0
			if (bufferTimeout) clearTimeout(bufferTimeout)
			bufferTimeout = setTimeout(() => {
				if (isBuffering) {
					logger.warn('Buffer timeout reached, auto-flushing')
					flush()
				}
			}, BUFFER_TIMEOUT_MS)
		}
		bufferCount++
	}

	function flush() {
		if (!isBuffering) return false
		logger.debug({ bufferCount }, 'Flushing event buffer')
		isBuffering = false
		bufferCount = 0
		if (bufferTimeout) {
			clearTimeout(bufferTimeout)
			bufferTimeout = null
		}
		if (flushPendingTimeout) {
			clearTimeout(flushPendingTimeout)
			flushPendingTimeout = null
		}
		if (historyCache.size > MAX_HISTORY_CACHE_SIZE) {
			logger.debug({ cacheSize: historyCache.size }, 'Clearing history cache')
			historyCache.clear()
		}
		const newData = makeBufferData()
		const chatUpdates = Object.values(data.chatUpdates)
		let conditionalChatUpdatesLeft = 0
		for (const update of chatUpdates) {
			if (update.conditional) {
				conditionalChatUpdatesLeft += 1
				newData.chatUpdates[update.id] = update
				delete data.chatUpdates[update.id]
			}
		}
		const consolidatedData = consolidateEvents(data)
		if (Object.keys(consolidatedData).length) ev.emit('event', consolidatedData)
		data = newData
		logger.trace({ conditionalChatUpdatesLeft }, 'released buffered events')
		return true
	}

	return {
		process(handler) {
			const listener = async map => {
				await handler(map)
			}
			ev.on('event', listener)
			return () => ev.off('event', listener)
		},
		emit(event, evData) {
			if (event === 'messages.upsert') {
				const { type } = evData
				const existingUpserts = Object.values(data.messageUpserts)
				if (existingUpserts.length > 0) {
					const bufferedType = existingUpserts[0].type
					if (bufferedType !== type) {
						logger.debug({ bufferedType, newType: type }, 'messages.upsert type mismatch, emitting buffered messages')
						ev.emit('event', { 'messages.upsert': { messages: existingUpserts.map(m => m.message), type: bufferedType } })
						data.messageUpserts = {}
					}
				}
			}
			if (isBuffering && BUFFERABLE_EVENT_SET.has(event)) {
				append(data, historyCache, event, evData, logger)
				return true
			}
			return ev.emit('event', { [event]: evData })
		},
		isBuffering: () => isBuffering,
		buffer,
		flush,
		createBufferedFunction(work) {
			return async (...args) => {
				buffer()
				try {
					const result = await work(...args)
					if (bufferCount === 1) {
						setTimeout(() => {
							if (isBuffering && bufferCount === 1) flush()
						}, 100)
					}
					return result
				} finally {
					bufferCount = Math.max(0, bufferCount - 1)
					if (bufferCount === 0 && !flushPendingTimeout) flushPendingTimeout = setTimeout(flush, 100)
				}
			}
		},
		on: (...args) => ev.on(...args),
		off: (...args) => ev.off(...args),
		removeAllListeners: (...args) => ev.removeAllListeners(...args),
		destroy() {
			if (bufferTimeout) {
				clearTimeout(bufferTimeout)
				bufferTimeout = null
			}
			if (flushPendingTimeout) {
				clearTimeout(flushPendingTimeout)
				flushPendingTimeout = null
			}
			historyCache.clear()
			data = makeBufferData()
			isBuffering = false
			bufferCount = 0
			ev.removeAllListeners()
			logger.debug('Event buffer destroyed')
		}
	}
}

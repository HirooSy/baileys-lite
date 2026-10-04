import { randomBytes } from 'node:crypto'
import { URL } from 'node:url'
import { promisify } from 'node:util'
import { proto } from '../../WAProto/index.js'
import { Boom } from '../foundation/boom.js'
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, NOISE_WA_HEADER, PROCESSABLE_HISTORY_TYPES, TimeMs, UPLOAD_TIMEOUT } from '../defaults.js'
import { QueryIds, ReachoutTimelockEnforcementType, DisconnectReason, XWAPaths } from '../constants.js'
import {
	aesEncryptCTR,
	bindWaitForConnectionUpdate,
	buildPairingQRData,
	bytesToCrockford,
	configureSuccessfulPairing,
	Curve,
	derivePairingCodeKey,
	generateLoginNode,
	generateMdTagPrefix,
	generateRegistrationNode,
	getCodeFromWSError,
	getCompanionPlatformId,
	getErrorCodeFromStreamError,
	getNextPreKeysNode,
	makeNoiseHandler,
	promiseTimeout,
	signedKeyPair,
	xmppSignedPreKey
} from '../utils/wa-protocol-core.js'
import { addTransactionCapability } from '../utils/auth-state-core.js'
import { makeEventBuffer } from '../utils/chat-sync.js'
import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isLidUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET } from '../binary/wa-binary.js'
import { BinaryInfo } from '../wam/wam.js'
import { USyncQuery, USyncUser } from './usync.js'
import { normalizeUsername, isValidUsername, isValidUsernameKey } from '../utils/username.js'
import { WebSocketClient } from '../socket-client/websocket-client.js'
import { generateQR } from '../foundation/qrcode-terminal.js'

const wMexQuery = (variables, queryId, query, generateMessageTag) =>
	query({
		tag: 'iq',
		attrs: { id: generateMessageTag(), type: 'get', to: S_WHATSAPP_NET, xmlns: 'w:mex' },
		content: [{ tag: 'query', attrs: { query_id: queryId }, content: Buffer.from(JSON.stringify({ variables }), 'utf-8') }]
	})

export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag) => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	if (child?.content) {
		const data = JSON.parse(child.content.toString())
		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map(err => err.message || 'Unknown error').join(', ')
			const firstError = data.errors[0]
			const errorCode = firstError.extensions?.error_code || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}
		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') return response
	}
	const action = (dataPath || '').startsWith('xwa2_') ? dataPath.substring(5).replace(/_/g, ' ') : dataPath?.replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}

export const makeSocket = config => {
	const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config
	const publicWAMBuffer = new BinaryInfo()
	let serverTimeOffsetMs = 0
	const uqTagId = generateMdTagPrefix()
	const generateMessageTag = () => `${uqTagId}${epoch++}`

	if (browser[1].toLocaleLowerCase().includes('android')) {
		logger.warn('⚠️ Using the Android browser is experimental and may lead to unexpected behavior. Use at your own risk.')
	}

	const syncDisabled = PROCESSABLE_HISTORY_TYPES.map(syncType => config.shouldSyncHistoryMessage({ syncType })).filter(x => x === false).length === PROCESSABLE_HISTORY_TYPES.length
	if (syncDisabled) {
		logger.warn('⚠️ DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS FROM ACCESSING INITIAL LID MAPPINGS, LEADING TO INSTABILIY AND SESSION ERRORS')
	}

	const url = new URL(typeof waWebSocketUrl === 'string' ? waWebSocketUrl : waWebSocketUrl.href) // salinan: jangan mutasi URL milik pemanggil
	if (config.mobile || url.protocol === 'tcp:') throw new Boom('Mobile API is not supported anymore', { statusCode: DisconnectReason.loggedOut })
	const routingInfo = authState?.creds?.routingInfo
	let wsConfig = config
	if (routingInfo?.length && !config.disableStickyRouting && (url.protocol === 'wss:' || url.protocol === 'ws:')) {
		if (!url.searchParams.has('ED')) url.searchParams.set('ED', Buffer.from(routingInfo).toString('base64url'))
		const headers = { ...(config.options?.headers || {}) }
		const cookieKey = Object.keys(headers).find(k => k.toLowerCase() === 'cookie')
		const cookie = cookieKey ? headers[cookieKey] : ''
		if (cookieKey) delete headers[cookieKey]
		headers.Cookie = cookie.includes('sticky_routing=') ? cookie : cookie ? `${cookie}; sticky_routing=` : 'sticky_routing='
		wsConfig = { ...config, options: { ...(config.options || {}), headers } }
	}

	const ephemeralKeyPair = Curve.generateKeyPair()

	const noise = makeNoiseHandler({ keyPair: ephemeralKeyPair, NOISE_HEADER: NOISE_WA_HEADER, logger, routingInfo: authState?.creds?.routingInfo })

	const ws = new WebSocketClient(url, wsConfig)
	ws.connect()
	const sendPromise = promisify(ws.send)

	const sendRawMessage = async data => {
		if (!ws.isOpen) throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		const bytes = noise.encodeFrame(data)
		await promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
			try {
				await sendPromise.call(ws, bytes)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	}

	const sendNode = frame => {
		if (logger.level === 'trace') logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' })
		const buff = encodeBinaryNode(frame)
		return sendRawMessage(buff)
	}

	const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
		let onRecv
		let onErr
		try {
			return await promiseTimeout(timeoutMs, (resolve, reject) => {
				onRecv = data => resolve(data)
				onErr = err => reject(err || new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed }))
				ws.on(`TAG:${msgId}`, onRecv)
				ws.on('close', onErr)
				ws.on('error', onErr)
				return () => reject(new Boom('Query Cancelled'))
			})
		} catch (error) {
			if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
				logger?.warn?.({ msgId }, 'timed out waiting for message')
				return undefined
			}
			throw error
		} finally {
			if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
			if (onErr) {
				ws.off('close', onErr)
				ws.off('error', onErr)
			}
		}
	}

	const query = async (node, timeoutMs) => {
		if (!node.attrs.id) node.attrs.id = generateMessageTag()
		const msgId = node.attrs.id
		const result = await promiseTimeout(timeoutMs, async (resolve, reject) => {
			const result_ = waitForMessage(msgId, timeoutMs).catch(reject)
			sendNode(node)
				.then(async () => resolve(await result_))
				.catch(reject)
		})
		if (result && 'tag' in result) assertNodeErrorFree(result)
		return result
	}

	const digestKeyBundle = async () => {
		const res = await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' }, content: [{ tag: 'digest', attrs: {} }] })
		const digestNode = getBinaryNodeChild(res, 'digest')
		if (!digestNode) {
			await uploadPreKeys()
			throw new Error('encrypt/get digest returned no digest node')
		}
	}

	const rotateSignedPreKey = async () => {
		const newId = (creds.signedPreKey.keyId || 0) + 1
		const skey = await signedKeyPair(creds.signedIdentityKey, newId)
		await query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' }, content: [{ tag: 'rotate', attrs: {}, content: [xmppSignedPreKey(skey)] }] })
		ev.emit('creds.update', { signedPreKey: skey })
	}

	const executeUSyncQuery = async usyncQuery => {
		if (usyncQuery.protocols.length === 0) throw new Boom('USyncQuery must have at least one protocol')

		const validUsers = usyncQuery.users
		const userNodes = validUsers.map(user => ({
			tag: 'user',
			attrs: { jid: !user.phone ? user.id : undefined },
			content: usyncQuery.protocols.map(a => a.getUserElement(user)).filter(a => a !== null)
		}))
		const listNode = { tag: 'list', attrs: {}, content: userNodes }
		const queryNode = { tag: 'query', attrs: {}, content: usyncQuery.protocols.map(a => a.getQueryElement()) }
		const iq = {
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
			content: [{ tag: 'usync', attrs: { context: usyncQuery.context, mode: usyncQuery.mode, sid: generateMessageTag(), last: 'true', index: '0' }, content: [queryNode, listNode] }]
		}
		const result = await query(iq)
		return usyncQuery.parseUSyncQueryResult(result)
	}

	const onWhatsApp = async (...phoneNumber) => {
		let usyncQuery = new USyncQuery()
		let contactEnabled = false
		for (const jid of phoneNumber) {
			if (isLidUser(jid)) {
				logger?.warn('LIDs are not supported with onWhatsApp')
				continue
			}
			if (!contactEnabled) {
				contactEnabled = true
				usyncQuery = usyncQuery.withContactProtocol()
			}
			const phone = `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}`
			usyncQuery.withUser(new USyncUser().withPhone(phone))
		}
		if (usyncQuery.users.length === 0) return []
		const results = await executeUSyncQuery(usyncQuery)
		if (results) return results.list.filter(a => !!a.contact).map(({ contact, id }) => ({ jid: id, exists: contact }))
	}

	const pnFromLIDUSync = async jids => {
		const usyncQuery = new USyncQuery().withLIDProtocol().withContext('background')
		for (const jid of jids) {
			if (isLidUser(jid)) {
				logger?.warn('LID user found in LID fetch call')
				continue
			}
			usyncQuery.withUser(new USyncUser().withId(jid))
		}
		if (usyncQuery.users.length === 0) return []
		const results = await executeUSyncQuery(usyncQuery)
		return results ? results.list.filter(a => !!a.lid).map(({ lid, id }) => ({ pn: id, lid })) : []
	}

	const resolveUsername = async (handle, usernameKey) => {
		const username = normalizeUsername(handle)
		if (!isValidUsername(username)) throw new Boom('Invalid username', { statusCode: 400 })
		if (usernameKey !== undefined && !isValidUsernameKey(usernameKey)) {
			throw new Boom('Invalid username key: expected a 4-digit string', { statusCode: 400 })
		}

		const usyncUser = new USyncUser().withUsername(username)
		if (usernameKey) usyncUser.withUsernameKey(usernameKey)

		const usyncQuery = new USyncQuery().withContactProtocol().withUser(usyncUser)
		const userNode = {
			tag: 'user',
			attrs: {},
			content: [usyncQuery.protocols[0].getUserElement(usyncUser)].filter(a => a !== null)
		}
		const iq = {
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
			content: [
				{
					tag: 'usync',
					attrs: { context: usyncQuery.context, mode: usyncQuery.mode, sid: generateMessageTag(), last: 'true', index: '0' },
					content: [
						{ tag: 'query', attrs: {}, content: [{ tag: 'contact', attrs: {} }] },
						{ tag: 'list', attrs: {}, content: [userNode] }
					]
				}
			]
		}

		const result = await query(iq)
		const usyncNode = getBinaryNodeChild(result, 'usync')
		const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined
		const resultUserNode = listNode ? getBinaryNodeChild(listNode, 'user') : undefined
		if (!resultUserNode) return { status: 'not-found' }

		const contactNode = getBinaryNodeChild(resultUserNode, 'contact')
		if (!contactNode) return { status: 'not-found' }

		const errorNode = getBinaryNodeChild(contactNode, 'error')
		if (errorNode) {

			return { status: 'key-required' }
		}

		if (contactNode.attrs?.type !== 'in') return { status: 'not-found' }

		const jid = resultUserNode.attrs?.jid
		if (!jid) return { status: 'key-required' }

		return { status: 'ok', jid: jidNormalizedUser(jid) }
	}

	const ev = makeEventBuffer(logger)
	const { creds } = authState

	const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
	const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)
	let lastDateRecv
	let epoch = 1
	let keepAliveReq
	let qrTimer
	let closed = false
	const socketEndHandlers = []

	const onUnexpectedError = (err, msg) => {
		logger.error({ err }, `unexpected error in '${msg}'`)
	}

	const awaitNextMessage = async sendMsg => {
		if (!ws.isOpen) throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		let onOpen
		let onClose
		const result = promiseTimeout(connectTimeoutMs, (resolve, reject) => {
			onOpen = resolve
			onClose = mapWebSocketError(reject)
			ws.on('frame', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('frame', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})
		if (sendMsg) sendRawMessage(sendMsg).catch(onClose)
		return result
	}

	const validateConnection = async () => {
		let helloMsg = { clientHello: { ephemeral: ephemeralKeyPair.public } }
		helloMsg = proto.HandshakeMessage.fromObject(helloMsg)
		logger.info({ browser, helloMsg }, 'connected to WA')
		const init = proto.HandshakeMessage.encode(helloMsg).finish()
		const result = await awaitNextMessage(init)
		const handshake = proto.HandshakeMessage.decode(result)
		logger.trace({ handshake }, 'handshake recv from WA')
		const keyEnc = noise.processHandshake(handshake, creds.noiseKey)
		let node
		if (!creds.me) {
			node = generateRegistrationNode(creds, config)
			logger.info({ node }, 'not logged in, attempting registration...')
		} else {
			node = generateLoginNode(creds.me.id, config)
			logger.info({ node }, 'logging in...')
		}
		const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish())
		await sendRawMessage(proto.HandshakeMessage.encode({ clientFinish: { static: keyEnc, payload: payloadEnc } }).finish())
		await noise.finishInit()
		startKeepAliveRequest()
	}

	const getAvailablePreKeysOnServer = async () => {
		const result = await query({ tag: 'iq', attrs: { id: generateMessageTag(), xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET }, content: [{ tag: 'count', attrs: {} }] })
		const countChild = getBinaryNodeChild(result, 'count')
		return +countChild.attrs.value
	}

	let uploadPreKeysPromise = null

	const uploadPreKeys = async (count = MIN_PREKEY_COUNT) => {
		if (uploadPreKeysPromise) {
			logger.debug('Pre-key upload already in progress, waiting for completion')
			await uploadPreKeysPromise
			return
		}
		const uploadLogic = async retryCount => {
			logger.info({ count, retryCount }, 'uploading pre-keys')

			const node = await keys.transaction(async () => {
				logger.debug({ requestedCount: count }, 'generating pre-keys with requested count')
				const { update, node: node_ } = await getNextPreKeysNode({ creds, keys }, count)
				ev.emit('creds.update', update)
				return node_
			}, creds?.me?.id || 'upload-pre-keys')
			try {
				await query(node)
				logger.info({ count }, 'uploaded pre-keys successfully')
			} catch (uploadError) {
				logger.error({ uploadError: uploadError.toString(), count }, 'Failed to upload pre-keys to server')
				if (retryCount < 3) {
					const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000)
					logger.info(`Retrying pre-key upload in ${backoffDelay}ms`)
					await new Promise(resolve => setTimeout(resolve, backoffDelay))
					return uploadLogic(retryCount + 1)
				}
				throw uploadError
			}
		}
		uploadPreKeysPromise = Promise.race([
			uploadLogic(0),
			new Promise((_, reject) => setTimeout(() => reject(new Boom('Pre-key upload timeout', { statusCode: 408 })), UPLOAD_TIMEOUT))
		])
		try {
			await uploadPreKeysPromise
		} finally {
			uploadPreKeysPromise = null
		}
	}

	const verifyCurrentPreKeyExists = async () => {
		const currentPreKeyId = creds.nextPreKeyId - 1
		if (currentPreKeyId <= 0) return { exists: false, currentPreKeyId: 0 }
		const preKeys = await keys.get('pre-key', [currentPreKeyId.toString()])
		return { exists: !!preKeys[currentPreKeyId.toString()], currentPreKeyId }
	}

	const uploadPreKeysToServerIfRequired = async () => {
		try {
			let count = 0
			const preKeyCount = await getAvailablePreKeysOnServer()
			count = preKeyCount === 0 ? INITIAL_PREKEY_COUNT : MIN_PREKEY_COUNT
			const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()
			logger.info(`${preKeyCount} pre-keys found on server`)
			logger.info(`Current prekey ID: ${currentPreKeyId}, exists in storage: ${currentPreKeyExists}`)
			const lowServerCount = preKeyCount <= count
			const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0
			const shouldUpload = lowServerCount || missingCurrentPreKey
			if (shouldUpload) {
				const reasons = []
				if (lowServerCount) reasons.push(`server count low (${preKeyCount})`)
				if (missingCurrentPreKey) reasons.push(`current prekey ${currentPreKeyId} missing from storage`)
				logger.info(`Uploading PreKeys due to: ${reasons.join(', ')}`)
				await uploadPreKeys(count)
			} else {
				logger.info(`PreKey validation passed - Server: ${preKeyCount}, Current prekey ${currentPreKeyId} exists`)
			}
		} catch (error) {
			logger.error({ error }, 'Failed to check/upload pre-keys during initialization')

		}
	}

	const onMessageReceived = async data => {
		try {
		await noise.decodeFrame(data, frame => {
			lastDateRecv = new Date()
			let anyTriggered = false
			anyTriggered = ws.emit('frame', frame)
			if (!(frame instanceof Uint8Array)) {
				const msgId = frame.attrs.id
				if (logger.level === 'trace') logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' })
				anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
				const l0 = frame.tag
				const l1 = frame.attrs || {}
				const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''
				for (const key of Object.keys(l1)) {
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
				}
				anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
				anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered
				if (!anyTriggered && logger.level === 'debug') logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv')
			}
		})
		} catch (err) {
			// satu-satunya error yang sampai sini: gagal decrypt frame (counter noise tidak sinkron) -> koneksi tidak bisa dipakai lagi.
			// ditangani agar tidak jadi unhandled rejection yang mematikan proses.
			if (closed) return
			logger.error({ err }, 'failed to process inbound frame, closing connection')
			void end(new Boom('Connection Terminated (inbound frame failed)', { statusCode: DisconnectReason.connectionLost, data: { cause: err } }))
		}
	}

	const end = async error => {
		if (closed) {
			logger.trace({ trace: error?.stack }, 'connection already closed')
			return
		}
		closed = true
		logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed')
		clearInterval(keepAliveReq)
		clearTimeout(qrTimer)

		consecutivePingFailures = 0

		ws.removeAllListeners()
		ws.on('error', () => {}) // error telat dari socket yang sedang ditutup tidak boleh jadi uncaught exception

		noise.destroy?.()
		signalRepository.close?.()
		if (!ws.isClosed && !ws.isClosing) {
			try {

				await Promise.race([ws.close(), new Promise(resolve => setTimeout(resolve, 5000))])
			} catch {

			}
		}
		for (const handler of socketEndHandlers) {
			try {
				await handler(error)
			} catch (err) {
				logger.error({ err }, 'error in socket end handler')
			}
		}
		ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
		ev.removeAllListeners('connection.update')
		ev.destroy()
	}

	const waitForSocketOpen = async () => {
		if (ws.isOpen) return
		if (ws.isClosed || ws.isClosing) throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		let onOpen
		let onClose
		await new Promise((resolve, reject) => {
			onOpen = () => resolve(undefined)
			onClose = mapWebSocketError(reject)
			ws.on('open', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('open', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})
	}

	let keepAliveInFlight = false

	let consecutivePingFailures = 0
	const MAX_PING_FAILURES = 3
	const startKeepAliveRequest = () =>
		(keepAliveReq = setInterval(() => {
			if (!lastDateRecv) lastDateRecv = new Date()
			const diff = Date.now() - lastDateRecv.getTime()

			if (diff > keepAliveIntervalMs * 2 + 5000) {
				logger.warn({ diff, keepAliveIntervalMs }, 'connection silent for too long')
				void end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }))
				return
			}
			if (!ws.isOpen) {
				logger.warn('keep alive called when WS not open')
				return
			}
			if (keepAliveInFlight) {
				logger.trace('keep alive skipped: ping already in flight')
				return
			}

			if (diff < keepAliveIntervalMs / 2) {
				logger.trace('keep alive skipped: recent inbound activity', { diff })
				return
			}
			keepAliveInFlight = true
			query({ tag: 'iq', attrs: { id: generateMessageTag(), to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }, keepAliveIntervalMs)
				.then(() => {

					consecutivePingFailures = 0
				})
				.catch(err => {
					consecutivePingFailures++
					logger.warn({ trace: err.stack, consecutivePingFailures, maxFailures: MAX_PING_FAILURES }, 'keep alive ping failed')
					if (consecutivePingFailures >= MAX_PING_FAILURES) {
						logger.warn('max ping failures reached, closing connection')
						void end(new Boom('Connection was lost (ping failures)', { statusCode: DisconnectReason.connectionLost, data: { cause: err } }))
					}
				})
				.finally(() => {
					keepAliveInFlight = false
				})
		}, keepAliveIntervalMs))

	const sendPassiveIq = tag => query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, xmlns: 'passive', type: 'set' }, content: [{ tag, attrs: {} }] })

	const logout = async msg => {
		const jid = authState.creds.me?.id
		if (jid) {
			await sendNode({
				tag: 'iq',
				attrs: { to: S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
				content: [{ tag: 'remove-companion-device', attrs: { jid, reason: 'user_initiated' } }]
			})
		}
		void end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }))
	}

	const requestPairingCode = async (phoneNumber, customPairingCode) => {
		const customCode = customPairingCode == null ? '' : String(customPairingCode)
		if (customCode && customCode.length !== 8) throw new Error('Custom pairing code must be exactly 8 characters')
		const pairingCode = customCode || bytesToCrockford(randomBytes(5))
		authState.creds.pairingCode = pairingCode
		authState.creds.me = { id: jidEncode(phoneNumber, 's.whatsapp.net'), name: '~' }
		ev.emit('creds.update', authState.creds)
		await sendNode({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', id: generateMessageTag(), xmlns: 'md' },
			content: [
				{
					tag: 'link_code_companion_reg',
					attrs: { jid: authState.creds.me.id, stage: 'companion_hello', should_show_push_notification: 'true' },
					content: [
						{ tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: await generatePairingKey() },
						{ tag: 'companion_server_auth_key_pub', attrs: {}, content: authState.creds.noiseKey.public },
						{ tag: 'companion_platform_id', attrs: {}, content: getCompanionPlatformId(browser) },
						{ tag: 'companion_platform_display', attrs: {}, content: `${browser[1]} (${browser[0]})` },
						{ tag: 'link_code_pairing_nonce', attrs: {}, content: '0' }
					]
				}
			]
		})
		return authState.creds.pairingCode
	}

	async function generatePairingKey() {
		const salt = randomBytes(32)
		const randomIv = randomBytes(16)
		const key = await derivePairingCodeKey(authState.creds.pairingCode, salt)
		const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
		return Buffer.concat([salt, randomIv, ciphered])
	}

	const sendWAMBuffer = wamBuffer =>
		query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, id: generateMessageTag(), xmlns: 'w:stats' },
			content: [{ tag: 'add', attrs: { t: Math.round(Date.now() / 1000) + '' }, content: wamBuffer }]
		})

	ws.on('message', onMessageReceived)
	ws.on('open', async () => {
		try {
			await validateConnection()
		} catch (err) {
			logger.error({ err }, 'error in validating connection')
			void end(err)
		}
	})
	ws.on('error', mapWebSocketError(end))
	ws.on('close', (code, reason) => {
		const wsReason = reason ? String(reason) : ''
		logger.info({ wsCode: code, wsReason }, 'websocket closed')
		void end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed, data: { wsCode: code, wsReason } }))
	})

	ws.on('CB:xmlstreamend', () => void end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed })))

	ws.on('CB:iq,type:set,pair-device', async stanza => {
		const iq = { tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'result', id: stanza.attrs.id } }
		await sendNode(iq)
		const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device')
		const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref')
		const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
		const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
		const advB64 = creds.advSecretKey
		let qrMs = qrTimeout || 60000
		const genPairQR = () => {
			if (!ws.isOpen) return
			const refNode = refNodes.shift()
			if (!refNode) {
				void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }))
				return
			}
			const ref = refNode.content.toString('utf-8')
			const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser)
			ev.emit('connection.update', { qr })
			if (printQRInTerminal) generateQR(qr, { small: true }, output => console.log('\n' + output))
			qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = qrTimeout || 20000
		}
		genPairQR()
	})

	ws.on('CB:iq,,pair-success', async stanza => {
		logger.debug('pair success recv')
		try {
			updateServerTimeOffset(stanza)
			const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)
			logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, 'pairing configured successfully, expect to restart the connection...')
			ev.emit('creds.update', updatedCreds)
			ev.emit('connection.update', { isNewLogin: true, qr: undefined })
			await sendNode(reply)
			void sendUnifiedSession()
		} catch (error) {
			logger.info({ trace: error.stack }, 'error in pairing')
			void end(error)
		}
	})

	ws.on('CB:success', async node => {
		try {
			updateServerTimeOffset(node)
			await uploadPreKeysToServerIfRequired()
			await sendPassiveIq('active')
			try {
				await digestKeyBundle()
			} catch (e) {
				logger.warn({ e }, 'failed to run digest after login')
			}
		} catch (err) {
			logger.warn({ err }, 'failed to send initial passive iq')
		}
		logger.info('opened connection to WA')
		clearTimeout(qrTimer)
		ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } })
		ev.emit('connection.update', { connection: 'open' })
		void sendUnifiedSession()
		if (node.attrs.lid && authState.creds.me?.id) {
			const myLID = node.attrs.lid
			process.nextTick(async () => {
				try {
					const myPN = authState.creds.me.id
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])
					const { user, device } = jidDecode(myPN)
					await authState.keys.set({ 'device-list': { [user]: [device?.toString() || '0'] } })
					await signalRepository.migrateSession(myPN, myLID)
					logger.info({ myPN, myLID }, 'Own LID session created successfully')
				} catch (error) {
					logger.error({ error, lid: myLID }, 'Failed to create own LID session')
				}
			})
		}
	})
	ws.on('CB:stream:error', node => {
		const [reasonNode] = getAllBinaryNodeChildren(node)
		logger.error({ reasonNode, fullErrorNode: node }, 'stream errored out')
		const { reason, statusCode } = getErrorCodeFromStreamError(node)
		void end(new Boom(`Stream Errored (${reason})`, { statusCode, data: reasonNode || node }))
	})

	ws.on('CB:failure', node => {
		const reason = +(node.attrs.reason || 500)
		void end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
	})
	ws.on('CB:ib,,downgrade_webclient', () => {
		void end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }))
	})
	ws.on('CB:ib,,offline_preview', async node => {
		logger.info('offline preview received', JSON.stringify(node))
		await sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] })
	})
	ws.on('CB:ib,,edge_routing', node => {
		const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing')
		const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info')
		if (routingInfo?.content) {
			authState.creds.routingInfo = Buffer.from(routingInfo?.content)
			ev.emit('creds.update', authState.creds)
		}
	})

	let didStartBuffer = false
	process.nextTick(() => {
		if (creds.me?.id) {
			ev.buffer()
			didStartBuffer = true
		}
		ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
	})

	ws.on('CB:ib,,offline', node => {
		const child = getBinaryNodeChild(node, 'offline')
		const offlineNotifs = +(child?.attrs.count || 0)
		logger.info(`handled ${offlineNotifs} offline messages/notifications`)
		if (didStartBuffer) {
			ev.flush()
			logger.trace('flushed events for initial buffer')
		}
		ev.emit('connection.update', { receivedPendingNotifications: true })
	})

	ev.on('creds.update', update => {
		const name = update.me?.name
		if (creds.me?.name !== name) {
			logger.debug({ name }, 'updated pushName')
			sendNode({ tag: 'presence', attrs: { name } }).catch(err => logger.warn({ trace: err.stack }, 'error in sending presence update on name change'))
		}
		Object.assign(creds, update)
	})

	const updateServerTimeOffset = ({ attrs }) => {
		const tValue = attrs?.t
		if (!tValue) return
		const parsed = Number(tValue)
		if (Number.isNaN(parsed) || parsed <= 0) return
		const localMs = Date.now()
		serverTimeOffsetMs = parsed * 1000 - localMs
		logger.debug({ offset: serverTimeOffsetMs }, 'calculated server time offset')
	}
	const getUnifiedSessionId = () => {
		const offsetMs = 3 * TimeMs.Day
		const now = Date.now() + serverTimeOffsetMs
		return ((now + offsetMs) % TimeMs.Week).toString()
	}
	const sendUnifiedSession = async () => {
		if (!ws.isOpen) return
		const node = { tag: 'ib', attrs: {}, content: [{ tag: 'unified_session', attrs: { id: getUnifiedSessionId() } }] }
		try {
			await sendNode(node)
		} catch (error) {
			logger.debug({ error }, 'failed to send unified_session telemetry')
		}
	}

	const registerSocketEndHandler = handler => {
		socketEndHandlers.push(handler)
	}

	const fetchAccountReachoutTimelock = async () => {
		const queryResult = await executeWMexQuery({}, QueryIds.REACHOUT_TIMELOCK, XWAPaths.xwa2_fetch_account_reachout_timelock, query, generateMessageTag)
		const result = {
			isActive: !!queryResult?.is_active,
			timeEnforcementEnds: queryResult?.time_enforcement_ends && queryResult?.time_enforcement_ends !== '0' ? new Date(parseInt(queryResult.time_enforcement_ends, 10) * 1000) : undefined,
			enforcementType: queryResult?.enforcement_type ?? ReachoutTimelockEnforcementType.DEFAULT
		}
		ev.emit('connection.update', { reachoutTimeLock: result })
		return result
	}

	const fetchNewChatMessageCap = async () => executeWMexQuery({ input: { type: 'INDIVIDUAL_NEW_CHAT_MSG' } }, QueryIds.MESSAGE_CAPPING_INFO, XWAPaths.xwa2_message_capping_info, query, generateMessageTag)

	return {
		type: 'md',
		ws,
		ev,
		authState: { creds, keys },
		signalRepository,
		get user() {
			return authState.creds.me
		},

		get connectionHealth() {
			return {
				lastMessageReceived: lastDateRecv,
				consecutivePingFailures
			}
		},
		generateMessageTag,
		query,
		waitForMessage,
		waitForSocketOpen,
		sendRawMessage,
		sendNode,
		logout,
		end,
		registerSocketEndHandler,
		onUnexpectedError,
		uploadPreKeys,
		uploadPreKeysToServerIfRequired,
		digestKeyBundle,
		rotateSignedPreKey,
		requestPairingCode,
		updateServerTimeOffset,
		sendUnifiedSession,
		wamBuffer: publicWAMBuffer,

		waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
		sendWAMBuffer,
		executeUSyncQuery,
		onWhatsApp,
		resolveUsername,
		fetchAccountReachoutTimelock,
		fetchNewChatMessageCap
	}
}

function mapWebSocketError(handler) {
	return error => {
		handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }))
	}
}

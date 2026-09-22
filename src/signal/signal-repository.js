/**
 * Signal session repository (1:1 E2EE) + LID↔PN identity mapping store.
 * Combines what used to be libsignal.js + lid-mapping.js.
 *
 * The Signal protocol itself (X3DH, Double Ratchet, session state) lives in
 * ./libsignal.js (native port, no npm dependency) — this file is bookkeeping
 * around it (JID <-> protocol address mapping, key storage glue, LID/PN
 * identity resolution), not the crypto itself.
 */
import * as libsignal from './libsignal.js'
import { PreKeyWhisperMessage } from './libsignal.js'
import { Cache } from '../foundation/cache.js'
import { generateSignalPubKey } from '../utils/wa-protocol-core.js'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser, transferDevice, WAJIDDomains } from '../binary/wa-binary.js'
import { SenderKeyName, SenderKeyRecord, GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './signal-group.js'

/* ------------------------------------------------------------------ */
/* LIDMappingStore                                                     */
/* ------------------------------------------------------------------ */

export class LIDMappingStore {
	constructor(keys, logger, pnToLIDFunc) {
		this.mappingCache = new Cache({ ttl: 3 * 24 * 60 * 60 * 1000, updateAgeOnGet: true }) // 7 days
		this.inflightLIDLookups = new Map()
		this.inflightPNLookups = new Map()
		this.keys = keys
		this.pnToLIDFunc = pnToLIDFunc
		this.logger = logger
	}

	async storeLIDPNMappings(pairs) {
		if (pairs.length === 0) return
		const validatedPairs = []
		for (const { lid, pn } of pairs) {
			if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
				this.logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`)
				continue
			}
			const lidDecoded = jidDecode(lid)
			const pnDecoded = jidDecode(pn)
			if (!lidDecoded || !pnDecoded) continue
			validatedPairs.push({ pnUser: pnDecoded.user, lidUser: lidDecoded.user })
		}
		if (validatedPairs.length === 0) return

		const cacheMissSet = new Set()
		const existingMappings = new Map()
		for (const { pnUser } of validatedPairs) {
			const cached = this.mappingCache.get(`pn:${pnUser}`)
			if (cached) existingMappings.set(pnUser, cached)
			else cacheMissSet.add(pnUser)
		}

		if (cacheMissSet.size > 0) {
			const cacheMisses = [...cacheMissSet]
			this.logger.trace(`Batch fetching ${cacheMisses.length} LID mappings from database`)
			const stored = await this.keys.get('lid-mapping', cacheMisses)
			for (const pnUser of cacheMisses) {
				const existingLidUser = stored[pnUser]
				if (existingLidUser) {
					existingMappings.set(pnUser, existingLidUser)
					this.mappingCache.set(`pn:${pnUser}`, existingLidUser)
					this.mappingCache.set(`lid:${existingLidUser}`, pnUser)
				}
			}
		}

		const pairMap = {}
		for (const { pnUser, lidUser } of validatedPairs) {
			const existingLidUser = existingMappings.get(pnUser)
			if (existingLidUser === lidUser) {
				this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
				continue
			}
			pairMap[pnUser] = lidUser
		}
		if (Object.keys(pairMap).length === 0) return

		this.logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} pn mappings`)
		const batchData = {}
		for (const [pnUser, lidUser] of Object.entries(pairMap)) {
			batchData[pnUser] = lidUser
			batchData[`${lidUser}_reverse`] = pnUser
		}
		await this.keys.transaction(async () => {
			await this.keys.set({ 'lid-mapping': batchData })
		}, 'lid-mapping')

		for (const [pnUser, lidUser] of Object.entries(pairMap)) {
			this.mappingCache.set(`pn:${pnUser}`, lidUser)
			this.mappingCache.set(`lid:${lidUser}`, pnUser)
		}
	}

	async getLIDForPN(pn) {
		return (await this.getLIDsForPNs([pn]))?.[0]?.lid || null
	}

	async getLIDsForPNs(pns) {
		if (pns.length === 0) return null
		const sortedPns = [...new Set(pns)].sort()
		const cacheKey = sortedPns.join(',')
		const inflight = this.inflightLIDLookups.get(cacheKey)
		if (inflight) {
			this.logger.trace(`Coalescing getLIDsForPNs request for ${sortedPns.length} PNs`)
			return inflight
		}
		const promise = this._getLIDsForPNsImpl(pns)
		this.inflightLIDLookups.set(cacheKey, promise)
		try {
			return await promise
		} finally {
			this.inflightLIDLookups.delete(cacheKey)
		}
	}

	async _getLIDsForPNsImpl(pns) {
		const usyncFetch = {}
		const successfulPairs = {}
		const pending = []

		const addResolvedPair = (pn, decoded, lidUser) => {
			const normalizedLidUser = lidUser.toString()
			if (!normalizedLidUser) {
				this.logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`)
				return false
			}
			const pnDevice = decoded.device !== undefined ? decoded.device : 0
			const deviceSpecificLid = `${normalizedLidUser}${pnDevice ? `:${pnDevice}` : ''}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`
			this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`)
			successfulPairs[pn] = { lid: deviceSpecificLid, pn }
			return true
		}

		for (const pn of pns) {
			if (!isPnUser(pn) && !isHostedPnUser(pn)) continue
			const decoded = jidDecode(pn)
			if (!decoded) continue
			const pnUser = decoded.user
			const cached = this.mappingCache.get(`pn:${pnUser}`)
			if (cached && typeof cached === 'string') {
				if (!addResolvedPair(pn, decoded, cached)) {
					this.logger.warn(`Invalid entry for ${pn} (pair not resolved)`)
					continue
				}
				continue
			}
			pending.push({ pn, pnUser, decoded })
		}

		if (pending.length) {
			const pnUsers = [...new Set(pending.map(item => item.pnUser))]
			const stored = await this.keys.get('lid-mapping', pnUsers)
			for (const pnUser of pnUsers) {
				const lidUser = stored[pnUser]
				if (lidUser && typeof lidUser === 'string') {
					this.mappingCache.set(`pn:${pnUser}`, lidUser)
					this.mappingCache.set(`lid:${lidUser}`, pnUser)
				}
			}
			for (const { pn, pnUser, decoded } of pending) {
				const cached = this.mappingCache.get(`pn:${pnUser}`)
				if (cached && typeof cached === 'string') {
					if (!addResolvedPair(pn, decoded, cached)) {
						this.logger.warn(`Invalid entry for ${pn} (pair not resolved)`)
						continue
					}
				} else {
					this.logger.trace(`No LID mapping found for PN user ${pnUser}; batch getting from USync`)
					const device = decoded.device || 0
					let normalizedPn = jidNormalizedUser(pn)
					if (isHostedPnUser(normalizedPn)) normalizedPn = `${pnUser}@s.whatsapp.net`
					if (!usyncFetch[normalizedPn]) usyncFetch[normalizedPn] = [device]
					else usyncFetch[normalizedPn]?.push(device)
				}
			}
		}

		if (Object.keys(usyncFetch).length > 0) {
			const result = await this.pnToLIDFunc?.(Object.keys(usyncFetch)) // already adds LIDs to mapping
			if (result && result.length > 0) {
				await this.storeLIDPNMappings(result)
				for (const pair of result) {
					const pnDecoded = jidDecode(pair.pn)
					const pnUser = pnDecoded?.user
					if (!pnUser) continue
					const lidUser = jidDecode(pair.lid)?.user
					if (!lidUser) continue
					for (const device of usyncFetch[pair.pn]) {
						const deviceSpecificLid = `${lidUser}${device ? `:${device}` : ''}@${device === 99 ? 'hosted.lid' : 'lid'}`
						this.logger.trace(`getLIDForPN: USYNC success for ${pair.pn} → ${deviceSpecificLid} (user mapping with device ${device})`)
						const deviceSpecificPn = `${pnUser}${device ? `:${device}` : ''}@${device === 99 ? 'hosted' : 's.whatsapp.net'}`
						successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn }
					}
				}
			} else {
				this.logger.warn('USync fetch yielded no results for pending PNs')
			}
		}

		return Object.values(successfulPairs).length > 0 ? Object.values(successfulPairs) : null
	}

	async getPNForLID(lid) {
		return (await this.getPNsForLIDs([lid]))?.[0]?.pn || null
	}

	async getPNsForLIDs(lids) {
		if (lids.length === 0) return null
		const sortedLids = [...new Set(lids)].sort()
		const cacheKey = sortedLids.join(',')
		const inflight = this.inflightPNLookups.get(cacheKey)
		if (inflight) {
			this.logger.trace(`Coalescing getPNsForLIDs request for ${sortedLids.length} LIDs`)
			return inflight
		}
		const promise = this._getPNsForLIDsImpl(lids)
		this.inflightPNLookups.set(cacheKey, promise)
		try {
			return await promise
		} finally {
			this.inflightPNLookups.delete(cacheKey)
		}
	}

	async _getPNsForLIDsImpl(lids) {
		const successfulPairs = {}
		const pending = []

		const addResolvedPair = (lid, decoded, pnUser) => {
			if (!pnUser || typeof pnUser !== 'string') return false
			const lidDevice = decoded.device !== undefined ? decoded.device : 0
			const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`
			this.logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`)
			successfulPairs[lid] = { lid, pn: pnJid }
			return true
		}

		for (const lid of lids) {
			if (!isLidUser(lid)) continue
			const decoded = jidDecode(lid)
			if (!decoded) continue
			const lidUser = decoded.user
			const cached = this.mappingCache.get(`lid:${lidUser}`)
			if (cached && typeof cached === 'string') {
				addResolvedPair(lid, decoded, cached)
				continue
			}
			pending.push({ lid, lidUser, decoded })
		}

		if (pending.length) {
			const reverseKeys = [...new Set(pending.map(item => `${item.lidUser}_reverse`))]
			const stored = await this.keys.get('lid-mapping', reverseKeys)
			for (const { lid, lidUser, decoded } of pending) {
				let pnUser = this.mappingCache.get(`lid:${lidUser}`)
				if (!pnUser || typeof pnUser !== 'string') {
					pnUser = stored[`${lidUser}_reverse`]
					if (pnUser && typeof pnUser === 'string') {
						this.mappingCache.set(`lid:${lidUser}`, pnUser)
						this.mappingCache.set(`pn:${pnUser}`, lidUser)
					}
				}
				if (pnUser && typeof pnUser === 'string') {
					addResolvedPair(lid, decoded, pnUser)
				} else {
					this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`)
				}
			}
		}

		return Object.values(successfulPairs).length ? Object.values(successfulPairs) : null
	}

	close() {
		this.mappingCache.clear()
	}
}

/* ------------------------------------------------------------------ */
/* Signal session repository                                           */
/* ------------------------------------------------------------------ */

/** Extract identity key from PreKeyWhisperMessage for identity change detection */
function extractIdentityFromPkmsg(ciphertext) {
	try {
		if (!ciphertext || ciphertext.length < 2) return undefined
		const version = ciphertext[0]
		if ((version & 0xf) !== 3) return undefined // version byte check (version 3)
		const preKeyProto = PreKeyWhisperMessage.decode(ciphertext.slice(1))
		if (preKeyProto.identityKey?.length === 33) return new Uint8Array(preKeyProto.identityKey)
		return undefined
	} catch {
		return undefined
	}
}

export function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
	const lidMapping = new LIDMappingStore(auth.keys, logger, pnToLIDFunc)
	const storage = signalStorage(auth, lidMapping)
	const parsedKeys = auth.keys
	const migratedSessionCache = new Cache({ ttl: 3 * 24 * 60 * 60 * 1000, updateAgeOnGet: true }) // 7 days

	const ensureSenderKeyAndCreateSkdm = async (group, meId) => {
		const senderName = jidToSignalSenderKeyName(group, meId)
		const senderNameStr = senderName.toString()
		const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
		if (!senderKey) await storage.storeSenderKey(senderName, new SenderKeyRecord())
		const skdm = await new GroupSessionBuilder(storage).create(senderName)
		return { senderName, skdm }
	}

	const repository = {
		decryptGroupMessage({ group, authorJid, msg }) {
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)
			return parsedKeys.transaction(async () => cipher.decrypt(msg), group)
		},

		async processSenderKeyDistributionMessage({ item, authorJid }) {
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) throw new Error('Group ID is required for sender key distribution message')
			const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)
			const senderMsg = new SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage)
			const senderNameStr = senderName.toString()
			const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
			if (!senderKey) await storage.storeSenderKey(senderName, new SenderKeyRecord())
			return parsedKeys.transaction(async () => {
				const { [senderNameStr]: senderKey2 } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey2) await storage.storeSenderKey(senderName, new SenderKeyRecord())
				await builder.process(senderName, senderMsg)
			}, item.groupId)
		},

		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const session = new libsignal.SessionCipher(storage, addr)

			if (type === 'pkmsg') {
				const identityKey = extractIdentityFromPkmsg(ciphertext)
				if (identityKey) {
					const addrStr = addr.toString()
					const identityChanged = await storage.saveIdentity(addrStr, identityKey)
					if (identityChanged) {
						logger.info({ jid, addr: addrStr }, 'identity key changed or new contact, session will be re-established')
					}
				}
			}

			async function doDecrypt() {
				switch (type) {
					case 'pkmsg':
						return session.decryptPreKeyWhisperMessage(ciphertext)
					case 'msg':
						return session.decryptWhisperMessage(ciphertext)
				}
			}

			return parsedKeys.transaction(async () => doDecrypt(), jid)
		},

		async encryptMessage({ jid, data }) {
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new libsignal.SessionCipher(storage, addr)
			return parsedKeys.transaction(async () => {
				const { type: sigType, body } = await cipher.encrypt(data)
				const type = sigType === 3 ? 'pkmsg' : 'msg'
				return { type, ciphertext: Buffer.from(body, 'binary') }
			}, jid)
		},

		async encryptGroupMessage({ group, meId, data }) {
			return parsedKeys.transaction(async () => {
				const { senderName, skdm } = await ensureSenderKeyAndCreateSkdm(group, meId)
				const ciphertext = await new GroupCipher(storage, senderName).encrypt(data)
				return { ciphertext, senderKeyDistributionMessage: skdm.serialize() }
			}, group)
		},

		async getSenderKeyDistributionMessage({ group, meId }) {
			return parsedKeys.transaction(async () => {
				const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId)
				return skdm.serialize()
			}, group)
		},

		async hasSenderKey({ group, meId }) {
			const senderName = jidToSignalSenderKeyName(group, meId).toString()
			const { [senderName]: key } = await auth.keys.get('sender-key', [senderName])
			return !!key
		},

		async getSessionInfo(jid) {
			const addr = jidToSignalProtocolAddress(jid).toString()
			const session = await storage.loadSession(addr)
			if (!session) return null
			const open = session.getOpenSession?.()
			const baseKey = open?.indexInfo?.baseKey
			const registrationId = open?.registrationId
			if (!baseKey || typeof registrationId !== 'number') return null
			return { baseKey: new Uint8Array(baseKey), registrationId }
		},

		async injectE2ESession({ jid, session }) {
			logger.trace({ jid }, 'injecting E2EE session')
			const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))
			return parsedKeys.transaction(async () => {
				// libsignal runtime accepts an absent prekey (initOutgoing checks `device.preKey && ...`)
				// but the bundled .d.ts marks it required.
				await cipher.initOutgoing(session)
			}, jid)
		},

		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		},

		lidMapping,

		async validateSession(jid) {
			try {
				const addr = jidToSignalProtocolAddress(jid)
				const session = await storage.loadSession(addr.toString())
				if (!session) return { exists: false, reason: 'no session' }
				if (!session.haveOpenSession()) return { exists: false, reason: 'no open session' }
				return { exists: true }
			} catch {
				return { exists: false, reason: 'validation error' }
			}
		},

		async deleteSession(jids) {
			if (!jids.length) return
			const sessionUpdates = {}
			jids.forEach(jid => {
				const addr = jidToSignalProtocolAddress(jid)
				sessionUpdates[addr.toString()] = null
			})
			return parsedKeys.transaction(async () => {
				await auth.keys.set({ session: sessionUpdates })
			}, `delete-${jids.length}-sessions`)
		},

		close() {
			migratedSessionCache.clear()
			lidMapping.close()
		},

		async migrateSession(fromJid, toJid) {
			// TODO: use usync to handle this entire mess
			if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }
			if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) return { migrated: 0, skipped: 0, total: 1 } // only PN -> LID supported

			const { user } = jidDecode(fromJid)
			logger.debug({ fromJid }, 'bulk device migration - loading all user devices')
			const { [user]: userDevices } = await parsedKeys.get('device-list', [user])
			if (!userDevices) return { migrated: 0, skipped: 0, total: 0 }

			const { device: fromDevice } = jidDecode(fromJid)
			const fromDeviceStr = fromDevice?.toString() || '0'
			if (!userDevices.includes(fromDeviceStr)) userDevices.push(fromDeviceStr)

			const uncachedDevices = userDevices.filter(device => !migratedSessionCache.has(`${user}.${device}`))
			const deviceSessionKeys = uncachedDevices.map(device => `${user}.${device}`)
			const existingSessions = await parsedKeys.get('session', deviceSessionKeys)

			const deviceJids = []
			for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
				if (sessionData) {
					const deviceStr = sessionKey.split('.')[1]
					if (!deviceStr) continue
					const deviceNum = parseInt(deviceStr)
					let jid = deviceNum === 0 ? `${user}@s.whatsapp.net` : `${user}:${deviceNum}@s.whatsapp.net`
					if (deviceNum === 99) jid = `${user}:99@hosted`
					deviceJids.push(jid)
				}
			}
			logger.debug(
				{ fromJid, totalDevices: userDevices.length, devicesWithSessions: deviceJids.length, devices: deviceJids },
				'bulk device migration complete - all user devices processed'
			)

			return parsedKeys.transaction(async () => {
				const migrationOps = deviceJids.map(jid => {
					const lidWithDevice = transferDevice(jid, toJid)
					const fromDecoded = jidDecode(jid)
					const toDecoded = jidDecode(lidWithDevice)
					return {
						fromJid: jid,
						toJid: lidWithDevice,
						pnUser: fromDecoded.user,
						lidUser: toDecoded.user,
						deviceId: fromDecoded.device || 0,
						fromAddr: jidToSignalProtocolAddress(jid),
						toAddr: jidToSignalProtocolAddress(lidWithDevice)
					}
				})
				const totalOps = migrationOps.length
				let migratedCount = 0

				const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())))
				const pnSessions = await parsedKeys.get('session', pnAddrStrings)

				const sessionUpdates = {}
				for (const op of migrationOps) {
					const pnAddrStr = op.fromAddr.toString()
					const lidAddrStr = op.toAddr.toString()
					const pnSession = pnSessions[pnAddrStr]
					if (pnSession) {
						const fromSession = libsignal.SessionRecord.deserialize(pnSession)
						if (fromSession.haveOpenSession()) {
							sessionUpdates[lidAddrStr] = fromSession.serialize()
							sessionUpdates[pnAddrStr] = null
							migratedCount++
						}
					}
				}

				if (Object.keys(sessionUpdates).length > 0) {
					await parsedKeys.set({ session: sessionUpdates })
					logger.debug({ migratedSessions: migratedCount }, 'bulk session migration complete')
					for (const op of migrationOps) {
						if (sessionUpdates[op.toAddr.toString()]) {
							migratedSessionCache.set(`${op.pnUser}.${op.deviceId}`, true)
						}
					}
				}

				const skippedCount = totalOps - migratedCount
				return { migrated: migratedCount, skipped: skippedCount, total: totalOps }
			}, `migrate-${deviceJids.length}-sessions-${jidDecode(toJid)?.user}`)
		}
	}

	return repository
}

const jidToSignalProtocolAddress = jid => {
	const decoded = jidDecode(jid)
	const { user, device, server, domainType } = decoded
	if (!user) throw new Error(`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`)
	const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
	const finalDevice = device || 0
	if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
		throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid)
	}
	return new libsignal.ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group, user) => new SenderKeyName(group, jidToSignalProtocolAddress(user))

function signalStorage({ creds, keys }, lidMapping) {
	// Resolve a PN signal address to its LID counterpart, if a mapping exists.
	const resolveLIDSignalAddress = async id => {
		if (id.includes('.')) {
			const [deviceId, device] = id.split('.')
			const [user, domainType_] = deviceId.split('_')
			const domainType = parseInt(domainType_ || '0')
			if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id
			const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`
			const lidForPN = await lidMapping.getLIDForPN(pnJid)
			if (lidForPN) {
				const lidAddr = jidToSignalProtocolAddress(lidForPN)
				return lidAddr.toString()
			}
		}
		return id
	}

	return {
		loadSession: async id => {
			try {
				const wireJid = await resolveLIDSignalAddress(id)
				const { [wireJid]: sess } = await keys.get('session', [wireJid])
				if (sess) return libsignal.SessionRecord.deserialize(sess)
			} catch {
				return null
			}
			return null
		},

		storeSession: async (id, session) => {
			const wireJid = await resolveLIDSignalAddress(id)
			await keys.set({ session: { [wireJid]: session.serialize() } })
		},

		isTrustedIdentity: () => true, // TOFU - Trust on First Use (same as WhatsApp Web)

		loadIdentityKey: async id => {
			const wireJid = await resolveLIDSignalAddress(id)
			const { [wireJid]: key } = await keys.get('identity-key', [wireJid])
			return key || undefined
		},

		saveIdentity: async (id, identityKey) => {
			const wireJid = await resolveLIDSignalAddress(id)
			const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid])
			const keysMatch = existingKey?.length === identityKey.length && existingKey.every((byte, i) => byte === identityKey[i])
			if (existingKey && !keysMatch) {
				await keys.set({ session: { [wireJid]: null }, 'identity-key': { [wireJid]: identityKey } })
				return true
			}
			if (!existingKey) {
				await keys.set({ 'identity-key': { [wireJid]: identityKey } }) // new contact - TOFU
				return true
			}
			return false
		},

		loadPreKey: async id => {
			const keyId = id.toString()
			const { [keyId]: key } = await keys.get('pre-key', [keyId])
			if (key) return { privKey: Buffer.from(key.private), pubKey: Buffer.from(key.public) }
		},

		removePreKey: id => keys.set({ 'pre-key': { [id]: null } }),

		loadSignedPreKey: () => {
			const key = creds.signedPreKey
			return { privKey: Buffer.from(key.keyPair.private), pubKey: Buffer.from(key.keyPair.public) }
		},

		loadSenderKey: async senderKeyName => {
			const keyId = senderKeyName.toString()
			const { [keyId]: key } = await keys.get('sender-key', [keyId])
			if (key) return SenderKeyRecord.deserialize(key)
			return new SenderKeyRecord()
		},

		storeSenderKey: async (senderKeyName, key) => {
			const keyId = senderKeyName.toString()
			const serialized = JSON.stringify(key.serialize())
			await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } })
		},

		getOurRegistrationId: () => creds.registrationId,

		getOurIdentity: () => {
			const { signedIdentityKey } = creds
			return {
				privKey: Buffer.from(signedIdentityKey.private),
				pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
			}
		}
	}
}

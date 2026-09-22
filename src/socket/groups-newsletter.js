/**
 * Groups + newsletter socket layers. Combines what used to be Socket/groups.js
 * and Socket/newsletter.js.
 *
 * Wrap order (must match upstream exactly): makeChatsSocket -> makeGroupsSocket
 * -> makeNewsletterSocket. This file's export (makeNewsletterSocket) is what
 * messages-send.js wraps next.
 */
import { proto } from '../../WAProto/index.js'
import { Boom } from '../foundation/boom.js'
import { WAMessageAddressingMode, WAMessageStubType, QueryIds, XWAPaths } from '../constants.js'
import { generateMessageIDV2, unixTimestampSeconds } from '../utils/wa-protocol-core.js'
import { generateProfilePicture } from '../utils/media.js'
import { getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString, isLidUser, isPnUser, jidEncode, jidNormalizedUser, S_WHATSAPP_NET } from '../binary/wa-binary.js'
import { executeWMexQuery as genericExecuteWMexQuery } from './socket-core.js'
import { makeChatsSocket } from './chats.js'

/* ------------------------------------------------------------------ */
/* Groups                                                               */
/* ------------------------------------------------------------------ */

export const extractGroupMetadata = result => {
	const group = getBinaryNodeChild(result, 'group')
	if (!group) {
		const errorNode = getBinaryNodeChild(result, 'error')
		if (errorNode) {
			const code = errorNode.attrs.code ? +errorNode.attrs.code : 500
			const text = errorNode.attrs.text || 'group metadata query failed'
			throw new Boom(text, { statusCode: code, data: errorNode })
		}
		throw new Boom('Invalid group metadata response: missing <group> node', { data: result })
	}
	if (!group.attrs.id) throw new Boom('Invalid group metadata response: missing group id', { data: group })
	const descChild = getBinaryNodeChild(group, 'description')
	let desc, descId, descOwner, descOwnerPn, descOwnerUsername, descTime
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined
		descOwnerUsername = descChild.attrs.participant_username || undefined
		descTime = +descChild.attrs.t
		descId = descChild.attrs.id
	}
	const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add'
	return {
		id: groupId,
		notify: group.attrs.notify,
		addressingMode: group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		subject: group.attrs.subject,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPn: group.attrs.s_o_pn,
		subjectOwnerUsername: group.attrs.s_o_username,
		subjectTime: +group.attrs.s_t,
		size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
		creation: +group.attrs.creation,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
		ownerUsername: group.attrs.creator_username || undefined,
		owner_country_code: group.attrs.creator_country_code,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descOwnerUsername,
		descTime,
		linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		isCommunity: !!getBinaryNodeChild(group, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
		joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
		memberAddMode,
		participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => ({
			id: attrs.jid,
			phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
			lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
			username: attrs.participant_username || attrs.username || undefined,
			admin: attrs.type || null
		})),
		ephemeralDuration: eph ? +eph : undefined
	}
}

export const makeGroupsSocket = config => {
	const sock = makeChatsSocket(config)
	const { authState, ev, query, upsertMessage } = sock
	const groupQuery = async (jid, type, content) => query({ tag: 'iq', attrs: { type, xmlns: 'w:g2', to: jid }, content })
	const groupMetadata = async jid => extractGroupMetadata(await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }]))

	const groupFetchAllParticipating = async () => {
		const result = await query({
			tag: 'iq',
			attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
			content: [{ tag: 'participating', attrs: {}, content: [{ tag: 'participants', attrs: {} }, { tag: 'description', attrs: {} }] }]
		})
		const data = {}
		const groupsChild = getBinaryNodeChild(result, 'groups')
		if (groupsChild) {
			for (const groupNode of getBinaryNodeChildren(groupsChild, 'group')) {
				const meta = extractGroupMetadata({ tag: 'result', attrs: {}, content: [groupNode] })
				data[meta.id] = meta
			}
		}
		sock.ev.emit('groups.update', Object.values(data))
		return data
	}

	sock.ws.on('CB:ib,,dirty', async node => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')
		if (attrs.type !== 'groups') return
		await groupFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})

	return {
		...sock,
		groupQuery,
		groupMetadata,
		groupCreate: async (subject, participants) => {
			const key = generateMessageIDV2()
			const result = await groupQuery('@g.us', 'set', [
				{ tag: 'create', attrs: { subject, key }, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }
			])
			return extractGroupMetadata(result)
		},
		groupLeave: async id => {
			await groupQuery('@g.us', 'set', [{ tag: 'leave', attrs: {}, content: [{ tag: 'group', attrs: { id } }] }])
		},
		groupUpdateSubject: async (jid, subject) => {
			await groupQuery(jid, 'set', [{ tag: 'subject', attrs: {}, content: Buffer.from(subject, 'utf-8') }])
		},
		groupRequestParticipantsList: async jid => {
			const result = await groupQuery(jid, 'get', [{ tag: 'membership_approval_requests', attrs: {} }])
			const node = getBinaryNodeChild(result, 'membership_approval_requests')
			return getBinaryNodeChildren(node, 'membership_approval_request').map(v => v.attrs)
		},
		groupRequestParticipantsUpdate: async (jid, participants, action) => {
			const result = await groupQuery(jid, 'set', [
				{ tag: 'membership_requests_action', attrs: {}, content: [{ tag: action, attrs: {}, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }] }
			])
			const node = getBinaryNodeChild(result, 'membership_requests_action')
			const nodeAction = getBinaryNodeChild(node, action)
			return getBinaryNodeChildren(nodeAction, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid }))
		},
		groupParticipantsUpdate: async (jid, participants, action) => {
			const result = await groupQuery(jid, 'set', [{ tag: action, attrs: {}, content: participants.map(jid => ({ tag: 'participant', attrs: { jid } })) }])
			const node = getBinaryNodeChild(result, action)
			return getBinaryNodeChildren(node, 'participant').map(p => ({ status: p.attrs.error || '200', jid: p.attrs.jid, content: p }))
		},
		groupUpdateDescription: async (jid, description) => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null
			await groupQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: { ...(description ? { id: generateMessageIDV2() } : { delete: 'true' }), ...(prev ? { prev } : {}) },
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		groupInviteCode: async jid => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			return getBinaryNodeChild(result, 'invite')?.attrs.code
		},
		groupRevokeInvite: async jid => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			return getBinaryNodeChild(result, 'invite')?.attrs.code
		},
		groupAcceptInvite: async code => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			return getBinaryNodeChild(results, 'group')?.attrs.jid
		},
		groupRevokeInviteV4: async (groupJid, invitedJid) => {
			const result = await groupQuery(groupJid, 'set', [{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }])
			return !!result
		},
		groupAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
			key = typeof key === 'string' ? { remoteJid: key } : key
			const results = await groupQuery(inviteMessage.groupJid, 'set', [
				{ tag: 'accept', attrs: { code: inviteMessage.inviteCode, expiration: inviteMessage.inviteExpiration.toString(), admin: key.remoteJid } }
			])
			if (key.id) {
				inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
				inviteMessage.inviteExpiration = 0
				inviteMessage.inviteCode = ''
				ev.emit('messages.update', [{ key, update: { message: { groupInviteMessage: inviteMessage } } }])
			}
			await upsertMessage(
				{
					key: { remoteJid: inviteMessage.groupJid, id: generateMessageIDV2(sock.user?.id), fromMe: false, participant: key.remoteJid },
					messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
					messageStubParameters: [JSON.stringify(authState.creds.me)],
					participant: key.remoteJid,
					messageTimestamp: unixTimestampSeconds()
				},
				'notify'
			)
			return results.attrs.from
		}),
		groupGetInviteInfo: async code => extractGroupMetadata(await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])),
		groupToggleEphemeral: async (jid, ephemeralExpiration) => {
			const content = ephemeralExpiration ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } } : { tag: 'not_ephemeral', attrs: {} }
			await groupQuery(jid, 'set', [content])
		},
		groupSettingUpdate: async (jid, setting) => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		groupMemberAddMode: async (jid, mode) => {
			await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		groupJoinApprovalMode: async (jid, mode) => {
			await groupQuery(jid, 'set', [{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }])
		},
		groupFetchAllParticipating
	}
}

/* ------------------------------------------------------------------ */
/* Newsletters (wraps makeGroupsSocket)                                 */
/* ------------------------------------------------------------------ */

const parseNewsletterCreateResponse = response => {
	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	return {
		id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10),
		description: thread.description.text,
		invite: thread.invite,
		subscribers: parseInt(thread.subscribers_count, 10),
		verification: thread.verification,
		picture: { id: thread.picture?.id, directPath: thread.picture?.direct_path },
		mute_state: viewer.mute
	}
}

const parseNewsletterMetadata = result => {
	if (typeof result !== 'object' || result === null) return null
	if ('id' in result && typeof result.id === 'string') return result
	if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) return result.result
	return null
}

export const makeNewsletterSocket = config => {
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag, logger } = sock
	const executeWMexQuery = (variables, queryId, dataPath) => genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag)
	const newsletterUpdate = async (jid, updates) =>
		executeWMexQuery({ newsletter_id: jid, updates: { ...updates, settings: null } }, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')

	return {
		...sock,
		executeWMexQuery,
		newsletterCreate: async (name, description) => {
			const rawResponse = await executeWMexQuery({ input: { name, description: description ?? null } }, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create)
			return parseNewsletterCreateResponse(rawResponse)
		},
		newsletterUpdate,
		newsletterSubscribers: async jid => executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers),
		newsletterSubscribed: async () => executeWMexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed),
		newsletterMetadata: async (type, key) => {
			const variables = { fetch_creation_time: true, fetch_full_image: true, fetch_viewer_metadata: true, input: { key, type: type.toUpperCase() } }
			const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
			return parseNewsletterMetadata(result)
		},
		newsletterFollow: jid => executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2),
		newsletterUnfollow: jid => executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2),
		newsletterMute: jid => executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2),
		newsletterUnmute: jid => executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2),
		newsletterUpdateName: async (jid, name) => newsletterUpdate(jid, { name }),
		newsletterUpdateDescription: async (jid, description) => newsletterUpdate(jid, { description }),
		newsletterUpdatePicture: async (jid, content) => {
			const { img } = await generateProfilePicture(content)
			return newsletterUpdate(jid, { picture: img.toString('base64') })
		},
		newsletterRemovePicture: async jid => newsletterUpdate(jid, { picture: '' }),
		newsletterReactMessage: async (jid, serverId, reaction) => {
			await query({
				tag: 'message',
				attrs: { to: jid, ...(reaction ? {} : { edit: '7' }), type: 'reaction', server_id: serverId, id: generateMessageTag() },
				content: [{ tag: 'reaction', attrs: reaction ? { code: reaction } : {} }]
			})
		},
		newsletterFetchMessages: async (type, key, count, after, before) => {
			const messagesAttrs = { count: count.toString(), type, [type === 'jid' ? 'jid' : 'key']: key }
			if (after) messagesAttrs.after = after.toString()
			if (before) messagesAttrs.before = before.toString()
			const result = await query({
				tag: 'iq',
				attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: S_WHATSAPP_NET },
				content: [{ tag: 'messages', attrs: messagesAttrs }]
			})
			const messagesNode = getBinaryNodeChild(result, 'messages')
			if (!messagesNode) return []
			const newsletterJid = messagesNode.attrs.jid || (type === 'jid' ? key : undefined)
			const messages = []
			for (const child of getBinaryNodeChildren(messagesNode, 'message')) {
				const plaintextNode = getBinaryNodeChild(child, 'plaintext')
				if (!plaintextNode?.content) continue
				try {
					const contentBuf = typeof plaintextNode.content === 'string' ? Buffer.from(plaintextNode.content, 'binary') : Buffer.from(plaintextNode.content)
					const messageProto = proto.Message.decode(contentBuf).toJSON()
					const fullMessage = proto.WebMessageInfo.fromObject({
						key: { remoteJid: newsletterJid, id: child.attrs.id || child.attrs.server_id, server_id: child.attrs.server_id, fromMe: false },
						message: messageProto,
						messageTimestamp: child.attrs.t ? +child.attrs.t : undefined
					}).toJSON()
					messages.push(fullMessage)
				} catch (error) {
					logger.error({ error }, 'Failed to decode newsletter message')
				}
			}
			return messages
		},
		subscribeNewsletterUpdates: async jid => {
			const result = await query({
				tag: 'iq',
				attrs: { id: generateMessageTag(), type: 'set', xmlns: 'newsletter', to: jid },
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration } : null
		},
		newsletterAdminCount: async jid => {
			const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count)
			return response.admin_count
		},
		newsletterChangeOwner: async (jid, newOwnerJid) => {
			await executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner)
		},
		newsletterDemote: async (jid, userJid) => {
			await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote)
		},
		newsletterDelete: async jid => {
			await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
		}
	}
}

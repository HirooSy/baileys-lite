/**
 * USync (user info sync) query builder + protocols.
 * Combines what used to be 11 files under WAUSync/.
 */
import { assertNodeErrorFree, getBinaryNodeChild, getBinaryNodeChildren, getBinaryNodeChildString } from '../binary/wa-binary.js'

export class USyncUser {
	withId(id) {
		this.id = id
		return this
	}
	withLid(lid) {
		this.lid = lid
		return this
	}
	withPhone(phone) {
		this.phone = phone
		return this
	}
	withUsername(username) {
		this.username = username
		return this
	}
	withUsernameKey(usernameKey) {
		this.usernameKey = usernameKey
		return this
	}
	withType(type) {
		this.type = type
		return this
	}
	withPersonaId(personaId) {
		this.personaId = personaId
		return this
	}
}

export class USyncContactProtocol {
	constructor() {
		this.name = 'contact'
	}
	getQueryElement() {
		return { tag: 'contact', attrs: {} }
	}
	getUserElement(user) {
		if (user.phone) return { tag: 'contact', attrs: {}, content: user.phone }
		if (user.username) {
			return {
				tag: 'contact',
				attrs: { username: user.username, ...(user.usernameKey ? { pin: user.usernameKey } : {}), ...(user.lid ? { lid: user.lid } : {}) }
			}
		}
		if (user.type) return { tag: 'contact', attrs: { type: user.type } }
		return { tag: 'contact', attrs: {} }
	}
	parser(node) {
		if (node.tag === 'contact') {
			assertNodeErrorFree(node)
			return node?.attrs?.type === 'in'
		}
		return false
	}
}

export class USyncDeviceProtocol {
	constructor() {
		this.name = 'devices'
	}
	getQueryElement() {
		return { tag: 'devices', attrs: { version: '2' } }
	}
	getUserElement() {
		// TODO: device phashing, ts, expectedTs; currently returns null (matches upstream)
		return null
	}
	parser(node) {
		const deviceList = []
		let keyIndex
		if (node.tag === 'devices') {
			assertNodeErrorFree(node)
			const deviceListNode = getBinaryNodeChild(node, 'device-list')
			const keyIndexNode = getBinaryNodeChild(node, 'key-index-list')
			if (Array.isArray(deviceListNode?.content)) {
				for (const { tag, attrs } of deviceListNode.content) {
					const id = +attrs.id
					const ki = +attrs['key-index']
					if (tag === 'device') deviceList.push({ id, keyIndex: ki, isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true') })
				}
			}
			if (keyIndexNode?.tag === 'key-index-list') {
				keyIndex = {
					timestamp: +keyIndexNode.attrs['ts'],
					signedKeyIndex: keyIndexNode?.content,
					expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
				}
			}
		}
		return { deviceList, keyIndex }
	}
}

export class USyncDisappearingModeProtocol {
	constructor() {
		this.name = 'disappearing_mode'
	}
	getQueryElement() {
		return { tag: 'disappearing_mode', attrs: {} }
	}
	getUserElement() {
		return null
	}
	parser(node) {
		if (node.tag === 'disappearing_mode') {
			assertNodeErrorFree(node)
			const duration = +node?.attrs.duration
			const setAt = new Date(+(node?.attrs.t || 0) * 1000)
			return { duration, setAt }
		}
	}
}

export class USyncStatusProtocol {
	constructor() {
		this.name = 'status'
	}
	getQueryElement() {
		return { tag: 'status', attrs: {} }
	}
	getUserElement() {
		return null
	}
	parser(node) {
		if (node.tag === 'status') {
			assertNodeErrorFree(node)
			let status = node?.content?.toString() ?? null
			const setAt = new Date(+(node?.attrs.t || 0) * 1000)
			if (!status) status = node.attrs?.code && +node.attrs.code === 401 ? '' : null
			else if (typeof status === 'string' && status.length === 0) status = null
			return { status, setAt }
		}
	}
}

export class USyncUsernameProtocol {
	constructor() {
		this.name = 'username'
	}
	getQueryElement() {
		return { tag: 'username', attrs: {} }
	}
	getUserElement() {
		return null
	}
	parser(node) {
		if (node.tag === 'username') {
			assertNodeErrorFree(node)
			return typeof node.content === 'string' ? node.content : null
		}
		return null
	}
}

export class USyncBotProfileProtocol {
	constructor() {
		this.name = 'bot'
	}
	getQueryElement() {
		return { tag: 'bot', attrs: {}, content: [{ tag: 'profile', attrs: { v: '1' } }] }
	}
	getUserElement(user) {
		return { tag: 'bot', attrs: {}, content: [{ tag: 'profile', attrs: { persona_id: user.personaId } }] }
	}
	parser(node) {
		const botNode = getBinaryNodeChild(node, 'bot')
		const profile = getBinaryNodeChild(botNode, 'profile')
		const commandsNode = getBinaryNodeChild(profile, 'commands')
		const promptsNode = getBinaryNodeChild(profile, 'prompts')
		const commands = []
		const prompts = []
		for (const command of getBinaryNodeChildren(commandsNode, 'command')) {
			commands.push({ name: getBinaryNodeChildString(command, 'name'), description: getBinaryNodeChildString(command, 'description') })
		}
		for (const prompt of getBinaryNodeChildren(promptsNode, 'prompt')) {
			prompts.push(`${getBinaryNodeChildString(prompt, 'emoji')} ${getBinaryNodeChildString(prompt, 'text')}`)
		}
		return {
			isDefault: !!getBinaryNodeChild(profile, 'default'),
			jid: node.attrs.jid,
			name: getBinaryNodeChildString(profile, 'name'),
			attributes: getBinaryNodeChildString(profile, 'attributes'),
			description: getBinaryNodeChildString(profile, 'description'),
			category: getBinaryNodeChildString(profile, 'category'),
			personaId: profile.attrs['persona_id'],
			commandsDescription: getBinaryNodeChildString(commandsNode, 'description'),
			commands,
			prompts
		}
	}
}

export class USyncLIDProtocol {
	constructor() {
		this.name = 'lid'
	}
	getQueryElement() {
		return { tag: 'lid', attrs: {} }
	}
	getUserElement(user) {
		return user.lid ? { tag: 'lid', attrs: { jid: user.lid } } : null
	}
	parser(node) {
		return node.tag === 'lid' ? node.attrs.val : null
	}
}

export class USyncQuery {
	constructor() {
		this.protocols = []
		this.users = []
		this.context = 'interactive'
		this.mode = 'query'
	}
	withMode(mode) {
		this.mode = mode
		return this
	}
	withContext(context) {
		this.context = context
		return this
	}
	withUser(user) {
		this.users.push(user)
		return this
	}
	parseUSyncQueryResult(result) {
		if (result?.attrs.type !== 'result') return
		const protocolMap = Object.fromEntries(this.protocols.map(protocol => [protocol.name, protocol.parser]))
		const queryResult = { list: [], sideList: [] } // TODO: implement errors etc.
		const usyncNode = getBinaryNodeChild(result, 'usync')
		const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined
		if (listNode?.content && Array.isArray(listNode.content)) {
			queryResult.list = listNode.content.reduce((acc, node) => {
				const id = node?.attrs.jid
				if (id) {
					const data = Array.isArray(node?.content)
						? Object.fromEntries(
								node.content
									.map(content => {
										const protocol = content.tag
										const parser = protocolMap[protocol]
										return parser ? [protocol, parser(content)] : [protocol, null]
									})
									.filter(([, b]) => b !== null)
							)
						: {}
					acc.push({ ...data, id })
				}
				return acc
			}, [])
		}
		return queryResult
	}
	withDeviceProtocol() {
		this.protocols.push(new USyncDeviceProtocol())
		return this
	}
	withContactProtocol() {
		this.protocols.push(new USyncContactProtocol())
		return this
	}
	withStatusProtocol() {
		this.protocols.push(new USyncStatusProtocol())
		return this
	}
	withDisappearingModeProtocol() {
		this.protocols.push(new USyncDisappearingModeProtocol())
		return this
	}
	withBotProfileProtocol() {
		this.protocols.push(new USyncBotProfileProtocol())
		return this
	}
	withLIDProtocol() {
		this.protocols.push(new USyncLIDProtocol())
		return this
	}
	withUsernameProtocol() {
		this.protocols.push(new USyncUsernameProtocol())
		return this
	}
}

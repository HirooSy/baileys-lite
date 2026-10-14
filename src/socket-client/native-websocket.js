import { createHash, randomBytes } from 'node:crypto'
import { isIP, connect as connectTcp } from 'node:net'
import { connect as connectTls } from 'node:tls'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_HANDSHAKE_BYTES = 16 * 1024
const CLOSE_TIMEOUT_MS = 5000
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_HEADERS = new Set([
	'host', 'upgrade', 'connection', 'content-length', 'transfer-encoding',
	'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol'
])
const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

const isValidCloseCode = code => (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)

const toArrayBuffer = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

const encodeFrame = (opcode, payload) => {
	const length = payload.length
	let header
	if (length < 126) {
		header = Buffer.alloc(2)
		header[1] = 0x80 | length
	} else if (length <= 0xffff) {
		header = Buffer.alloc(4)
		header[1] = 0x80 | 126
		header.writeUInt16BE(length, 2)
	} else {
		header = Buffer.alloc(10)
		header[1] = 0x80 | 127
		header.writeBigUInt64BE(BigInt(length), 2)
	}
	header[0] = 0x80 | opcode
	const mask = randomBytes(4)
	const masked = Buffer.allocUnsafe(length)
	for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3]
	return Buffer.concat([header, mask, masked])
}

export class NativeWebSocket {
	static CONNECTING = 0
	static OPEN = 1
	static CLOSING = 2
	static CLOSED = 3

	#readyState = NativeWebSocket.CONNECTING
	#socket = null
	#buffer = Buffer.alloc(0)
	#handshakeDone = false
	#expectedAccept = ''
	#fragments = null
	#fragmentBytes = 0
	#fragmentOpcode = 0
	#closeSent = false
	#closeTimer = null
	#remoteClose = null
	#failCode = null

	constructor(url, options = {}) {
		const target = new URL(url)
		if (target.protocol !== 'ws:' && target.protocol !== 'wss:') throw new SyntaxError(`Unsupported WebSocket protocol: ${target.protocol}`)
		this.url = target.href
		this.binaryType = 'arraybuffer'
		this.onopen = null
		this.onmessage = null
		this.onerror = null
		this.onclose = null
		this.#connect(target, options.headers ?? {})
	}

	get readyState() {
		return this.#readyState
	}

	send(data) {
		if (this.#readyState === NativeWebSocket.CONNECTING) throw new Error('InvalidStateError: Still in CONNECTING state')
		if (this.#readyState !== NativeWebSocket.OPEN) return
		const isText = typeof data === 'string'
		let payload
		if (isText) payload = Buffer.from(data, 'utf8')
		else if (ArrayBuffer.isView(data)) payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
		else payload = Buffer.from(data)
		this.#socket.write(encodeFrame(isText ? OPCODE_TEXT : OPCODE_BINARY, payload))
	}

	close(code, reason = '') {
		if (this.#readyState === NativeWebSocket.CLOSING || this.#readyState === NativeWebSocket.CLOSED) return
		if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) throw new TypeError(`InvalidAccessError: invalid close code ${code}`)
		if (Buffer.byteLength(reason) > 123) throw new SyntaxError('Reason must be less than 123 bytes')
		if (this.#readyState === NativeWebSocket.CONNECTING) {
			this.#fire('onerror', { type: 'error', error: new Error('WebSocket was closed before the connection was established'), message: 'WebSocket was closed before the connection was established' })
			this.#readyState = NativeWebSocket.CLOSING
			this.#socket.destroy()
			return
		}
		this.#readyState = NativeWebSocket.CLOSING
		this.#sendClose(code, reason)
		this.#scheduleDestroy()
	}

	#connect(target, headers) {
		const secure = target.protocol === 'wss:'
		const host = target.hostname.replace(/^\[(.*)\]$/, '$1')
		const port = Number(target.port) || (secure ? 443 : 80)
		const key = randomBytes(16).toString('base64')
		this.#expectedAccept = createHash('sha1').update(key + GUID).digest('base64')
		const lines = [
			`GET ${target.pathname || '/'}${target.search} HTTP/1.1`,
			`Host: ${target.port ? `${target.hostname}:${target.port}` : target.hostname}`,
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Key: ${key}`,
			'Sec-WebSocket-Version: 13'
		]
		for (const [name, value] of Object.entries(headers)) {
			if (value === undefined || value === null) continue
			if (!TOKEN.test(name)) throw new TypeError(`Invalid header name: ${name}`)
			const text = String(value)
			if (/[\r\n\0]/.test(text)) throw new TypeError(`Invalid header value for ${name}`)
			if (FORBIDDEN_HEADERS.has(name.toLowerCase())) continue
			lines.push(`${name}: ${text}`)
		}
		const socket = secure
			? connectTls({ host, port, servername: isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] })
			: connectTcp({ host, port })
		socket.setNoDelay(true)
		socket.on('data', chunk => this.#onData(chunk))
		socket.on('error', error => this.#onSocketError(error))
		socket.on('close', () => this.#onSocketClose())
		this.#socket = socket
		socket.write(`${lines.join('\r\n')}\r\n\r\n`)
	}

	#onData(chunk) {
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
		if (!this.#handshakeDone) {
			const end = this.#buffer.indexOf('\r\n\r\n')
			if (end === -1) {
				if (this.#buffer.length > MAX_HANDSHAKE_BYTES) this.#abortHandshake(new Error('Handshake response too large'))
				return
			}
			const head = this.#buffer.subarray(0, end).toString('latin1')
			this.#buffer = this.#buffer.subarray(end + 4)
			if (!this.#completeHandshake(head)) return
		}
		this.#parseFrames()
	}

	#completeHandshake(head) {
		const [statusLine, ...headerLines] = head.split('\r\n')
		const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]
		const reject = message => {
			this.#abortHandshake(new Error(message))
			return false
		}
		if (status !== '101') return reject(`Unexpected server response: ${status ?? 'invalid'}`)
		const headers = new Map()
		for (const line of headerLines) {
			const i = line.indexOf(':')
			if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
		}
		const connection = (headers.get('connection') ?? '').toLowerCase().split(',').map(token => token.trim())
		if (headers.get('upgrade')?.toLowerCase() !== 'websocket') return reject('Server did not set Upgrade header to "websocket".')
		if (!connection.includes('upgrade')) return reject('Server did not set Connection header to "upgrade".')
		if (headers.get('sec-websocket-accept') !== this.#expectedAccept) return reject('Incorrect hash received in Sec-WebSocket-Accept header.')
		if (headers.get('sec-websocket-extensions')) return reject('Server negotiated an extension that was not requested.')
		if (headers.get('sec-websocket-protocol')) return reject('Server negotiated a subprotocol that was not requested.')
		this.#handshakeDone = true
		this.#readyState = NativeWebSocket.OPEN
		this.#fire('onopen', { type: 'open' })
		return true
	}

	#abortHandshake(error) {
		this.#fire('onerror', { type: 'error', error, message: error.message })
		this.#socket.destroy()
	}

	#parseFrames() {
		while (this.#buffer.length >= 2 && this.#readyState !== NativeWebSocket.CLOSED) {
			const first = this.#buffer[0]
			const second = this.#buffer[1]
			const fin = (first & 0x80) !== 0
			const opcode = first & 0x0f
			const masked = (second & 0x80) !== 0
			let length = second & 0x7f
			let offset = 2
			if (length === 126) {
				if (this.#buffer.length < 4) return
				length = this.#buffer.readUInt16BE(2)
				offset = 4
			} else if (length === 127) {
				if (this.#buffer.length < 10) return
				const big = this.#buffer.readBigUInt64BE(2)
				if (big > BigInt(MAX_MESSAGE_BYTES)) return this.#failConnection(1009, 'Payload size exceeds maximum allowed size')
				length = Number(big)
				offset = 10
			}
			if (first & 0x70) return this.#failConnection(1002, 'RSV1, RSV2, RSV3 must be clear')
			if (masked) return this.#failConnection(1002, 'Server frames must not be masked')
			if (opcode >= 0x8 && (!fin || length > 125)) return this.#failConnection(1002, 'Invalid control frame')
			if (length > MAX_MESSAGE_BYTES) return this.#failConnection(1009, 'Payload size exceeds maximum allowed size')
			if (this.#buffer.length < offset + length) return
			const payload = Buffer.from(this.#buffer.subarray(offset, offset + length))
			this.#buffer = this.#buffer.subarray(offset + length)
			this.#handleFrame(fin, opcode, payload)
		}
	}

	#handleFrame(fin, opcode, payload) {
		if (opcode === OPCODE_CONTINUATION && !this.#fragments) return this.#failConnection(1002, 'Unexpected continuation frame')
		if ((opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) && this.#fragments) return this.#failConnection(1002, 'Expected continuation frame')
		switch (opcode) {
			case OPCODE_CONTINUATION:
			case OPCODE_TEXT:
			case OPCODE_BINARY:
				return this.#appendData(opcode, fin, payload)
			case OPCODE_CLOSE:
				return this.#handleClose(payload)
			case OPCODE_PING:
				if (this.#readyState === NativeWebSocket.OPEN) this.#socket.write(encodeFrame(OPCODE_PONG, payload))
				return
			case OPCODE_PONG:
				return
			default:
				return this.#failConnection(1002, 'Invalid opcode received')
		}
	}

	#appendData(opcode, fin, payload) {
		if (opcode !== OPCODE_CONTINUATION) {
			this.#fragments = []
			this.#fragmentBytes = 0
			this.#fragmentOpcode = opcode
		}
		this.#fragments.push(payload)
		this.#fragmentBytes += payload.length
		if (this.#fragmentBytes > MAX_MESSAGE_BYTES) return this.#failConnection(1009, 'Payload size exceeds maximum allowed size')
		if (!fin) return
		const message = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments, this.#fragmentBytes)
		const messageOpcode = this.#fragmentOpcode
		this.#fragments = null
		this.#fragmentBytes = 0
		if (messageOpcode === OPCODE_TEXT) {
			let text
			try {
				text = TEXT_DECODER.decode(message)
			} catch {
				return this.#failConnection(1007, 'Invalid UTF-8')
			}
			this.#fire('onmessage', { type: 'message', data: text })
			return
		}
		this.#fire('onmessage', { type: 'message', data: toArrayBuffer(message) })
	}

	#handleClose(payload) {
		if (payload.length === 1) return this.#failConnection(1002, 'Received close frame with a 1-byte body.')
		let code = 1005
		let reason = ''
		if (payload.length >= 2) {
			code = payload.readUInt16BE(0)
			if (!isValidCloseCode(code)) return this.#failConnection(1002, 'Invalid status code')
			try {
				reason = TEXT_DECODER.decode(payload.subarray(2))
			} catch {
				return this.#failConnection(1007, 'Invalid UTF-8')
			}
		}
		this.#remoteClose = { code, reason }
		this.#buffer = Buffer.alloc(0)
		if (this.#readyState === NativeWebSocket.OPEN) this.#readyState = NativeWebSocket.CLOSING
		this.#sendClose(payload.length >= 2 ? code : undefined, reason)
		this.#socket.end()
		this.#scheduleDestroy()
	}

	#failConnection(code, reason) {
		if (this.#readyState === NativeWebSocket.CLOSED || this.#failCode !== null) return
		this.#fire('onerror', { type: 'error', error: new Error(reason), message: reason })
		this.#failCode = code
		this.#buffer = Buffer.alloc(0)
		this.#readyState = NativeWebSocket.CLOSING
		this.#sendClose(code, reason)
		this.#socket.end()
		this.#scheduleDestroy()
	}

	#sendClose(code, reason = '') {
		if (this.#closeSent || !this.#socket) return
		this.#closeSent = true
		let payload = Buffer.alloc(0)
		if (code !== undefined) {
			const text = Buffer.from(reason, 'utf8')
			payload = Buffer.alloc(2 + text.length)
			payload.writeUInt16BE(code, 0)
			text.copy(payload, 2)
		}
		this.#socket.write(encodeFrame(OPCODE_CLOSE, payload))
	}

	#scheduleDestroy() {
		if (this.#closeTimer || !this.#socket) return
		this.#closeTimer = setTimeout(() => this.#socket?.destroy(), CLOSE_TIMEOUT_MS)
		this.#closeTimer.unref?.()
	}

	#onSocketError(error) {
		if (this.#readyState === NativeWebSocket.CLOSED) return
		this.#fire('onerror', { type: 'error', error, message: error.message })
	}

	#onSocketClose() {
		clearTimeout(this.#closeTimer)
		this.#closeTimer = null
		const code = this.#failCode ?? this.#remoteClose?.code ?? 1006
		const reason = this.#failCode !== null ? '' : this.#remoteClose?.reason ?? ''
		const wasClean = this.#remoteClose !== null && this.#failCode === null && this.#closeSent
		this.#readyState = NativeWebSocket.CLOSED
		this.#socket = null
		this.#buffer = Buffer.alloc(0)
		this.#fire('onclose', { type: 'close', code, reason, wasClean })
	}

	#fire(name, event) {
		const handler = this[name]
		if (typeof handler !== 'function') return
		try {
			handler.call(this, event)
		} catch (error) {
			queueMicrotask(() => {
				throw error
			})
		}
	}
}

import { EventEmitter } from 'node:events'
import { DEFAULT_ORIGIN } from '../defaults.js'

let h1Dispatcher
let h1DispatcherTried = false
function getH1Dispatcher(logger) {
	if (h1DispatcherTried) return h1Dispatcher
	h1DispatcherTried = true
	try {
		void globalThis.WebSocket
		const base =
			globalThis[Symbol.for('undici.globalDispatcher.2')] ??
			globalThis[Symbol.for('undici.globalDispatcher.1')]
		const Agent = base?.constructor
		if (typeof Agent === 'function' && Agent !== Object) {
			h1Dispatcher = new Agent({ allowH2: false })
		}
	} catch (err) {
		logger?.warn?.({ err }, 'gagal membuat dispatcher HTTP/1.1, pakai default undici')
	}
	return h1Dispatcher
}

export class AbstractSocketClient extends EventEmitter {
	constructor(url, config) {
		super()
		this.url = url
		this.config = config
		this.setMaxListeners(0)
	}
}

export class WebSocketClient extends AbstractSocketClient {
	constructor(...args) {
		super(...args)
		this.socket = null
	}

	get isOpen() {
		return this.socket?.readyState === WebSocket.OPEN
	}

	get isClosed() {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}

	get isClosing() {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}

	get isConnecting() {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		if (this.socket) return

		const { options, connectTimeoutMs, dispatcher } = this.config || {}
		const wsOptions = { headers: { Origin: DEFAULT_ORIGIN, ...(options?.headers || {}) } }
		const h1 = dispatcher || getH1Dispatcher(this.config?.logger)
		if (h1) wsOptions.dispatcher = h1
		if (this.config?.agent) {
			this.config.logger?.warn?.('`agent` is not supported by the native WebSocket; pass an undici `dispatcher` (e.g. ProxyAgent) instead')
		}

		const socket = new WebSocket(this.url, wsOptions)
		this.socket = socket
		socket.binaryType = 'arraybuffer'

		let handshakeTimer
		if (connectTimeoutMs > 0) {
			handshakeTimer = setTimeout(() => {
				if (socket.readyState === WebSocket.CONNECTING) {

					socket.onopen = null
					socket.onmessage = null
					socket.onerror = () => {}
					socket.onclose = () => {}
					this.emit('error', new Error('Opening handshake has timed out'))
					queueMicrotask(() => {
						try { socket.close() } catch {}
					})
				}
			}, connectTimeoutMs)
			handshakeTimer.unref?.()
		}
		const clearHandshake = () => { if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = undefined } }

		socket.onopen = () => { clearHandshake(); this.emit('open') }
		socket.onclose = event => { clearHandshake(); this.emit('close', event.code, event.reason) }
		socket.onerror = event => {
			clearHandshake()

			const raw = event.error || new Error(event.message || 'WebSocket error')
			if (!raw.message) {
				const detail = raw.cause?.message || raw.cause?.code || event.message || 'unknown'
				raw.message = `WebSocket error: ${detail}`
			}
			this.emit('error', raw)
		}
		socket.onmessage = event => {

			const { data } = event
			this.emit('message', typeof data === 'string' ? data : Buffer.from(data))
		}
	}

	async close() {
		const socket = this.socket
		if (!socket) return
		if (socket.readyState === WebSocket.CLOSED) {
			this.socket = null
			return
		}

		if (socket.readyState === WebSocket.CONNECTING) {
			socket.onopen = null
			socket.onmessage = null
			socket.onerror = () => {}
			socket.onclose = () => {}
			this.socket = null

			queueMicrotask(() => {
				try { socket.close() } catch {}
			})
			return
		}

		let onClose
		const closePromise = new Promise(resolve => { onClose = resolve; this.once('close', onClose) })
		try {
			socket.close()
		} catch {

		}
		await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 5000))])
		this.off('close', onClose)
		this.socket = null
	}

	send(str, cb) {
		const socket = this.socket
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			cb?.(new Error('WebSocket is not open'))
			return false
		}
		try {
			socket.send(str)

			if (cb) queueMicrotask(() => cb())
		} catch (err) {
			cb?.(err)
			return false
		}
		return true
	}
}

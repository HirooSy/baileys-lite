import { EventEmitter } from 'node:events'
import { DEFAULT_ORIGIN } from '../defaults.js'
import { NativeWebSocket } from './native-websocket.js'

const WebSocketImpl = globalThis.WebSocket ?? NativeWebSocket
const usingNativeWebSocket = WebSocketImpl === NativeWebSocket

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
		logger?.warn?.({ err }, 'failed to create HTTP/1.1 dispatcher, falling back to the undici default')
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

	emitError(err) {
		if (this.listenerCount('error') > 0) this.emit('error', err)
		else this.config?.logger?.debug?.({ err }, 'ws error ignored (no listener)')
	}

	get isOpen() {
		return this.socket?.readyState === WebSocketImpl.OPEN
	}

	get isClosed() {
		return this.socket === null || this.socket?.readyState === WebSocketImpl.CLOSED
	}

	get isClosing() {
		return this.socket === null || this.socket?.readyState === WebSocketImpl.CLOSING
	}

	get isConnecting() {
		return this.socket?.readyState === WebSocketImpl.CONNECTING
	}

	connect() {
		if (this.socket) return

		const { options, connectTimeoutMs, dispatcher } = this.config || {}
		const wsOptions = { headers: { Origin: DEFAULT_ORIGIN, ...(options?.headers || {}) } }
		if (usingNativeWebSocket) {
			if (dispatcher) this.config?.logger?.warn?.('`dispatcher` is ignored by the built-in WebSocket fallback; proxies are not applied')
		} else {
			const h1 = dispatcher || getH1Dispatcher(this.config?.logger)
			if (h1) wsOptions.dispatcher = h1
		}
		if (this.config?.agent) {
			this.config.logger?.warn?.('`agent` is not supported by the WebSocket client; pass an undici `dispatcher` (e.g. ProxyAgent) on Node.js 22+ instead')
		}

		const socket = new WebSocketImpl(this.url, wsOptions)
		this.socket = socket
		socket.binaryType = 'arraybuffer'

		let handshakeTimer
		if (connectTimeoutMs > 0) {
			handshakeTimer = setTimeout(() => {
				if (socket.readyState === WebSocketImpl.CONNECTING) {

					socket.onopen = null
					socket.onmessage = null
					socket.onerror = () => {}
					socket.onclose = () => {}
					this.emitError(new Error('Opening handshake has timed out'))
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
			this.emitError(raw)
		}
		socket.onmessage = event => {

			const { data } = event
			this.emit('message', typeof data === 'string' ? data : Buffer.from(data))
		}
	}

	async close() {
		const socket = this.socket
		if (!socket) return
		if (socket.readyState === WebSocketImpl.CLOSED) {
			this.socket = null
			return
		}

		if (socket.readyState === WebSocketImpl.CONNECTING) {
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
		if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
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

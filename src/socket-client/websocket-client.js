import { EventEmitter } from 'node:events'
import { DEFAULT_ORIGIN } from '../defaults.js'

/**
 * Replaces `ws`, using Node's built-in `WebSocket` (undici-based, Node 22+).
 *
 * Handshake parity with `ws` (verified against a local server that records request headers):
 *   - `Origin`     -> sent (DEFAULT_ORIGIN), like upstream `ws({ origin })`
 *   - `headers`    -> config.options.headers, like upstream
 *   - `dispatcher` -> config.dispatcher (undici Agent/ProxyAgent) is the native equivalent of
 *                     `ws`'s `agent`, so proxies work; a `ws`-style `config.agent` is NOT supported.
 *   - handshake/connect timeout -> emulated with a timer (native WebSocket has no handshakeTimeout)
 *
 * NOTE: `{ headers, dispatcher }` is an undici extension to the WebSocket constructor, not part of the
 * browser standard. That is fine on Node 22+/24, which is what this package requires.
 *
 * Everything downstream (socket-core.js) talks to this class as a plain Node EventEmitter:
 * `.on('message', buf => ...)`, `.on('open')`, `.on('error')`, `.on('close')`, plus its own namespaced
 * events (`TAG:...`, `CB:...`, `frame`) emitted on itself, not on the underlying transport.
 */
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
		if (dispatcher) wsOptions.dispatcher = dispatcher
		if (this.config?.agent) {
			this.config.logger?.warn?.('`agent` is not supported by the native WebSocket; pass an undici `dispatcher` (e.g. ProxyAgent) instead')
		}

		const socket = new WebSocket(this.url, wsOptions)
		this.socket = socket
		socket.binaryType = 'arraybuffer'

		// emulate ws's `handshakeTimeout`: abort a connection that never opens
		let handshakeTimer
		if (connectTimeoutMs > 0) {
			handshakeTimer = setTimeout(() => {
				if (socket.readyState === WebSocket.CONNECTING) {
					this.emit('error', new Error('Opening handshake has timed out'))
					try { socket.close() } catch {}
				}
			}, connectTimeoutMs)
			handshakeTimer.unref?.()
		}
		const clearHandshake = () => { if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = undefined } }

		socket.onopen = () => { clearHandshake(); this.emit('open') }
		socket.onclose = event => { clearHandshake(); this.emit('close', event.code, event.reason) }
		socket.onerror = event => { clearHandshake(); this.emit('error', event.error || new Error(event.message || 'WebSocket error')) }
		socket.onmessage = event => {
			// `ws` handed listeners a Buffer/string; the native WebSocket hands back an ArrayBuffer
			// (binaryType set above) or a string — normalize to match.
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
		// connect()'s onclose handler emits 'close'; here we only wait for it (like `ws`'s once('close')).
		// Guarded with a timeout: if the underlying transport is stuck (e.g. a wedged TCP
		// socket), 'close' may never fire and this would otherwise hang teardown forever.
		let onClose
		const closePromise = new Promise(resolve => { onClose = resolve; this.once('close', onClose) })
		try { socket.close() } catch {}
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
			// native send() is fire-and-forget; defer the callback to keep `ws`'s async-callback semantics
			if (cb) queueMicrotask(() => cb())
		} catch (err) {
			cb?.(err)
			return false
		}
		return true
	}
}

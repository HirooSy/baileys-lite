const SIZE_NODE_BUDGET = 4000

export const estimateSize = value => {
	let total = 0
	let nodes = 0
	const stack = [value]
	const seen = new Set()
	while (stack.length && nodes < SIZE_NODE_BUDGET) {
		const v = stack.pop()
		nodes++
		switch (typeof v) {
			case 'string':
				total += 16 + v.length
				break
			case 'number':
			case 'boolean':
			case 'bigint':
				total += 8
				break
			case 'object': {
				if (v === null) {
					total += 8
					break
				}
				if (ArrayBuffer.isView(v)) {
					total += 32 + v.byteLength
					break
				}
				if (v instanceof ArrayBuffer) {
					total += 32 + v.byteLength
					break
				}
				if (seen.has(v)) break
				seen.add(v)
				if (Array.isArray(v)) {
					total += 16 + v.length * 8
					for (let i = 0; i < v.length; i++) stack.push(v[i])
				} else {
					const keys = Object.keys(v)
					total += 32 + keys.length * 16
					for (let i = 0; i < keys.length; i++) {
						total += keys[i].length
						stack.push(v[keys[i]])
					}
				}
				break
			}
			default:
				break
		}
	}
	if (stack.length) total += stack.length * 64
	return total
}

export class Cache {
	constructor(options = {}) {
		this.ttl = options.ttl ?? (options.stdTTL ? options.stdTTL * 1000 : 0)
		this.max = options.max || Infinity
		this.maxBytes = options.maxBytes || 0
		this.sizeOf = options.sizeOf || estimateSize
		this.updateAgeOnGet = !!options.updateAgeOnGet
		this.dispose = options.dispose || (() => {})
		this._store = new Map()
		this._bytes = 0

		if (this.ttl > 0) {
			const ref = new WeakRef(this)
			const timer = setInterval(() => {
				const cache = ref.deref()
				if (cache) cache._sweep()
				else clearInterval(timer)
			}, Math.min(this.ttl, 60_000))
			timer.unref?.()
			this._sweeper = timer
		}
	}

	_isExpired(entry) {
		return this.ttl > 0 && entry.expiresAt !== 0 && entry.expiresAt <= Date.now()
	}

	_remove(key, entry) {
		this._store.delete(key)
		this._bytes -= entry.size
		this.dispose(entry.value, key)
	}

	_sweep() {
		const now = Date.now()
		for (const [key, entry] of this._store) {
			if (entry.expiresAt !== 0 && entry.expiresAt <= now) this._remove(key, entry)
		}
	}

	_evict() {
		while (this._store.size > this.max || (this.maxBytes > 0 && this._bytes > this.maxBytes && this._store.size > 1)) {
			const oldestKey = this._store.keys().next().value
			this._remove(oldestKey, this._store.get(oldestKey))
		}
	}

	get(key) {
		const entry = this._store.get(key)
		if (!entry) return undefined
		if (this._isExpired(entry)) {
			this._remove(key, entry)
			return undefined
		}
		if (this.updateAgeOnGet && this.ttl > 0) {
			entry.expiresAt = Date.now() + this.ttl
			this._store.delete(key)
			this._store.set(key, entry)
		}
		return entry.value
	}

	set(key, value) {
		const previous = this._store.get(key)
		if (previous) {
			this._store.delete(key)
			this._bytes -= previous.size
		}
		const size = this.maxBytes > 0 ? this.sizeOf(value) : 0
		this._store.set(key, { value, size, expiresAt: this.ttl > 0 ? Date.now() + this.ttl : 0 })
		this._bytes += size
		this._evict()
		return true
	}

	has(key) {
		const entry = this._store.get(key)
		if (!entry) return false
		if (this._isExpired(entry)) {
			this._remove(key, entry)
			return false
		}
		return true
	}

	delete(key) {
		const entry = this._store.get(key)
		if (!entry) return false
		this._remove(key, entry)
		return true
	}

	clear() {
		const entries = [...this._store]
		this._store.clear()
		this._bytes = 0
		for (const [key, entry] of entries) this.dispose(entry.value, key)
	}

	flushAll() {
		this.clear()
	}

	del(key) {
		return this.delete(key)
	}

	close() {
		if (this._sweeper) {
			clearInterval(this._sweeper)
			this._sweeper = undefined
		}
		this.clear()
	}

	mget(keys) {
		const result = {}
		for (const key of keys) {
			const value = this.get(key)
			if (value !== undefined) result[key] = value
		}
		return result
	}

	mset(data) {
		for (const item of data) this.set(item.key, item.value)
		return true
	}

	get size() {
		return this._store.size
	}

	get bytes() {
		return this._bytes
	}
}

export const LRUCache = Cache
export const NodeCache = Cache

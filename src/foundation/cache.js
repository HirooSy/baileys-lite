export class Cache {
	constructor(options = {}) {
		this.ttl = options.ttl ?? (options.stdTTL ? options.stdTTL * 1000 : 0)
		this.max = options.max || Infinity
		this.updateAgeOnGet = !!options.updateAgeOnGet
		this.dispose = options.dispose || (() => {})
		this._store = new Map()

		if (this.ttl > 0) {
			this._sweeper = setInterval(() => this._sweep(), Math.min(this.ttl, 60_000))
			this._sweeper.unref?.()
		}
	}

	_isExpired(entry) {
		return this.ttl > 0 && entry.expiresAt !== 0 && entry.expiresAt <= Date.now()
	}

	_sweep() {
		const now = Date.now()
		for (const [key, entry] of this._store) {
			if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
				this._store.delete(key)
				this.dispose(entry.value, key)
			}
		}
	}

	get(key) {
		const entry = this._store.get(key)
		if (!entry) return undefined
		if (this._isExpired(entry)) {
			this._store.delete(key)
			this.dispose(entry.value, key)
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
		if (this._store.has(key)) this._store.delete(key)
		this._store.set(key, {
			value,
			expiresAt: this.ttl > 0 ? Date.now() + this.ttl : 0
		})
		while (this._store.size > this.max) {
			const oldestKey = this._store.keys().next().value
			const oldest = this._store.get(oldestKey)
			this._store.delete(oldestKey)
			this.dispose(oldest.value, oldestKey)
		}
		return true
	}

	has(key) {
		const entry = this._store.get(key)
		if (!entry) return false
		if (this._isExpired(entry)) {
			this._store.delete(key)
			this.dispose(entry.value, key)
			return false
		}
		return true
	}

	delete(key) {
		const entry = this._store.get(key)
		if (!entry) return false
		this._store.delete(key)
		this.dispose(entry.value, key)
		return true
	}

	clear() {
		for (const [key, entry] of this._store) this.dispose(entry.value, key)
		this._store.clear()
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
}

export const LRUCache = Cache
export const NodeCache = Cache

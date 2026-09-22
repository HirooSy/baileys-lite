/**
 * Replaces `lru-cache` and `@cacheable/node-cache`.
 *
 * Covers exactly the surface Baileys uses against both libraries:
 *   get(key), set(key, value), has(key), delete(key), clear()/flushAll()
 * with:
 *   - ttl (ms): entries expire after this long
 *   - max: hard cap on entry count (oldest inserted/refreshed evicted first)
 *   - updateAgeOnGet: a `get()` refreshes the entry's TTL clock (both libs support this)
 *   - dispose(value, key): called when an entry is evicted, whether by TTL or by `max`
 *
 * Built on a plain Map (insertion order == recency order once we re-insert on
 * touch), with a lazy sweep instead of a per-entry timer so a cache with many
 * short-lived entries doesn't spin up thousands of timers.
 */

export class Cache {
	constructor(options = {}) {
		this.ttl = options.ttl ?? (options.stdTTL ? options.stdTTL * 1000 : 0) // stdTTL is node-cache's seconds-based option
		this.max = options.max || Infinity
		this.updateAgeOnGet = !!options.updateAgeOnGet
		this.dispose = options.dispose || (() => {})
		this._store = new Map() // key -> { value, expiresAt }

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
			// re-insert to move to the back (most-recently-used) for `max` eviction order
			this._store.delete(key)
			this._store.set(key, entry)
		}
		return entry.value
	}

	set(key, value) {
		if (this._store.has(key)) this._store.delete(key) // re-insert to refresh recency order
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

	// node-cache alias
	flushAll() {
		this.clear()
	}

	// node-cache alias: `del(key)` (Baileys calls this, e.g. msgRetryCache.del / placeholderResendCache.del)
	del(key) {
		return this.delete(key)
	}

	/** node-cache's close(): stop the background sweeper so the process can exit cleanly. */
	close() {
		if (this._sweeper) {
			clearInterval(this._sweeper)
			this._sweeper = undefined
		}
	}

	/** node-cache's mget: returns { [key]: value } for keys that were found (and not expired). */
	mget(keys) {
		const result = {}
		for (const key of keys) {
			const value = this.get(key)
			if (value !== undefined) result[key] = value
		}
		return result
	}

	/** node-cache's mset: data is an array of { key, value, ttl? } (ttl currently ignored — per-entry TTL override not needed by Baileys' usage). */
	mset(data) {
		for (const item of data) this.set(item.key, item.value)
		return true
	}

	get size() {
		return this._store.size
	}
}

/** Factory mirroring `new LRUCache(opts)` / `new NodeCache(opts)` call sites. */
export const LRUCache = Cache
export const NodeCache = Cache

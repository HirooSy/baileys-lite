/**
 * Replaces `async-mutex` and `p-queue`.
 *
 * Every usage of both libraries in Baileys is a plain serial (concurrency = 1)
 * task queue: run async tasks one at a time, in submission order, each waiting
 * for the previous to settle. That's implementable with a single chained
 * promise and no external dependency.
 */

/** A single serial execution lane. */
class SerialQueue {
	constructor() {
		this._tail = Promise.resolve()
	}

	/** Run `task` once all previously-queued tasks have settled. Returns task's result/throw. */
	run(task) {
		const result = this._tail.then(() => task())
		// swallow so a rejected task doesn't break the chain for the next task
		this._tail = result.then(
			() => undefined,
			() => undefined
		)
		return result
	}
}

/** Replacement for async-mutex's `Mutex`: mutex().runExclusive(fn) -> mutex(fn). */
export const makeMutex = () => {
	const queue = new SerialQueue()
	return {
		mutex(task) {
			return queue.run(task)
		}
	}
}

/** Replacement for a Map<key, Mutex>: one independent serial lane per key, garbage collected when idle. */
export const makeKeyedMutex = () => {
	const lanes = new Map()
	return {
		async mutex(key, task) {
			let entry = lanes.get(key)
			if (!entry) {
				entry = { queue: new SerialQueue(), refCount: 0 }
				lanes.set(key, entry)
			}
			entry.refCount++
			try {
				return await entry.queue.run(task)
			} finally {
				entry.refCount--
				if (entry.refCount === 0 && lanes.get(key) === entry) {
					lanes.delete(key)
				}
			}
		}
	}
}

/**
 * Replacement for `new PQueue({ concurrency: 1 })`.
 * Only the `.add(fn)` API is used anywhere in Baileys, so that's all this covers.
 */
export const makeSerialTaskQueue = () => {
	const queue = new SerialQueue()
	return {
		add(task) {
			return queue.run(task)
		}
	}
}

/** Map<key, serial task queue>, created lazily — used by PreKeyManager / auth key queues. */
export const makeKeyedSerialTaskQueues = () => {
	const queues = new Map()
	return {
		get(key) {
			let q = queues.get(key)
			if (!q) {
				q = makeSerialTaskQueue()
				queues.set(key, q)
			}
			return q
		}
	}
}

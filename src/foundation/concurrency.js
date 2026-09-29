class SerialQueue {
	constructor() {
		this._tail = Promise.resolve()
	}

	run(task) {
		const result = this._tail.then(() => task())

		this._tail = result.then(
			() => undefined,
			() => undefined
		)
		return result
	}
}

export const makeMutex = () => {
	const queue = new SerialQueue()
	return {
		mutex(task) {
			return queue.run(task)
		}
	}
}

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

export const makeSerialTaskQueue = () => {
	const queue = new SerialQueue()
	return {
		add(task) {
			return queue.run(task)
		}
	}
}

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

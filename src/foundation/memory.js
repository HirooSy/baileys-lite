import v8 from 'node:v8'
import vm from 'node:vm'

const MB = 1024 * 1024

export const DEFAULT_MEMORY_TRIM = {
	enabled: true,
	checkIntervalMs: 15_000,
	minIntervalMs: 30_000,
	growthBytes: 16 * MB,
	unusedHeapBytes: 16 * MB
}

let collector
let lastTrimAt = 0
let lastTrimRss = 0
let trimming = false
let guardTimer
let guardRefs = 0
let guardOptions = DEFAULT_MEMORY_TRIM
let pendingTrim

const resolveCollector = () => {
	if (collector !== undefined) return collector
	if (typeof globalThis.gc === 'function') {
		collector = globalThis.gc
		return collector
	}
	try {
		v8.setFlagsFromString('--expose-gc')
		collector = vm.runInNewContext('gc')
		v8.setFlagsFromString('--no-expose-gc')
	} catch {
		collector = null
	}
	return collector
}

export const trimMemory = () => {
	if (trimming) return false
	const collect = resolveCollector()
	if (!collect) return false
	trimming = true
	try {
		try {
			collect({ type: 'major', execution: 'sync', flavor: 'last-resort' })
		} catch {
			collect()
		}
		lastTrimAt = Date.now()
		lastTrimRss = process.memoryUsage.rss()
		return true
	} finally {
		trimming = false
	}
}

export const requestTrim = (delayMs = 2000) => {
	if (!guardOptions.enabled) return
	if (pendingTrim) clearTimeout(pendingTrim)
	pendingTrim = setTimeout(() => {
		pendingTrim = undefined
		if (Date.now() - lastTrimAt >= 5000) trimMemory()
	}, delayMs)
	pendingTrim.unref?.()
}

const guardTick = () => {
	const now = Date.now()
	if (now - lastTrimAt < guardOptions.minIntervalMs) return
	const usage = process.memoryUsage()
	const grew = usage.rss - lastTrimRss >= guardOptions.growthBytes
	const unused = usage.heapTotal - usage.heapUsed >= guardOptions.unusedHeapBytes
	if (grew || unused) trimMemory()
}

export const retainMemoryGuard = options => {
	const resolved = { ...DEFAULT_MEMORY_TRIM, ...(options === false ? { enabled: false } : options || {}) }
	guardOptions = resolved
	if (!resolved.enabled) return () => {}
	guardRefs++
	if (!guardTimer) {
		lastTrimRss = process.memoryUsage.rss()
		guardTimer = setInterval(guardTick, resolved.checkIntervalMs)
		guardTimer.unref?.()
	}
	let released = false
	return () => {
		if (released) return
		released = true
		guardRefs--
		if (guardRefs <= 0) {
			guardRefs = 0
			clearInterval(guardTimer)
			guardTimer = undefined
			if (pendingTrim) {
				clearTimeout(pendingTrim)
				pendingTrim = undefined
			}
			requestTrim(1500)
		}
	}
}

import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

let data

const load = () => (data ??= nodeRequire('./wam-data.json'))

const lazyList = key =>
	new Proxy([], {
		get(_, prop) {
			const target = load()[key]
			const value = Reflect.get(target, prop, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
		has: (_, prop) => Reflect.has(load()[key], prop),
		ownKeys: () => Reflect.ownKeys(load()[key]),
		getOwnPropertyDescriptor: (_, prop) => Reflect.getOwnPropertyDescriptor(load()[key], prop)
	})

export const WEB_EVENTS = lazyList('WEB_EVENTS')
export const WEB_GLOBALS = lazyList('WEB_GLOBALS')
export const FLAG_BYTE = 8, FLAG_GLOBAL = 0, FLAG_EVENT = 1, FLAG_FIELD = 2, FLAG_EXTENDED = 4;

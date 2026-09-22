/**
 * Auth-state persistence adapters. Combines what used to be:
 *   use-multi-file-auth-state.js, use-single-file-auth-state.js, use-sqlite-auth-state.js
 *
 * SQLite backend is `node:sqlite` (built into Node, stable release-candidate as of Node 24; no
 * install needed). `opts.database` still accepts any object shaped like `better-sqlite3` (or
 * `node:sqlite`'s own DatabaseSync) if the app wants to bring its own connection/driver — see
 * DB_ADAPTER below for the two shims that bridge the small API differences.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { proto } from '../../WAProto/index.js'
import { initAuthCreds } from './auth-state-core.js'
import { BufferJSON } from './wa-protocol-core.js'
import { Cache } from '../foundation/cache.js'
import { makeKeyedMutex } from '../foundation/concurrency.js'

/* ------------------------------------------------------------------ */
/* Multi-file auth state (one JSON file per key)                       */
/* ------------------------------------------------------------------ */

/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate.
 *
 * Wouldn't endorse this for anything beyond a bot; use a proper DB for production.
 */
export const useMultiFileAuthState = async folder => {
	const fileLock = makeKeyedMutex() // guards concurrent read/write of the same file path

	const fixFileName = file => file?.replace(/\//g, '__')?.replace(/:/g, '-')

	const writeData = async (data, file) => {
		const filePath = join(folder, fixFileName(file))
		return fileLock.mutex(filePath, () => writeFile(filePath, JSON.stringify(data, BufferJSON.replacer)))
	}
	const readData = async file => {
		try {
			const filePath = join(folder, fixFileName(file))
			return await fileLock.mutex(filePath, async () => {
				const data = await readFile(filePath, { encoding: 'utf-8' })
				return JSON.parse(data, BufferJSON.reviver)
			})
		} catch {
			return null
		}
	}
	const removeData = async file => {
		try {
			const filePath = join(folder, fixFileName(file))
			await fileLock.mutex(filePath, async () => {
				try {
					await unlink(filePath)
				} catch {
					// ignore
				}
			})
		} catch {
			// ignore
		}
	}

	const folderInfo = await stat(folder).catch(() => {})
	if (folderInfo) {
		if (!folderInfo.isDirectory()) {
			throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`)
		}
	} else {
		await mkdir(folder, { recursive: true })
	}

	const creds = (await readData('creds.json')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data = {}
					await Promise.all(
						ids.map(async id => {
							let value = await readData(`${type}-${id}.json`)
							if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
							data[id] = value
						})
					)
					return data
				},
				set: async data => {
					const tasks = []
					for (const category in data) {
						for (const id in data[category]) {
							const value = data[category][id]
							const file = `${category}-${id}.json`
							tasks.push(value ? writeData(value, file) : removeData(file))
						}
					}
					await Promise.all(tasks)
				}
			}
		},
		saveCreds: async () => writeData(creds, 'creds.json')
	}
}

/* ------------------------------------------------------------------ */
/* Single-file auth state (one JSON file, in-memory cached)             */
/* ------------------------------------------------------------------ */

const SIGNAL_STORE_TTL_MS = 5 * 60 * 1000
const FLUSH_TIMEOUT_MS = 3000

export const useSingleFileAuthState = async fileName => {
	const cache = new Cache({ max: 20000, ttl: SIGNAL_STORE_TTL_MS })
	const mutex = makeKeyedMutex()
	let fileData = {}
	let isLoaded = false
	let flushTimeout = null

	const loadKey = () =>
		mutex.mutex('__file__', async () => {
			if (isLoaded) return
			try {
				const data = JSON.parse(await readFile(fileName, 'utf-8'), BufferJSON.reviver)
				fileData = data || {}
				for (const [keyName, value] of Object.entries(fileData)) cache.set(keyName, value)
			} catch {
				fileData = {}
			}
			isLoaded = true
		})

	const flushKey = () => {
		if (flushTimeout) return
		flushTimeout = setTimeout(async () => {
			flushTimeout = null
			await mutex.mutex('__file__', async () => {
				try {
					const tempFile = fileName + '.temp'
					await writeFile(tempFile, JSON.stringify(fileData, BufferJSON.replacer))
					await rename(tempFile, fileName)
				} catch {
					// ignore
				}
			})
		}, FLUSH_TIMEOUT_MS)
	}

	const writeKey = (keyName, value) => {
		cache.set(keyName, value)
		fileData[keyName] = value
		flushKey()
	}
	const removeKey = keyName => {
		cache.delete(keyName)
		delete fileData[keyName]
		flushKey()
	}

	const fileInfo = await stat(fileName).catch(() => null)
	if (!fileInfo) {
		await writeFile(fileName, '{}')
	} else if (!fileInfo.isFile()) {
		throw new Error(`found something that is not a file at ${fileName}, either delete it or specify a different location`)
	}

	await loadKey()
	const creds = fileData['creds'] || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: (type, ids) => {
					const data = {}
					for (const id of ids) {
						const keyName = type + id
						let value = cache.get(keyName)
						if (value === undefined && fileData[keyName] !== undefined) {
							value = fileData[keyName]
							cache.set(keyName, value)
						}
						if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
						data[id] = value
					}
					return data
				},
				set: data => {
					for (const category in data) {
						for (const id in data[category]) {
							const keyName = category + id
							const value = data[category][id]
							value ? writeKey(keyName, value) : removeKey(keyName)
						}
					}
				}
			}
		},
		saveCreds: () => writeKey('creds', creds)
	}
}

/* ------------------------------------------------------------------ */
/* SQLite auth state (built-in `node:sqlite`, no install required)     */
/* ------------------------------------------------------------------ */

/**
 * `node:sqlite`'s DatabaseSync has no `.pragma()` and no `.transaction()` (the two things
 * `better-sqlite3` offers beyond plain `.exec()`/`.prepare()`). This adapter fills both in with
 * the same net effect, and passes through untouched when `opts.database` is a `better-sqlite3`
 * instance (or anything else that already has real `.pragma`/`.transaction` methods) so bring-
 * your-own-driver keeps working exactly as before.
 */
function adaptDb(db) {
	const pragma = typeof db.pragma === 'function' ? stmt => db.pragma(stmt) : stmt => db.exec(`PRAGMA ${stmt}`)
	const transaction =
		typeof db.transaction === 'function'
			? fn => db.transaction(fn)
			: fn =>
					(...args) => {
						db.exec('BEGIN')
						try {
							const result = fn(...args)
							db.exec('COMMIT')
							return result
						} catch (err) {
							db.exec('ROLLBACK')
							throw err
						}
					}
	return { db, pragma, transaction }
}

const CREDS_ROW_KEY = '__creds__'
const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS signal_keys_type_idx ON signal_keys(type);
`

export async function useSqliteAuthState(opts) {
	const rawDb = opts.database ?? new DatabaseSync(opts.dbPath)
	const { db, pragma, transaction } = adaptDb(rawDb)
	// WAL mode allows concurrent reads alongside a single writer; matches
	// what SQLite recommends for read-heavy workloads with sporadic writes.
	pragma('journal_mode = WAL')
	pragma('synchronous = NORMAL')
	db.exec(CREATE_SCHEMA_SQL)

	const stmts = {
		credsSelect: db.prepare('SELECT value FROM creds WHERE key = ?'),
		credsUpsert: db.prepare('INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
		keySelect: db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
		keyUpsert: db.prepare('INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'),
		keyDelete: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
		keyListIds: db.prepare('SELECT id FROM signal_keys WHERE type = ?'),
		keyList: db.prepare('SELECT id, value FROM signal_keys WHERE type = ?'),
		clearKeys: db.prepare('DELETE FROM signal_keys')
	}

	const loadCreds = () => {
		const row = stmts.credsSelect.get(CREDS_ROW_KEY)
		if (!row) return initAuthCreds()
		return JSON.parse(row.value, BufferJSON.reviver)
	}
	const persistCreds = creds => {
		stmts.credsUpsert.run(CREDS_ROW_KEY, JSON.stringify(creds, BufferJSON.replacer))
	}

	const creds = loadCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data = {}
					for (const id of ids) {
						const row = stmts.keySelect.get(type, id)
						if (row) {
							let value = JSON.parse(row.value, BufferJSON.reviver)
							if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
							data[id] = value
						}
					}
					return data
				},
				set: async data => {
					const writeTx = transaction(() => {
						for (const category in data) {
							for (const id in data[category]) {
								const value = data[category][id]
								if (value) {
									stmts.keyUpsert.run(category, id, JSON.stringify(value, BufferJSON.replacer))
								} else {
									stmts.keyDelete.run(category, id)
								}
							}
						}
					})
					writeTx()
				}
			}
		},
		saveCreds: async () => persistCreds(creds)
	}
}

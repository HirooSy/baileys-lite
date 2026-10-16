import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const MAGIC = '{"nsql":1}'
const COMPACT_MIN_BYTES = 256 * 1024
const COMPACT_GROWTH_RATIO = 0.5
const CONTROL = new Set(['begin', 'commit', 'rollback'])
const TOKEN = /\s+|'((?:[^']|'')*)'|"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|([(),;=?*.-])/y

class SqlError extends Error {
	constructor(message) {
		super(message)
		this.name = 'SqlError'
	}
}

const lower = name => name.toLowerCase()

const keyOf = (table, row) => JSON.stringify(table.pk.map(i => row[i]))

const sameRow = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

const bind = (count, params) => {
	if (params.length !== count) throw new SqlError(`expected ${count} parameters, got ${params.length}`)
	return params.map(value => {
		if (value === null || typeof value === 'string') return value
		if (typeof value === 'boolean') return Number(value)
		if (typeof value === 'number' && Number.isFinite(value)) return value
		throw new SqlError(`unsupported parameter type: ${typeof value}`)
	})
}

const tokenize = sql => {
	const tokens = []
	TOKEN.lastIndex = 0
	while (TOKEN.lastIndex < sql.length) {
		const at = TOKEN.lastIndex
		const m = TOKEN.exec(sql)
		if (!m) throw new SqlError(`unexpected character at offset ${at}`)
		const end = TOKEN.lastIndex
		let token = null
		if (m[1] !== undefined) token = { k: 'str', v: m[1].replace(/''/g, "'") }
		else if (m[5] !== undefined) token = { k: 'num', v: Number(m[5]) }
		else if (m[6] !== undefined) token = { k: 'id', v: m[6] }
		else if (m[7] !== undefined) token = { k: 'p', v: m[7] }
		else if (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined) token = { k: 'id', v: m[2] ?? m[3] ?? m[4] }
		if (token) tokens.push({ ...token, at, end })
	}
	tokens.push({ k: 'eof', at: sql.length, end: sql.length })
	return tokens
}

class Parser {
	constructor(tokens) {
		this.tokens = tokens
		this.pos = 0
		this.params = 0
	}

	peek() {
		return this.tokens[this.pos]
	}

	next() {
		return this.tokens[this.pos++]
	}

	isKw(word) {
		const t = this.peek()
		return t.k === 'id' && t.v.toUpperCase() === word
	}

	eatKw(word) {
		if (!this.isKw(word)) return false
		this.pos++
		return true
	}

	expectKw(word) {
		if (!this.eatKw(word)) throw new SqlError(`expected ${word}`)
	}

	isP(ch) {
		const t = this.peek()
		return t.k === 'p' && t.v === ch
	}

	eatP(ch) {
		if (!this.isP(ch)) return false
		this.pos++
		return true
	}

	expectP(ch) {
		if (!this.eatP(ch)) throw new SqlError(`expected '${ch}'`)
	}

	ident() {
		const t = this.next()
		if (t.k !== 'id') throw new SqlError('expected identifier')
		return t.v
	}

	identList() {
		this.expectP('(')
		const names = [this.ident()]
		while (this.eatP(',')) names.push(this.ident())
		this.expectP(')')
		return names
	}

	operand() {
		const t = this.next()
		if (t.k === 'str' || t.k === 'num') return { kind: 'lit', value: t.v }
		if (t.k === 'p' && t.v === '?') return { kind: 'param', index: this.params++ }
		if (t.k === 'p' && t.v === '-' && this.peek().k === 'num') return { kind: 'lit', value: -this.next().v }
		if (t.k === 'id' && t.v.toUpperCase() === 'NULL') return { kind: 'lit', value: null }
		if (t.k === 'id' && t.v.toUpperCase() === 'EXCLUDED' && this.eatP('.')) return { kind: 'excluded', column: this.ident() }
		throw new SqlError('unsupported expression')
	}

	statement() {
		const t = this.peek()
		const word = t.k === 'id' ? t.v.toUpperCase() : ''
		switch (word) {
			case 'CREATE':
				return this.create()
			case 'INSERT':
				return this.insert()
			case 'SELECT':
				return this.select()
			case 'DELETE':
				return this.remove()
			case 'PRAGMA':
				return this.skip()
			case 'BEGIN':
				return this.control('begin')
			case 'COMMIT':
			case 'END':
				return this.control('commit')
			case 'ROLLBACK':
				return this.control('rollback')
			default:
				throw new SqlError(`unsupported statement${word ? ` ${word}` : ''}`)
		}
	}

	control(type) {
		this.next()
		this.eatKw('TRANSACTION')
		return { type, write: false }
	}

	skip() {
		this.next()
		while (!this.isP(';') && this.peek().k !== 'eof') this.next()
		return { type: 'noop', write: false }
	}

	create() {
		this.next()
		if (this.isKw('UNIQUE')) throw new SqlError('unique indexes are not supported')
		if (this.eatKw('TABLE')) return this.createTable()
		if (this.eatKw('INDEX')) return this.createIndex()
		throw new SqlError('unsupported CREATE statement')
	}

	ifNotExists() {
		if (!this.eatKw('IF')) return false
		this.expectKw('NOT')
		this.expectKw('EXISTS')
		return true
	}

	createTable() {
		const ifNotExists = this.ifNotExists()
		const name = this.ident()
		this.expectP('(')
		const columns = []
		let primaryKey = null
		do {
			if (this.eatKw('PRIMARY')) {
				this.expectKw('KEY')
				primaryKey = this.identList()
			} else {
				columns.push(this.columnDef())
			}
		} while (this.eatP(','))
		this.expectP(')')
		const key = primaryKey ?? columns.filter(c => c.primary).map(c => c.name)
		if (!key.length) throw new SqlError(`table ${name} needs a PRIMARY KEY`)
		return { type: 'create_table', name, ifNotExists, columns, primaryKey: key, write: true }
	}

	columnDef() {
		const column = { name: this.ident(), notNull: false, primary: false }
		if (this.peek().k === 'id' && !this.isKw('NOT') && !this.isKw('PRIMARY')) this.next()
		for (;;) {
			if (this.eatKw('NOT')) {
				this.expectKw('NULL')
				column.notNull = true
			} else if (this.eatKw('PRIMARY')) {
				this.expectKw('KEY')
				column.primary = true
			} else {
				return column
			}
		}
	}

	createIndex() {
		const ifNotExists = this.ifNotExists()
		const name = this.ident()
		this.expectKw('ON')
		const table = this.ident()
		const columns = this.identList()
		return { type: 'create_index', name, table, columns, ifNotExists, write: true }
	}

	insert() {
		this.next()
		let replace = false
		if (this.eatKw('OR')) {
			this.expectKw('REPLACE')
			replace = true
		}
		this.expectKw('INTO')
		const table = this.ident()
		const columns = this.isP('(') ? this.identList() : null
		this.expectKw('VALUES')
		this.expectP('(')
		const values = [this.operand()]
		while (this.eatP(',')) values.push(this.operand())
		this.expectP(')')
		let onConflict = null
		if (this.eatKw('ON')) {
			this.expectKw('CONFLICT')
			const target = this.identList()
			this.expectKw('DO')
			if (this.eatKw('NOTHING')) {
				onConflict = { target, action: 'nothing' }
			} else {
				this.expectKw('UPDATE')
				this.expectKw('SET')
				const sets = []
				do {
					const column = this.ident()
					this.expectP('=')
					sets.push({ column, operand: this.operand() })
				} while (this.eatP(','))
				onConflict = { target, action: 'update', sets }
			}
		}
		return { type: 'insert', table, columns, values, replace, onConflict, write: true }
	}

	select() {
		this.next()
		let columns = '*'
		if (!this.eatP('*')) {
			columns = [this.ident()]
			while (this.eatP(',')) columns.push(this.ident())
		}
		this.expectKw('FROM')
		const table = this.ident()
		return { type: 'select', table, columns, where: this.where(), write: false }
	}

	remove() {
		this.next()
		this.expectKw('FROM')
		const table = this.ident()
		return { type: 'delete', table, where: this.where(), write: true }
	}

	where() {
		const conditions = []
		if (!this.eatKw('WHERE')) return conditions
		do {
			const column = this.ident()
			this.expectP('=')
			conditions.push({ column, operand: this.operand() })
		} while (this.eatKw('AND'))
		return conditions
	}
}

const parseStatements = sql => {
	const parser = new Parser(tokenize(sql))
	const statements = []
	while (parser.peek().k !== 'eof') {
		if (parser.eatP(';')) continue
		const start = parser.peek().at
		parser.params = 0
		const stmt = parser.statement()
		const end = parser.tokens[parser.pos - 1].end
		if (!parser.eatP(';') && parser.peek().k !== 'eof') throw new SqlError('expected ;')
		stmt.text = sql.slice(start, end)
		stmt.paramCount = parser.params
		statements.push(stmt)
	}
	return statements
}

export class SqlDatabase {
	#tables = new Map()
	#indexes = new Map()
	#undo = []
	#pending = []
	#inTxn = false
	#path = null
	#logBytes = 0
	#baseBytes = 0
	#closed = false

	constructor(path = ':memory:') {
		if (path !== ':memory:') this.#open(path)
	}

	exec(sql) {
		this.#assertOpen()
		for (const stmt of parseStatements(sql)) this.#invoke(stmt, [])
	}

	prepare(sql) {
		this.#assertOpen()
		const statements = parseStatements(sql)
		if (statements.length !== 1) throw new SqlError('prepare expects exactly one statement')
		const [stmt] = statements
		return {
			run: (...params) => ({ changes: this.#invoke(stmt, params).changes }),
			get: (...params) => this.#invoke(stmt, params).rows[0],
			all: (...params) => this.#invoke(stmt, params).rows
		}
	}

	transaction(fn) {
		return (...args) => {
			this.#assertOpen()
			if (this.#inTxn) return fn(...args)
			this.#control('begin')
			try {
				const result = fn(...args)
				this.#commit()
				return result
			} catch (err) {
				this.#rollback()
				throw err
			}
		}
	}

	close() {
		this.#rollback()
		this.#closed = true
	}

	#assertOpen() {
		if (this.#closed) throw new SqlError('database is closed')
	}

	#invoke(stmt, params) {
		this.#assertOpen()
		if (CONTROL.has(stmt.type)) return this.#control(stmt.type)
		const values = bind(stmt.paramCount, params)
		return this.#statement(() => {
			const result = this.#execute(stmt, values)
			if (stmt.write && result.changes && !result.noop) this.#pending.push([stmt.text, values])
			return result
		})
	}

	#control(type) {
		if (type === 'begin') {
			if (this.#inTxn) throw new SqlError('cannot start a transaction within a transaction')
			this.#inTxn = true
		} else if (!this.#inTxn) {
			throw new SqlError('no transaction is active')
		} else if (type === 'commit') {
			this.#commit()
		} else {
			this.#rollback()
		}
		return { changes: 0, rows: [] }
	}

	#statement(fn) {
		const auto = !this.#inTxn
		if (auto) this.#inTxn = true
		const mark = this.#undo.length
		const pmark = this.#pending.length
		let result
		try {
			result = fn()
		} catch (err) {
			this.#undoTo(mark)
			this.#pending.length = pmark
			if (auto) this.#end()
			throw err
		}
		if (auto) this.#commit()
		return result
	}

	#commit() {
		try {
			if (this.#path !== null && this.#pending.length) this.#append(this.#pending)
		} catch (err) {
			this.#rollback()
			throw err
		}
		this.#end()
		this.#maybeCompact()
	}

	#rollback() {
		this.#undoTo(0)
		this.#end()
	}

	#undoTo(mark) {
		while (this.#undo.length > mark) this.#undo.pop()()
	}

	#end() {
		this.#undo = []
		this.#pending = []
		this.#inTxn = false
	}

	#execute(stmt, params) {
		switch (stmt.type) {
			case 'create_table':
				return this.#createTable(stmt)
			case 'create_index':
				return this.#createIndex(stmt)
			case 'insert':
				return this.#insert(stmt, params)
			case 'delete':
				return this.#deleteRows(stmt, params)
			case 'select':
				return this.#selectRows(stmt, params)
			default:
				return { changes: 0, rows: [] }
		}
	}

	#table(name) {
		const table = this.#tables.get(lower(name))
		if (!table) throw new SqlError(`no such table: ${name}`)
		return table
	}

	#column(table, name) {
		const i = table.colIndex.get(lower(name))
		if (i === undefined) throw new SqlError(`no such column: ${name}`)
		return i
	}

	#isPrimaryKey(table, names) {
		const cols = names.map(n => this.#column(table, n))
		return cols.length === table.pk.length && cols.every(i => table.pk.includes(i))
	}

	#value(operand, params) {
		if (operand.kind === 'param') return params[operand.index]
		if (operand.kind === 'lit') return operand.value
		throw new SqlError('excluded is only valid in ON CONFLICT ... DO UPDATE SET')
	}

	#checkNotNull(table, row) {
		table.columns.forEach((c, i) => {
			if (c.notNull && row[i] === null) throw new SqlError(`NOT NULL constraint failed: ${table.name}.${c.name}`)
		})
	}

	#createTable(stmt) {
		const key = lower(stmt.name)
		if (this.#tables.has(key)) {
			if (stmt.ifNotExists) return { changes: 0, rows: [] }
			throw new SqlError(`table ${stmt.name} already exists`)
		}
		const pkNames = stmt.primaryKey.map(lower)
		const columns = stmt.columns.map(c => ({ name: c.name, notNull: c.notNull || pkNames.includes(lower(c.name)) }))
		const colIndex = new Map(columns.map((c, i) => [lower(c.name), i]))
		const pk = stmt.primaryKey.map(name => {
			const i = colIndex.get(lower(name))
			if (i === undefined) throw new SqlError(`no such column: ${name}`)
			return i
		})
		const table = { name: stmt.name, sql: stmt.text, columns, colIndex, pk, rows: new Map(), indexes: [] }
		this.#tables.set(key, table)
		this.#undo.push(() => this.#tables.delete(key))
		return { changes: 1, rows: [] }
	}

	#createIndex(stmt) {
		const key = lower(stmt.name)
		if (this.#indexes.has(key)) {
			if (stmt.ifNotExists) return { changes: 0, rows: [] }
			throw new SqlError(`index ${stmt.name} already exists`)
		}
		const table = this.#table(stmt.table)
		const index = {
			name: stmt.name,
			sql: stmt.text,
			columns: stmt.columns.map(c => this.#column(table, c)),
			entries: new Map()
		}
		for (const [rowKey, row] of table.rows) this.#addEntry(index, rowKey, row)
		table.indexes.push(index)
		this.#indexes.set(key, index)
		this.#undo.push(() => {
			table.indexes.splice(table.indexes.indexOf(index), 1)
			this.#indexes.delete(key)
		})
		return { changes: 1, rows: [] }
	}

	#insert(stmt, params) {
		const table = this.#table(stmt.table)
		const names = stmt.columns ?? table.columns.map(c => c.name)
		if (names.length !== stmt.values.length) throw new SqlError(`${names.length} columns but ${stmt.values.length} values supplied`)
		if (stmt.onConflict && !this.#isPrimaryKey(table, stmt.onConflict.target)) throw new SqlError('ON CONFLICT target must be the primary key')
		const row = table.columns.map(() => null)
		names.forEach((name, i) => {
			row[this.#column(table, name)] = this.#value(stmt.values[i], params)
		})
		this.#checkNotNull(table, row)
		const rowKey = keyOf(table, row)
		const existing = table.rows.get(rowKey)
		if (!existing) {
			this.#storeRow(table, rowKey, row)
			return { changes: 1, rows: [] }
		}
		const action = stmt.onConflict?.action
		if (action === 'nothing') return { changes: 0, rows: [] }
		if (action === 'update') return this.#upsertConflict(table, rowKey, existing, stmt.onConflict.sets, row, params)
		if (stmt.replace) {
			if (sameRow(existing, row)) return { changes: 1, rows: [], noop: true }
			this.#storeRow(table, rowKey, row)
			return { changes: 1, rows: [] }
		}
		throw new SqlError(`UNIQUE constraint failed: ${table.pk.map(i => `${table.name}.${table.columns[i].name}`).join(', ')}`)
	}

	#upsertConflict(table, rowKey, existing, sets, incoming, params) {
		const next = existing.slice()
		for (const { column, operand } of sets) {
			next[this.#column(table, column)] = operand.kind === 'excluded'
				? incoming[this.#column(table, operand.column)]
				: this.#value(operand, params)
		}
		if (table.pk.some(i => next[i] !== existing[i])) throw new SqlError('primary key cannot be changed on conflict')
		this.#checkNotNull(table, next)
		// rewriting identical data (e.g. saveCreds with unchanged creds) must not grow the log
		if (sameRow(existing, next)) return { changes: 1, rows: [], noop: true }
		this.#storeRow(table, rowKey, next)
		return { changes: 1, rows: [] }
	}

	#deleteRows(stmt, params) {
		const table = this.#table(stmt.table)
		let changes = 0
		for (const row of this.#match(table, stmt.where, params)) {
			if (this.#removeRow(table, keyOf(table, row))) changes++
		}
		return { changes, rows: [] }
	}

	#selectRows(stmt, params) {
		const table = this.#table(stmt.table)
		const names = stmt.columns === '*' ? table.columns.map(c => c.name) : stmt.columns
		const picks = names.map(n => this.#column(table, n))
		const rows = this.#match(table, stmt.where, params).map(row => Object.fromEntries(names.map((n, i) => [n, row[picks[i]]])))
		return { changes: 0, rows }
	}

	#match(table, where, params) {
		const bound = where.map(({ column, operand }) => ({ index: this.#column(table, column), value: this.#value(operand, params) }))
		const wanted = new Map(bound.map(({ index, value }) => [index, value]))
		return this.#candidates(table, wanted).filter(row => bound.every(({ index, value }) => value !== null && row[index] === value))
	}

	#candidates(table, wanted) {
		if (table.pk.every(i => wanted.has(i))) {
			const row = table.rows.get(JSON.stringify(table.pk.map(i => wanted.get(i))))
			return row ? [row] : []
		}
		for (const index of table.indexes) {
			if (index.columns.every(i => wanted.has(i))) {
				const keys = index.entries.get(JSON.stringify(index.columns.map(i => wanted.get(i))))
				return keys ? [...keys].map(k => table.rows.get(k)) : []
			}
		}
		return [...table.rows.values()]
	}

	#addEntry(index, rowKey, row) {
		const k = JSON.stringify(index.columns.map(i => row[i]))
		let set = index.entries.get(k)
		if (!set) {
			set = new Set()
			index.entries.set(k, set)
		}
		set.add(rowKey)
	}

	#removeEntry(index, rowKey, row) {
		const k = JSON.stringify(index.columns.map(i => row[i]))
		const set = index.entries.get(k)
		if (!set) return
		set.delete(rowKey)
		if (!set.size) index.entries.delete(k)
	}

	#indexRow(table, rowKey, row) {
		for (const index of table.indexes) this.#addEntry(index, rowKey, row)
	}

	#unindexRow(table, rowKey, row) {
		for (const index of table.indexes) this.#removeEntry(index, rowKey, row)
	}

	#storeRow(table, rowKey, row) {
		const prev = table.rows.get(rowKey)
		if (prev) this.#unindexRow(table, rowKey, prev)
		table.rows.set(rowKey, row)
		this.#indexRow(table, rowKey, row)
		this.#undo.push(() => this.#restoreRow(table, rowKey, prev))
	}

	#removeRow(table, rowKey) {
		const prev = table.rows.get(rowKey)
		if (!prev) return false
		this.#unindexRow(table, rowKey, prev)
		table.rows.delete(rowKey)
		this.#undo.push(() => this.#restoreRow(table, rowKey, prev))
		return true
	}

	#restoreRow(table, rowKey, prev) {
		const current = table.rows.get(rowKey)
		if (current) this.#unindexRow(table, rowKey, current)
		if (prev) {
			table.rows.set(rowKey, prev)
			this.#indexRow(table, rowKey, prev)
		} else {
			table.rows.delete(rowKey)
		}
	}

	#open(path) {
		let text = existsSync(path) ? readFileSync(path, 'utf8') : ''
		const fresh = text === ''
		if (fresh) text = `${MAGIC}\n`
		const lines = text.split('\n')
		const tail = lines.pop()
		if (lines[0] !== MAGIC) throw new SqlError(`${path} is not a native sql database file`)
		for (const line of lines.slice(1)) this.#replay(line)
		this.#path = path
		this.#logBytes = this.#baseBytes = Buffer.byteLength(text)
		if (fresh) {
			writeFileSync(path, text)
		} else if (tail !== '' || lines.length > 2) {
			// torn write, or the log holds more than a single snapshot line: rewrite as a clean
			// snapshot so baseBytes reflects live data and old bloated files shrink on first open
			this.#compact()
		}
	}

	#replay(line) {
		if (line === '') return
		let entries
		try {
			entries = JSON.parse(line)
		} catch {
			throw new SqlError('corrupted sql log entry')
		}
		for (const [sql, params] of entries) {
			const [stmt] = parseStatements(sql)
			this.#invoke(stmt, params)
		}
	}

	#append(entries) {
		const line = `${JSON.stringify(entries)}\n`
		appendFileSync(this.#path, line)
		this.#logBytes += Buffer.byteLength(line)
	}

	#maybeCompact() {
		if (this.#path === null) return
		// baseBytes is always the size of a clean snapshot, so garbage = logBytes - baseBytes
		const garbage = this.#logBytes - this.#baseBytes
		if (garbage < Math.max(COMPACT_MIN_BYTES, this.#baseBytes * COMPACT_GROWTH_RATIO)) return
		try {
			this.#compact()
		} catch {}
	}

	#compact() {
		const entries = []
		for (const table of this.#tables.values()) entries.push([table.sql, []])
		for (const index of this.#indexes.values()) entries.push([index.sql, []])
		for (const table of this.#tables.values()) {
			const names = table.columns.map(c => `"${c.name}"`).join(', ')
			const sql = `INSERT INTO "${table.name}" (${names}) VALUES (${table.columns.map(() => '?').join(', ')})`
			for (const row of table.rows.values()) entries.push([sql, row])
		}
		const text = `${MAGIC}\n${JSON.stringify(entries)}\n`
		const tmp = `${this.#path}.tmp`
		writeFileSync(tmp, text)
		renameSync(tmp, this.#path)
		this.#logBytes = this.#baseBytes = Buffer.byteLength(text)
	}
}

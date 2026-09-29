const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

function serializeError(err) {
	if (!(err instanceof Error)) return err
	return { type: err.name, message: err.message, stack: err.stack, ...err }
}

function createLogger(bindings = {}, level = 'info') {
	const state = { level }

	function write(levelName, args) {
		if (LEVELS[levelName] < LEVELS[state.level]) return

		let obj = {}
		let msg = ''
		if (args.length && typeof args[0] === 'object' && args[0] !== null) {
			obj = args[0]
			msg = args[1] ?? ''
		} else {
			msg = args[0] ?? ''
		}
		if (obj.err) obj = { ...obj, err: serializeError(obj.err) }

		const line = {
			level: LEVELS[levelName],
			time: Date.now(),
			...bindings,
			...obj,
			msg
		}

		const out = levelName === 'error' || levelName === 'fatal' ? process.stderr : process.stdout
		out.write(JSON.stringify(line) + '\n')
	}

	const logger = {
		get level() {
			return state.level
		},
		set level(v) {
			state.level = v
		},
		trace: (...a) => write('trace', a),
		debug: (...a) => write('debug', a),
		info: (...a) => write('info', a),
		warn: (...a) => write('warn', a),
		error: (...a) => write('error', a),
		fatal: (...a) => write('fatal', a),
		child(childBindings = {}) {
			return createLogger({ ...bindings, ...childBindings }, state.level)
		}
	}

	return logger
}

export default createLogger()
export { createLogger }

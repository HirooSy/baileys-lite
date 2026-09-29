const STATUS_TEXT = {
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	408: 'Request Time-out',
	409: 'Conflict',
	411: 'Length Required',
	428: 'Precondition Required',
	440: 'Login Timeout',
	500: 'Internal Server Error',
	501: 'Not Implemented',
	503: 'Service Unavailable',
	515: 'Stream Error Code'
}

export class Boom extends Error {
	constructor(message, options = {}) {
		super(message || STATUS_TEXT[options.statusCode || 500] || 'Internal Server Error')
		this.name = 'Boom'
		Error.captureStackTrace?.(this, Boom)

		const statusCode = options.statusCode || 500
		this.isBoom = true
		this.isServer = statusCode >= 500
		this.data = options.data ?? null
		this.output = {
			statusCode,
			payload: {
				statusCode,
				error: STATUS_TEXT[statusCode] || 'Error',
				message: this.message
			},
			headers: {}
		}
	}
}

export const isBoom = err => err instanceof Error && !!err.isBoom

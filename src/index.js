import { DEFAULT_CONNECTION_CONFIG } from './defaults.js'
import { makeCommunitiesSocket } from './socket/business-communities.js'

const makeWASocket = config => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config,

		logger: config?.logger ?? DEFAULT_CONNECTION_CONFIG.logger
	}
	return makeCommunitiesSocket(newConfig)
}

export * from '../WAProto/index.js'

export * from './constants.js'

export * from './defaults.js'

export * from './binary/wa-binary.js'

export * from './wam/wam.js'
export * from './wam/wam-constants.js'

export * from './socket/usync.js'

export * from './foundation/ai-rich.js'
export * from './foundation/qrcode-terminal.js'
export * from './utils/wa-protocol-core.js'
export * from './utils/auth-state-core.js'
export * from './utils/auth-state-storage.js'
export * from './utils/media.js'
export * from './utils/message-compose.js'
export * from './utils/chat-sync.js'
export * from './utils/message-processing.js'

export { makeWASocket }
export default makeWASocket

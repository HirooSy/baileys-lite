/**
 * baileys-lite entry point. Mirrors the original lib/index.js export surface
 * (Socket/index.js + the Utils/Types/Defaults/WABinary/WAM/WAUSync barrels),
 * pointing at the consolidated files.
 */
import { DEFAULT_CONNECTION_CONFIG } from './defaults.js'
import { makeCommunitiesSocket } from './socket/business-communities.js'

// export the last socket layer (Socket/index.js in the original)
const makeWASocket = config => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config,
		// object spread does NOT skip explicit `undefined`/`null` values, so a
		// caller passing `logger: undefined` (e.g. a stale/missing logger ref
		// on reconnect) would silently wipe out DEFAULT_CONNECTION_CONFIG's
		// logger and crash later in makeNoiseHandler's `logger.child(...)`.
		// Guard against that here, once, at the single entry point.
		logger: config?.logger ?? DEFAULT_CONNECTION_CONFIG.logger
	}
	return makeCommunitiesSocket(newConfig)
}

// protobuf (was ../WAProto/index.js)
export * from '../WAProto/index.js'

// was Types/
export * from './constants.js'
// was Defaults/
export * from './defaults.js'
// was WABinary/
export * from './binary/wa-binary.js'
// was WAM/
export * from './wam/wam.js'
export * from './wam/wam-constants.js'
// was WAUSync/
export * from './socket/usync.js'
// was Utils/
export * from './foundation/ai-rich.js'
export * from './utils/wa-protocol-core.js'
export * from './utils/auth-state-core.js'
export * from './utils/auth-state-storage.js'
export * from './utils/media.js'
export * from './utils/message-compose.js'
export * from './utils/chat-sync.js'
export * from './utils/message-processing.js'

export { makeWASocket }
export default makeWASocket

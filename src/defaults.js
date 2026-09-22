/**
 * Default connection configuration and misc protocol-level constants.
 * Combines what used to be Defaults/index.js.
 */
import { proto } from '../WAProto/index.js'
import { makeLibSignalRepository } from './signal/signal-repository.js'
import { Browsers, KEY_BUNDLE_TYPE } from './utils/wa-protocol-core.js'
import { createLogger } from './foundation/logger.js'

const logger = createLogger()

const version = [2, 3000, 1047970367]

export const UNAUTHORIZED_CODES = [401, 403, 419]
export const BIZ_BOT_SUPPORT_PAYLOAD =
	'{"version":1,"is_ai_message":true,"should_upload_client_logs":false,"should_show_system_message":false,"ticket_id":"7004947587700716","citation_items":[],"ticket_locale":"us"}'
export const DEFAULT_ORIGIN = 'https://web.whatsapp.com'
export const CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
export const CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'
export const LIBRARY_NAME = 'Baileys'
export const DEF_CALLBACK_PREFIX = 'CB:'
export const DEF_TAG_PREFIX = 'TAG:'
export const PHONE_CONNECTION_CB = 'CB:Pong'
export const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
export const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])
export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60
export const STATUS_EXPIRY_SECONDS = 24 * 60 * 60
export const PLACEHOLDER_MAX_AGE_SECONDS = 14 * 24 * 60 * 60
export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
export const DICT_VERSION = 3
// single source of truth lives in utils/wa-protocol-core.js (avoids an ambiguous duplicate under `export *`)
export { KEY_BUNDLE_TYPE }
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION])

export const WA_CERT_DETAILS = {
	SERIAL: 0,
	ISSUER: 'WhatsAppLongTerm1',
	PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
}

export const PROCESSABLE_HISTORY_TYPES = [
	proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
	proto.HistorySync.HistorySyncType.PUSH_NAME,
	proto.HistorySync.HistorySyncType.RECENT,
	proto.HistorySync.HistorySyncType.FULL,
	proto.HistorySync.HistorySyncType.ON_DEMAND,
	proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
	proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
]

export const DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60,
	MSG_RETRY: 60 * 60,
	CALL_OFFER: 5 * 60,
	USER_DEVICES: 5 * 60
}

export const DEFAULT_CONNECTION_CONFIG = {
	version,
	browser: Browsers.macOS('Chrome'),
	waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
	connectTimeoutMs: 20000,
	keepAliveIntervalMs: 30000,
	logger: logger.child({ class: 'baileys' }),
	emitOwnEvents: true,
	defaultQueryTimeoutMs: 60000,
	customUploadHosts: [],
	retryRequestDelayMs: 250,
	maxMsgRetryCount: 5,
	fireInitQueries: true,
	auth: undefined,
	markOnlineOnConnect: true,
	syncFullHistory: true,
	patchMessageBeforeSending: msg => msg,
	shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.HistorySync.HistorySyncType.FULL,
	shouldIgnoreJid: () => false,
	linkPreviewImageThumbnailWidth: 192,
	transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
	generateHighQualityLinkPreview: false,
	enableAutoSessionRecreation: true,
	enableRecentMessageCache: true,
	options: {},
	appStateMacVerification: { patch: false, snapshot: false },
	countryCode: 'US',
	getMessage: async () => undefined,
	cachedGroupMetadata: async () => undefined,
	makeSignalRepository: makeLibSignalRepository
}

export const HISTORY_SYNC_PAUSED_TIMEOUT_MS = 120000
export const MIN_PREKEY_COUNT = 5
export const INITIAL_PREKEY_COUNT = 812
export const UPLOAD_TIMEOUT = 30000

export const TimeMs = {
	Minute: 60 * 1000,
	Hour: 60 * 60 * 1000,
	Day: 24 * 60 * 60 * 1000,
	Week: 7 * 24 * 60 * 60 * 1000
}

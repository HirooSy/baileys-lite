import { proto } from '../WAProto/index.js'

export { proto as WAProto }

export const ALL_WA_PATCH_NAMES = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular']

export const AssociationType = proto.MessageAssociation.AssociationType
export const ButtonHeaderType = proto.Message.ButtonsMessage.HeaderType
export const ButtonType = proto.Message.ButtonsMessage.Button.Type
export const CarouselCardType = proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType
export const ListType = proto.Message.ListMessage.ListType
export const ProtocolType = proto.Message.ProtocolMessage.Type
export const WAMessageStubType = proto.WebMessageInfo.StubType
export const WAMessageStatus = proto.WebMessageInfo.Status

export const WAMessageAddressingMode = { PN: 'pn', LID: 'lid' }

export const LabelColor = Object.freeze(
	Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Color${i + 1}`, i]))
)

export const LabelAssociationType = { Chat: 'label_jid', Message: 'label_message' }

export const XWAPaths = {
	xwa2_newsletter_create: 'xwa2_newsletter_create',
	xwa2_newsletter_followers: 'xwa2_newsletter_followers',
	xwa2_newsletter_admin_insights: 'xwa2_newsletter_admin_insights',
	xwa2_newsletter_subscribed: 'xwa2_newsletter_subscribed',
	xwa2_newsletter_view: 'xwa2_newsletter_view',
	xwa2_newsletter_metadata: 'xwa2_newsletter',
	xwa2_newsletter_admin_count: 'xwa2_newsletter_admin',
	xwa2_newsletter_mute_v2: 'xwa2_newsletter_mute_v2',
	xwa2_newsletter_unmute_v2: 'xwa2_newsletter_unmute_v2',
	xwa2_newsletter_follow: 'xwa2_newsletter_follow',
	xwa2_newsletter_unfollow: 'xwa2_newsletter_unfollow',
	xwa2_newsletter_join_v2: 'xwa2_newsletter_join_v2',
	xwa2_newsletter_leave_v2: 'xwa2_newsletter_leave_v2',
	xwa2_newsletter_change_owner: 'xwa2_newsletter_change_owner',
	xwa2_newsletter_demote: 'xwa2_newsletter_demote',
	xwa2_newsletter_delete_v2: 'xwa2_newsletter_delete_v2',
	xwa2_fetch_account_reachout_timelock: 'xwa2_fetch_account_reachout_timelock',
	xwa2_message_capping_info: 'xwa2_message_capping_info'
}

export const QueryIds = {
	CREATE: '8823471724422422',
	UPDATE_METADATA: '24250201037901610',
	METADATA: '6563316087068696',
	PENDING_ADMIN_INVITES: '9783111038412085',
	FOLLOWERS: '27472091235714801',
	INSIGHTS: '9853618868050977',
	ADMIN_INFO: '26278439461859188',
	SUBSCRIBED: '6388546374527196',
	FOLLOW: '24404358912487870',
	UNFOLLOW: '9767147403369991',
	MUTE: '29766401636284406',
	UNMUTE: '9864994326891137',
	ADMIN_COUNT: '7130823597031706',
	CHANGE_OWNER: '7341777602580933',
	DEMOTE: '6551828931592903',
	DELETE: '30062808666639665',
	REACHOUT_TIMELOCK: '23983697327930364',
	MESSAGE_CAPPING_INFO: '24503548349331633'
}

export const CodeHighlightType = { DEFAULT: 0, KEYWORD: 1, METHOD: 2, STRING: 3, NUMBER: 4, COMMENT: 5 }

export const RichSubMessageType = {
	UNKNOWN: 0,
	GRID_IMAGE: 1,
	TEXT: 2,
	INLINE_IMAGE: 3,
	TABLE: 4,
	CODE: 5,
	DYNAMIC: 6,
	MAP: 7,
	LATEX: 8,
	CONTENT_ITEMS: 9
}

export const SyncState = { Connecting: 0, AwaitingInitialSync: 1, Syncing: 2, Online: 3 }

export const ReachoutTimelockEnforcementType = {
	BIZ_COMMERCE_VIOLATION_ALCOHOL: 'BIZ_COMMERCE_VIOLATION_ALCOHOL',
	BIZ_COMMERCE_VIOLATION_ADULT: 'BIZ_COMMERCE_VIOLATION_ADULT',
	BIZ_COMMERCE_VIOLATION_ANIMALS: 'BIZ_COMMERCE_VIOLATION_ANIMALS',
	BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS: 'BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS',
	BIZ_COMMERCE_VIOLATION_DATING: 'BIZ_COMMERCE_VIOLATION_DATING',
	BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS: 'BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS',
	BIZ_COMMERCE_VIOLATION_DRUGS: 'BIZ_COMMERCE_VIOLATION_DRUGS',
	BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC: 'BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC',
	BIZ_COMMERCE_VIOLATION_GAMBLING: 'BIZ_COMMERCE_VIOLATION_GAMBLING',
	BIZ_COMMERCE_VIOLATION_HEALTHCARE: 'BIZ_COMMERCE_VIOLATION_HEALTHCARE',
	BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY: 'BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY',
	BIZ_COMMERCE_VIOLATION_SUPPLEMENTS: 'BIZ_COMMERCE_VIOLATION_SUPPLEMENTS',
	BIZ_COMMERCE_VIOLATION_TOBACCO: 'BIZ_COMMERCE_VIOLATION_TOBACCO',
	BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT: 'BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT',
	BIZ_COMMERCE_VIOLATION_WEAPONS: 'BIZ_COMMERCE_VIOLATION_WEAPONS',
	BIZ_QUALITY: 'BIZ_QUALITY',

	DEFAULT: 'DEFAULT',
	WEB_COMPANION_ONLY: 'WEB_COMPANION_ONLY'
}

export const NewChatMessageCappingStatusType = { NONE: 'NONE', FIRST_WARNING: 'FIRST_WARNING', SECOND_WARNING: 'SECOND_WARNING', CAPPED: 'CAPPED' }

export const NewChatMessageCappingMVStatusType = {
	NOT_ELIGIBLE: 'NOT_ELIGIBLE',
	NOT_ACTIVE: 'NOT_ACTIVE',
	ACTIVE: 'ACTIVE',
	ACTIVE_UPGRADE_AVAILABLE: 'ACTIVE_UPGRADE_AVAILABLE'
}

export const NewChatMessageCappingOTEStatusType = {
	NOT_ELIGIBLE: 'NOT_ELIGIBLE',
	ELIGIBLE: 'ELIGIBLE',
	ACTIVE_IN_CURRENT_CYCLE: 'ACTIVE_IN_CURRENT_CYCLE',
	EXHAUSTED: 'EXHAUSTED'
}

export const DisconnectReason = {}
for (const [name, code] of [
	['connectionClosed', 428],
	['connectionLost', 408],
	['connectionReplaced', 440],
	['timedOut', 408],
	['loggedOut', 401],
	['badSession', 500],
	['restartRequired', 515],
	['multideviceMismatch', 411],
	['forbidden', 403],
	['unavailableService', 503]
]) {
	DisconnectReason[(DisconnectReason[name] = code)] = name
}

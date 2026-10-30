import $protobuf from "../src/foundation/protobuf-minimal.js";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";

const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

function longToString(value, unsigned) {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		return String(value);
	}

	if (value && typeof value.low === "number" && typeof value.high === "number") {
		const lo = BigInt(value.low >>> 0);
		const hi = BigInt(value.high >>> 0);
		const combined = (hi << 32n) | lo;
		if (!unsigned && value.high < 0) {
			return (combined - (1n << 64n)).toString();
		}
		return combined.toString();
	}
	return String(value);
}

function longToNumber(value, unsigned) {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		return Number(value);
	}

	if (value && typeof value.low === "number" && typeof value.high === "number") {
		const lo = BigInt(value.low >>> 0);
		const hi = BigInt(value.high >>> 0);
		const combined = (hi << 32n) | lo;
		if (!unsigned && value.high < 0) {
			return Number(combined - (1n << 64n));
		}
		return Number(combined);
	}
	return Number(value);
}

const $lazy = (target, name, factory) => {
	const define = value => Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: true });
	Object.defineProperty(target, name, {
		configurable: true,
		enumerable: true,
		get() {
			const value = factory();
			define(value);
			return value;
		},
		set(value) {
			define(value);
		}
	});
};

const $partsDir = new URL("./parts/", import.meta.url);
const $partParams = ["$protobuf", "$Reader", "$Writer", "$util", "$root", "$lazy", "proto", "longToString", "longToNumber"];
const $lazyPart = name => $lazy(proto, name, () => compileFunction(readFileSync(new URL(name + ".part", $partsDir), "utf8"), $partParams)($protobuf, $Reader, $Writer, $util, $root, $lazy, proto, longToString, longToNumber));

export const proto = $root.proto = {};

$lazyPart("ADVDeviceIdentity");
$lazyPart("ADVEncryptionType");
$lazyPart("ADVKeyIndexList");
$lazyPart("ADVSignedDeviceIdentity");
$lazyPart("ADVSignedDeviceIdentityHMAC");
$lazyPart("ADVSignedKeyIndexList");
$lazyPart("AIHomeState");
$lazyPart("AIMediaCollectionMessage");
$lazyPart("AIMediaCollectionMetadata");
$lazyPart("AIMetadataOperation");
$lazyPart("AIQueryFanout");
$lazyPart("AIRegenerateMetadata");
$lazyPart("AIRichResponseCodeMetadata");
$lazyPart("AIRichResponseContentItemsMetadata");
$lazyPart("AIRichResponseDynamicMetadata");
$lazyPart("AIRichResponseGridImageMetadata");
$lazyPart("AIRichResponseImageURL");
$lazyPart("AIRichResponseInlineImageMetadata");
$lazyPart("AIRichResponseLatexMetadata");
$lazyPart("AIRichResponseMapMetadata");
$lazyPart("AIRichResponseMessage");
$lazyPart("AIRichResponseMessageType");
$lazyPart("AIRichResponseSubMessage");
$lazyPart("AIRichResponseSubMessageType");
$lazyPart("AIRichResponseTableMetadata");
$lazyPart("AIRichResponseUnifiedResponse");
$lazyPart("AISubscriptionRequestType");
$lazyPart("AISubscriptionUpsellMetadata");
$lazyPart("AIThreadInfo");
$lazyPart("Account");
$lazyPart("ActionLink");
$lazyPart("AutoDownloadSettings");
$lazyPart("AvatarUserSettings");
$lazyPart("BizAccountLinkInfo");
$lazyPart("BizAccountPayload");
$lazyPart("BizIdentityInfo");
$lazyPart("BotAgeCollectionMetadata");
$lazyPart("BotAgentDeepLinkMetadata");
$lazyPart("BotAgentMetadata");
$lazyPart("BotCapabilityMetadata");
$lazyPart("BotCommandMetadata");
$lazyPart("BotDocumentMessageMetadata");
$lazyPart("BotFeedbackMessage");
$lazyPart("BotGroupMetadata");
$lazyPart("BotGroupParticipantMetadata");
$lazyPart("BotImagineMetadata");
$lazyPart("BotInfrastructureDiagnostics");
$lazyPart("BotLinkedAccount");
$lazyPart("BotLinkedAccountsMetadata");
$lazyPart("BotMediaMetadata");
$lazyPart("BotMemoryFact");
$lazyPart("BotMemoryMetadata");
$lazyPart("BotMemuMetadata");
$lazyPart("BotMessageOrigin");
$lazyPart("BotMessageOriginMetadata");
$lazyPart("BotMessageSharingInfo");
$lazyPart("BotMetadata");
$lazyPart("BotMetricsEntryPoint");
$lazyPart("BotMetricsMetadata");
$lazyPart("BotMetricsThreadEntryPoint");
$lazyPart("BotModeSelectionMetadata");
$lazyPart("BotModelMetadata");
$lazyPart("BotPluginMetadata");
$lazyPart("BotProgressIndicatorMetadata");
$lazyPart("BotPromotionMessageMetadata");
$lazyPart("BotPromptSuggestion");
$lazyPart("BotPromptSuggestions");
$lazyPart("BotPttPromptMetadata");
$lazyPart("BotQuotaMetadata");
$lazyPart("BotReminderMetadata");
$lazyPart("BotRenderingConfigMetadata");
$lazyPart("BotRenderingMetadata");
$lazyPart("BotResolvedToolCallMetadata");
$lazyPart("BotSessionMetadata");
$lazyPart("BotSessionSource");
$lazyPart("BotSignatureVerificationMetadata");
$lazyPart("BotSignatureVerificationUseCaseProof");
$lazyPart("BotSourcesMetadata");
$lazyPart("BotSuggestedPromptMetadata");
$lazyPart("BotUnifiedResponseMutation");
$lazyPart("CallLogRecord");
$lazyPart("CertChain");
$lazyPart("ChatLockSettings");
$lazyPart("ChatRowOpaqueData");
$lazyPart("Citation");
$lazyPart("ClientPairingProps");
$lazyPart("ClientPayload");
$lazyPart("CollectionName");
$lazyPart("CommentMetadata");
$lazyPart("CompanionCommitment");
$lazyPart("CompanionEphemeralIdentity");
$lazyPart("Config");
$lazyPart("ContextInfo");
$lazyPart("Conversation");
$lazyPart("DeviceCapabilities");
$lazyPart("DeviceConsistencyCodeMessage");
$lazyPart("DeviceListMetadata");
$lazyPart("DeviceProps");
$lazyPart("DisappearingMode");
$lazyPart("EmbeddedContent");
$lazyPart("EmbeddedMessage");
$lazyPart("EmbeddedMusic");
$lazyPart("EncryptedPairingRequest");
$lazyPart("EphemeralSetting");
$lazyPart("EventAdditionalMetadata");
$lazyPart("EventResponse");
$lazyPart("ExitCode");
$lazyPart("ExternalBlobReference");
$lazyPart("Field");
$lazyPart("ForwardedAIBotMessageInfo");
$lazyPart("GlobalSettings");
$lazyPart("GroupHistoryBundleInfo");
$lazyPart("GroupHistoryIndividualMessageInfo");
$lazyPart("GroupMention");
$lazyPart("GroupParticipant");
$lazyPart("GroupRootKeyShare");
$lazyPart("GroupRootKeyShareEntry");
$lazyPart("HandshakeMessage");
$lazyPart("HatchMetadataSync");
$lazyPart("HistorySync");
$lazyPart("HistorySyncMsg");
$lazyPart("HydratedTemplateButton");
$lazyPart("IdentityKeyPairStructure");
$lazyPart("InThreadSurveyMetadata");
$lazyPart("InlineContact");
$lazyPart("InteractiveAnnotation");
$lazyPart("InteractiveMessageAdditionalMetadata");
$lazyPart("KeepInChat");
$lazyPart("KeepType");
$lazyPart("KeyExchangeMessage");
$lazyPart("KeyId");
$lazyPart("LIDMigrationMapping");
$lazyPart("LIDMigrationMappingSyncMessage");
$lazyPart("LIDMigrationMappingSyncPayload");
$lazyPart("LegacyMessage");
$lazyPart("LimitSharing");
$lazyPart("LocalizedName");
$lazyPart("Location");
$lazyPart("MediaData");
$lazyPart("MediaDomainInfo");
$lazyPart("MediaKeyDomain");
$lazyPart("MediaNotifyMessage");
$lazyPart("MediaRetryNotification");
$lazyPart("MediaVisibility");
$lazyPart("MemberLabel");
$lazyPart("Message");
$lazyPart("MessageAddOn");
$lazyPart("MessageAddOnContextInfo");
$lazyPart("MessageAssociation");
$lazyPart("MessageContextInfo");
$lazyPart("MessageKey");
$lazyPart("MessageSecretMessage");
$lazyPart("Money");
$lazyPart("MsgOpaqueData");
$lazyPart("MsgRowOpaqueData");
$lazyPart("MutationProps");
$lazyPart("NoiseCertificate");
$lazyPart("NotificationMessageInfo");
$lazyPart("NotificationSettings");
$lazyPart("PairingRequest");
$lazyPart("PastParticipant");
$lazyPart("PastParticipants");
$lazyPart("PatchDebugData");
$lazyPart("PaymentBackground");
$lazyPart("PaymentInfo");
$lazyPart("PhoneNumberToLIDMapping");
$lazyPart("PhotoChange");
$lazyPart("PinInChat");
$lazyPart("Point");
$lazyPart("PollAdditionalMetadata");
$lazyPart("PollEncValue");
$lazyPart("PollUpdate");
$lazyPart("PreKeyRecordStructure");
$lazyPart("PreKeySignalMessage");
$lazyPart("PremiumMessageInfo");
$lazyPart("PrimaryEphemeralIdentity");
$lazyPart("PrivacySystemMessage");
$lazyPart("ProcessedVideo");
$lazyPart("ProloguePayload");
$lazyPart("Pushname");
$lazyPart("QuarantinedMessage");
$lazyPart("Reaction");
$lazyPart("RecentEmojiWeight");
$lazyPart("RecordStructure");
$lazyPart("Reportable");
$lazyPart("ReportingTokenInfo");
$lazyPart("ScheduledMessageMetadata");
$lazyPart("SenderKeyDistributionMessage");
$lazyPart("SenderKeyMessage");
$lazyPart("SenderKeyRecordStructure");
$lazyPart("SenderKeyStateStructure");
$lazyPart("ServerErrorReceipt");
$lazyPart("SessionStructure");
$lazyPart("SessionTransparencyMetadata");
$lazyPart("SessionTransparencyType");
$lazyPart("SignalMessage");
$lazyPart("SignedPreKeyRecordStructure");
$lazyPart("StatusAttribution");
$lazyPart("StatusMentionMessage");
$lazyPart("StatusPSA");
$lazyPart("StickerMetadata");
$lazyPart("SyncActionData");
$lazyPart("SyncActionValue");
$lazyPart("SyncdIndex");
$lazyPart("SyncdMutation");
$lazyPart("SyncdMutations");
$lazyPart("SyncdPatch");
$lazyPart("SyncdRecord");
$lazyPart("SyncdSnapshot");
$lazyPart("SyncdValue");
$lazyPart("SyncdVersion");
$lazyPart("TapLinkAction");
$lazyPart("TemplateButton");
$lazyPart("ThreadID");
$lazyPart("UrlTrackingMap");
$lazyPart("UserPassword");
$lazyPart("UserReceipt");
$lazyPart("VerifiedNameCertificate");
$lazyPart("WallpaperSettings");
$lazyPart("WebFeatures");
$lazyPart("WebLinkRenderConfig");
$lazyPart("WebMessageInfo");
$lazyPart("WebNotificationsInfo");

export { $root as default };

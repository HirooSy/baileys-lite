export var CallState;
(function (CallState) {
    CallState["Initiating"] = "initiating";
    CallState["Ringing"] = "ringing";
    CallState["IncomingRinging"] = "incoming_ringing";
    CallState["Connecting"] = "connecting";
    CallState["Active"] = "active";
    CallState["OnHold"] = "on_hold";
    CallState["Ended"] = "ended";
})(CallState || (CallState = {}));
export var CallDirection;
(function (CallDirection) {
    CallDirection["Outgoing"] = "outgoing";
    CallDirection["Incoming"] = "incoming";
})(CallDirection || (CallDirection = {}));
export var CallMediaType;
(function (CallMediaType) {
    CallMediaType["Audio"] = "audio";
    CallMediaType["Video"] = "video";
})(CallMediaType || (CallMediaType = {}));
export var EndCallReason;
(function (EndCallReason) {
    EndCallReason["UserEnded"] = "user_ended";
    EndCallReason["Declined"] = "declined";
    EndCallReason["Timeout"] = "timeout";
    EndCallReason["Busy"] = "busy";
    EndCallReason["Cancelled"] = "cancelled";
    EndCallReason["Failed"] = "failed";
    /** The call had a media path and lost it, with no leg left to carry it. */
    EndCallReason["RelayLost"] = "relay_lost";
    EndCallReason["DoNotDisturb"] = "do_not_disturb";
    EndCallReason["Unknown"] = "unknown";
})(EndCallReason || (EndCallReason = {}));
export var PayloadType;
(function (PayloadType) {
    PayloadType[PayloadType["WhatsAppOpus"] = 120] = "WhatsAppOpus";
    PayloadType[PayloadType["WhatsAppH264"] = 97] = "WhatsAppH264";
    /**
     * Lowest payload type of WhatsApp's proprietary Reed-Solomon video FEC
     * family, which the client emits as `103 + 3k`. Not an RTX stream: the
     * payload is opaque parity, with no prefix and no original sequence number,
     * and it travels on the FEC stream's own SSRC.
     */
    PayloadType[PayloadType["WhatsAppVideoFec"] = 103] = "WhatsAppVideoFec";
})(PayloadType || (PayloadType = {}));
export const DEFAULT_AUDIO_CONFIG = {
    sampleRate: 16000,
    captureChunkSize: 960,
    playbackOutputSize: 960,
    maxBufferSize: 11520,
    intervalMs: 60
};
export const SRTP_SEND_AUTH_TAG_LEN = 4;
export const SRTP_RECV_AUTH_TAG_LEN = 4;
export const SRTP_AUTH_TAG_LEN = 4;
export const SRTP_LABEL = {
    ENCRYPTION: 0x00,
    AUTH: 0x01,
    SALT: 0x02
};
export const WA_RELAY_PORT = 3480;
export const WA_DTLS_FINGERPRINT = 'sha-256 F9:CA:0C:98:A3:CC:71:D6:42:CE:5A:E2:53:D2:15:20:D3:1B:BA:D8:57:A4:F0:AF:BE:0B:FB:F3:6B:0C:A0:68';

export const DEFAULT_VIDEO_CONFIG = {
    width: 640,
    height: 360,
    frameRate: 20,
    clockRate: 90000
};

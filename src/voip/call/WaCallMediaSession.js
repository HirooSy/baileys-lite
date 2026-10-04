import { toUserJid } from '../shim/protocol.js';
import { getFirstNodeChild, getNodeChildrenByTag } from '../shim/transport.js';
import { setBoundedMapEntry, toError, uint8TimingSafeEqual } from '../shim/util.js';
import { WaAppDataStream } from '../app-data/WaAppDataStream.js';
import { concatBytes, EMPTY_BYTES, readUInt32BE, toArrayBuffer } from '../bytes.js';
import { derivePerJidSrtpKey } from '../crypto/encryption.js';
import { randomBytes } from '../crypto/primitives.js';
import { SrtcpContext, SrtcpSession, SrtpSession } from '../crypto/srtp.js';
import { generateSecureSsrc, WA_AUDIO_CALL_SSRC_SLOTS, WA_SSRC_SLOT, WA_VIDEO_CALL_SSRC_SLOTS } from '../crypto/ssrc.js';
import { WA_FAST_REMB_ELEMENT_LENGTH, writeFastRembExtension } from '../media/fast-remb.js';
import { H264Depacketizer, isH264KeyFrame, packetizeH264AnnexB } from '../media/h264.js';
import { MLowCodec } from '../media/mlow-codec.js';
import { buildFullIntraRequest, buildPictureLossIndication, buildReceiverEstimatedMaxBitrate, buildSenderReportWithSdes, nextReceiverMaxBitrate, RTCP_CNAME_LENGTH, RtpStreamReception, SenderReportSchedule } from '../media/rtcp.js';
import { RtpSession, WA_RTP_EXTENSION_PROFILE } from '../media/rtp.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { isRtcpPacket, isRtpPacket, isStunPacket } from '../relay/stun.js';
import { TRUE_WEB_CLIENT_RELAY_PORT, WaSctpRelay } from '../relay/WaSctpRelay.js';
import { buildScreenShareStanza, parseScreenShareNode, WA_SCREEN_SHARE_STATE } from '../signaling/screen-share.js';
import { buildAcceptReceiptStanza, buildAcceptStanza, buildMuteV2Stanza, buildPreacceptStanza, buildRaiseHandStanza, buildRejectStanza, buildRelaylatencyForwardStanza, buildRelayLatencyStanza, buildTerminateStanza, buildTransportStanza, buildVideoStateStanza, decryptCallKey, extractNodeInfo, extractRelayEndpoints, needsDecryption, parseMuteV2, parseRaiseHandState, parseVideoStateNode, WA_VIDEO_STATE, WA_VIDEO_UPGRADE_RESULT, WA_VIDEO_UPGRADE_TIMEOUT_MS } from '../signaling/signaling.js';
import { parseVoipSettings } from '../signaling/voip-settings.js';
import { CallDirection, CallMediaType, CallState, EndCallReason, PayloadType, SRTP_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN, SRTP_SEND_AUTH_TAG_LEN } from '../types.js';
const SENDER_REPORT_INTERVAL_MS = 1_500;
const VIDEO_ONLY_SSRC_SLOTS = WA_VIDEO_CALL_SSRC_SLOTS.filter((slot) => !WA_AUDIO_CALL_SSRC_SLOTS.includes(slot));
const AUDIO_CLOCK_RATE = 16_000;
const VIDEO_CLOCK_RATE = 90_000;
const VIDEO_TICKS_PER_FRAME = 3_000;
const INITIAL_RECEIVER_ESTIMATE = nextReceiverMaxBitrate(0, 0, 0, 0);
const VIDEO_EXTENSION_FIRST_PACKET_LENGTH = 13;
const MAX_TRACKED_RAISED_HANDS = 32;
const MAX_TRACKED_PEER_APP_DATA_SSRCS = 32;
const MAX_H264_DEPACKETIZERS = 8;
const VOIP_SETTINGS_OPTIONS_SECTION = 'options';
const VOIP_SETTINGS_SFRAME_SECTION = 'sframe';
const ENABLE_APP_DATA_STREAM_KEY = 'enable_app_data_stream';
const APP_DATA_STREAM_VERSION_KEY = 'app_data_stream_version';
const ENABLE_SFRAME_KEY = 'enable_sframe';
const ENABLE_SFRAME_RX_KEY = 'enable_sframe_rx';
const VIDEO_STATE_TXN_RECV_ENFORCE_KEY = 'video_state_txn_id_recv_enforce';
function resolveAppDataSframe(settings) {
    return (settings.getFlag(VOIP_SETTINGS_SFRAME_SECTION, ENABLE_SFRAME_KEY, false) &&
        settings.getFlag(VOIP_SETTINGS_SFRAME_SECTION, ENABLE_SFRAME_RX_KEY, false));
}
function padTo32Bits(length) {
    return (length + 3) & ~3;
}
const VIDEO_EXTENSION_SCRATCH_LENGTH = padTo32Bits(VIDEO_EXTENSION_FIRST_PACKET_LENGTH + WA_FAST_REMB_ELEMENT_LENGTH);
function buildExtensionViews(scratch) {
    const views = new Array(scratch.length / 4 + 1);
    for (let words = 0; words < views.length; words++) {
        views[words] = scratch.subarray(0, words * 4);
    }
    return views;
}
const REED_SOLOMON_FEC_PAYLOAD_BASE = 103;
const REED_SOLOMON_FEC_PAYLOAD_STRIDE = 3;
function isReedSolomonFecPayloadType(pt) {
    return (pt >= REED_SOLOMON_FEC_PAYLOAD_BASE &&
        (pt - REED_SOLOMON_FEC_PAYLOAD_BASE) % REED_SOLOMON_FEC_PAYLOAD_STRIDE === 0);
}
export class WaCallMediaSession {
    info;
    deps;
    logger;
    delegate;
    useOriginalRelayPort;
    rtpSession = null;
    videoRtpSession = null;
    srtpSession = null;
    srtcpContext = null;
    srtcpRecvSession = null;
    opusCodec = null;
    sctpRelay;
    audioEngine;
    initialTransportSent = false;
    outgoingPreacceptSent = false;
    selfSsrc = 0;
    peerSsrcs = [];
    selfStreamSsrcs = [];
    peerStreamSsrcs = [];
    appDataStream = null;
    peerAppDataSsrcs = new Set();
    appDataSframeRequired = false;
    selfDeviceJid = '';
    videoReceivePathOpened = false;
    videoSendPathOpened = false;
    initialMuteAnnounced = false;
    videoStateTransactionId = 0;
    pendingVideoUpgrade = null;
    peerVideoUpgradeRequested = false;
    peerVideoStateSeen = 0;
    firstPacketSent = false;
    acceptedByJid = null;
    debeEnabled = true;
    audioSendCount = 0;
    videoSendFrames = 0;
    videoRecvPackets = 0;
    reedSolomonFecPackets = 0;
    audioDropCount = 0;
    realAudioSendCount = 0;
    static EMPTY_BYTES = EMPTY_BYTES;
    encodeBufferA = null;
    encodeBufferB = null;
    encodeBuffer = null;
    encodeBufferPos = 0;
    authPaddingBuffer = null;
    audioRecvCount = 0;
    recvRealCount = 0;
    recvDtxCount = 0;
    subscriptionRefreshInterval = null;
    audioOctetCount = 0;
    videoPacketCount = 0;
    videoOctetCount = 0;
    videoFrameNumber = 0;
    videoTransportSequence = 0;
    videoFirSequence = 0;
    receivedVideoKeyFrame = false;
    lastVideoPliAt = 0;
    srtpErrorCount = 0;
    relayPacketCount = 0;
    stunResponseCount = 0;
    selfEchoCount = 0;
    rtcpCname = null;
    audioReception = new RtpStreamReception(AUDIO_CLOCK_RATE);
    videoReception = new RtpStreamReception(VIDEO_CLOCK_RATE);
    audioReportSchedule = SenderReportSchedule.onMediaClock(SENDER_REPORT_INTERVAL_MS, AUDIO_CLOCK_RATE);
    videoReportSchedule = SenderReportSchedule.onWallClock(SENDER_REPORT_INTERVAL_MS);
    receiverEstimateSchedule = SenderReportSchedule.onWallClock(SENDER_REPORT_INTERVAL_MS);
    rtcpIntervalMs = SENDER_REPORT_INTERVAL_MS;
    rtcpRembDisabled = false;
    videoStateTxnEnforced = false;
    videoRecvOctets = 0;
    receiverEstimateWindowStartedAt = 0;
    receiverEstimateBitrate = 0;
    videoExtensionScratch = new Uint8Array(VIDEO_EXTENSION_SCRATCH_LENGTH);
    videoExtensionViews = buildExtensionViews(this.videoExtensionScratch);
    onDecodedAudio = (pcm) => {
        this.audioEngine.onPlaybackData(pcm);
    };
    onPlaybackTick = (pcm) => {
        const samples = new Float32Array(pcm.length);
        samples.set(pcm);
        this.delegate.emitInboundAudio(this.info, samples);
    };
    actualPeerSsrc = null;
    ssrcResubscribed = false;
    h264Depacketizers = new Map();
    constructor(options) {
        this.deps = options.deps;
        this.logger = options.logger;
        this.info = options.info;
        this.delegate = options.delegate;
        this.useOriginalRelayPort = options.useOriginalRelayPort ?? false;
        this.sctpRelay = new WaSctpRelay({
            logger: this.logger.child({ component: 'sctp' }),
            useRawUdpTransport: options.useRawUdpTransport
        });
        this.audioEngine = new WaAudioEngine({
            logger: this.logger.child({ component: 'audio-engine' })
        });
        this.audioEngine.setAudioSender(this);
        this.audioEngine.setPlaybackSink(this.onPlaybackTick);
        this.audioEngine.setOnAudioFinished(() => {
            this.delegate.emitOutboundAudioFinished(this.info);
        });
        this.sctpRelay.on('relay_connected', () => {
            this.onRelayConnected();
        });
        this.sctpRelay.on('relay_lost', (event) => {
            this.onRelayLost(event.reason);
        });
        this.sctpRelay.on('relay_receive', (relayInfo) => {
            this.onRelayData(relayInfo.data);
        });
    }
    get callId() {
        return this.info.callId;
    }
    shouldIgnoreTerminate(peerJid, reason) {
        return Boolean(reason === 'accepted_elsewhere' &&
            peerJid &&
            this.acceptedByJid &&
            peerJid !== this.acceptedByJid);
    }
    async initMedia(selfLid, peerJid) {
        const selfDeviceJid = this.ensureDeviceJid(selfLid);
        const peerDeviceJid = this.ensureDeviceJid(peerJid);
        this.selfDeviceJid = selfDeviceJid;
        const relaySlots = this.info.mediaType === CallMediaType.Video
            ? WA_VIDEO_CALL_SSRC_SLOTS
            : WA_AUDIO_CALL_SSRC_SLOTS;
        this.selfStreamSsrcs = relaySlots.map((slot) => generateSecureSsrc(this.info.callId, selfDeviceJid, slot));
        this.peerStreamSsrcs = relaySlots.map((slot) => generateSecureSsrc(this.info.callId, peerDeviceJid, slot));
        if (this.info.mediaType === CallMediaType.Audio) {
            const peerBase = toUserJid(peerJid);
            const peerDevices = (this.info.relayData?.participantJids || [])
                .filter((jid) => toUserJid(jid) === peerBase)
                .map((jid) => this.ensureDeviceJid(jid));
            this.peerStreamSsrcs = Array.from(new Set([peerDeviceJid, ...peerDevices].flatMap((jid) => [
                generateSecureSsrc(this.info.callId, jid, WA_SSRC_SLOT.AUDIO.MAIN),
                generateSecureSsrc(this.info.callId, jid, WA_SSRC_SLOT.APP_DATA.MAIN)
            ])));
            this.trackPeerAppDataSsrcs([peerDeviceJid, ...peerDevices]);
        }
        else {
            this.trackPeerAppDataSsrcs([peerDeviceJid]);
        }
        this.openAppDataStream(selfDeviceJid);
        const ssrc = this.selfStreamSsrcs[0];
        this.rtpSession = RtpSession.whatsappOpus(ssrc);
        if (this.info.mediaType === CallMediaType.Video) {
            const videoSsrc = generateSecureSsrc(this.info.callId, selfDeviceJid, WA_SSRC_SLOT.VIDEO.MAIN);
            this.videoRtpSession = new RtpSession(videoSsrc, PayloadType.WhatsAppH264, VIDEO_CLOCK_RATE, VIDEO_TICKS_PER_FRAME);
        }
        this.selfSsrc = ssrc;
        const peerSsrc = this.peerStreamSsrcs[0];
        this.peerSsrcs = [peerSsrc];
        this.logger.debug('call media initialized', {
            callId: this.info.callId,
            selfSsrc: `0x${ssrc.toString(16).toUpperCase()}`,
            peerSsrc: `0x${peerSsrc.toString(16).toUpperCase()}`
        });
        this.opusCodec = await MLowCodec.create({
            logger: this.logger.child({ component: 'mlow' })
        });
    }
    applyVoipSettings(settings) {
        if (!settings)
            return;
        this.info.voipSettings = settings;
        this.rtcpRembDisabled = settings.disableRtcpRemb;
        this.videoStateTxnEnforced = settings.getFlag(VOIP_SETTINGS_OPTIONS_SECTION, VIDEO_STATE_TXN_RECV_ENFORCE_KEY, false);
        const intervalMs = settings.rtcpIntervalMs;
        if (intervalMs !== null && intervalMs !== this.rtcpIntervalMs) {
            this.rtcpIntervalMs = intervalMs;
            this.audioReportSchedule = SenderReportSchedule.onMediaClock(intervalMs, AUDIO_CLOCK_RATE);
            this.videoReportSchedule = SenderReportSchedule.onWallClock(intervalMs);
            this.receiverEstimateSchedule = SenderReportSchedule.onWallClock(intervalMs);
        }
        this.appDataSframeRequired = resolveAppDataSframe(settings);
        this.appDataStream?.setSframe(this.appDataSframeRequired, null);
        this.logger.debug('voip settings applied', {
            callId: this.info.callId,
            sectionCount: settings.sectionCount,
            disableRtcpRemb: this.rtcpRembDisabled,
            rtcpIntervalMs: this.rtcpIntervalMs,
            appDataStream: settings.getFlag(VOIP_SETTINGS_OPTIONS_SECTION, ENABLE_APP_DATA_STREAM_KEY, false),
            appDataStreamVersion: settings.getNumber(VOIP_SETTINGS_OPTIONS_SECTION, APP_DATA_STREAM_VERSION_KEY, 0),
            sframe: settings.getFlag(VOIP_SETTINGS_SFRAME_SECTION, ENABLE_SFRAME_KEY, false),
            sframeRx: settings.getFlag(VOIP_SETTINGS_SFRAME_SECTION, ENABLE_SFRAME_RX_KEY, false)
        });
    }
    resetOutgoingFlags() {
        this.initialTransportSent = false;
        this.outgoingPreacceptSent = false;
    }
    async acceptCall() {
        if (!this.info.canAccept) {
            throw new Error(`Call ${this.info.callId} cannot be accepted in state ${this.info.stateData.state}`);
        }
        this.info.applyTransition({ type: 'local_accepted' });
        this.delegate.emitState(this.info);
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const peerJid = this.info.peerJid;
        const isVideo = this.info.mediaType === CallMediaType.Video;
        const peerBase = toUserJid(peerJid);
        const participantPeers = this.info.relayData?.participantJids?.filter((jid) => toUserJid(jid) === peerBase && /:\d+@/.test(jid)) || [];
        const participantPeerJid = participantPeers.find((jid) => !/:0@/.test(jid)) || participantPeers[0];
        this.acceptedByJid = participantPeerJid || peerJid;
        const resolvedPeerSsrc = generateSecureSsrc(callId, this.ensureDeviceJid(this.acceptedByJid));
        this.peerSsrcs = [resolvedPeerSsrc];
        this.sctpRelay.setSubscriptionSsrc(resolvedPeerSsrc);
        this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs, this.peerStreamSsrcs);
        this.initSrtpKeys();
        try {
            const transportNode = buildTransportStanza(peerJid, callId, callCreator, meId, '1', '1');
            await this.deps.lowLevelCoordinator.sendNode(transportNode);
        }
        catch (err) {
            this.logger.error('error sending transport', {
                message: toError(err).message
            });
        }
        if (this.info.encryptionKey) {
            const acceptStanza = await buildAcceptStanza(this.deps, this.info.callId, this.info.peerJid, this.info.callCreator, isVideo);
            try {
                await this.deps.lowLevelCoordinator.sendNode(acceptStanza);
            }
            catch (err) {
                this.logger.error('accept send error', {
                    message: toError(err).message
                });
            }
        }
        if (this.info.relayData) {
            await this.connectRelays(this.info.relayData.endpoints);
        }
        this.logger.debug('call accepted', { callId });
    }
    async rejectCall(reason = EndCallReason.Declined) {
        this.info.applyTransition({ type: 'local_rejected', reason });
        this.delegate.emitState(this.info);
        const node = buildRejectStanza(this.info.peerJid, this.info.callId, this.info.callCreator);
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('reject send failed', { message: toError(err).message });
        }
        this.cleanup();
    }
    async endCall(reason = EndCallReason.UserEnded) {
        if (this.info.isEnded)
            return;
        const connectedAt = this.info.stateData.connectedAt;
        const audioDurationMs = connectedAt ? Date.now() - connectedAt.getTime() : undefined;
        this.info.applyTransition({ type: 'terminated', reason });
        const terminateTarget = this.acceptedByJid ?? this.info.peerJid;
        const node = buildTerminateStanza(terminateTarget, this.info.callId, this.info.callCreator, audioDurationMs);
        this.delegate.emitEnded(this.info);
        this.delegate.emitState(this.info);
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('terminate send failed', { message: toError(err).message });
        }
        this.cleanup();
    }
    setMute(muted) {
        if (!this.info.isActive)
            return;
        if (this.info.stateData.audioMuted === muted)
            return;
        this.info.applyTransition({ type: 'audio_mute_changed', muted });
        this.delegate.emitState(this.info);
        this.audioEngine.setMuted(muted);
        const node = buildMuteV2Stanza(this.acceptedByJid ?? this.info.peerJid, this.info.callId, this.info.callCreator, muted);
        void this.deps.lowLevelCoordinator.sendNode(node).catch((err) => {
            this.logger.warn('mute_v2 announcement failed', {
                muted,
                message: toError(err).message
            });
        });
    }
    announceInitialMuteState() {
        if (this.initialMuteAnnounced)
            return;
        this.initialMuteAnnounced = true;
        const node = buildMuteV2Stanza(this.acceptedByJid ?? this.info.peerJid, this.info.callId, this.info.callCreator, this.info.stateData.audioMuted);
        void this.deps.lowLevelCoordinator.sendNode(node).catch((err) => {
            this.logger.warn('initial mute_v2 announcement failed', {
                callId: this.info.callId,
                message: toError(err).message
            });
        });
    }
    async setHandRaised(raised) {
        if (!this.info.isActive)
            return;
        if (this.info.stateData.handRaised === raised)
            return;
        const node = buildRaiseHandStanza(this.acceptedByJid ?? this.info.peerJid, this.info.callId, this.info.callCreator, raised);
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('raise hand send failed', {
                raised,
                message: toError(err).message
            });
            throw err;
        }
        this.info.applyTransition({ type: 'hand_raise_changed', raised });
        this.delegate.emitState(this.info);
    }
    async setScreenShare(sharing) {
        if (!this.info.isActive)
            return;
        if (this.info.stateData.screenSharing === sharing)
            return;
        if (sharing) {
            if (this.info.groupJid) {
                throw new Error(`Call ${this.info.callId} is a group call, which cannot be shared`);
            }
            if (!this.videoSendActive) {
                throw new Error(`Call ${this.info.callId} carries no video to share the screen on`);
            }
        }
        const peerDeviceJid = this.acceptedByJid ?? this.info.peerJid;
        const state = sharing ? WA_SCREEN_SHARE_STATE.Started : WA_SCREEN_SHARE_STATE.Stopped;
        try {
            await this.deps.lowLevelCoordinator.sendNode(buildScreenShareStanza(peerDeviceJid, this.info.callId, this.info.callCreator, state));
        }
        catch (err) {
            this.logger.warn('screen share request failed', {
                sharing,
                message: toError(err).message
            });
            throw err;
        }
        this.info.applyTransition({ type: 'screen_share_changed', sharing });
        this.delegate.emitState(this.info);
        this.logger.debug('screen share state announced', {
            callId: this.info.callId,
            sharing
        });
    }
    async loadAudio(audioPath) {
        await this.audioEngine.loadAudioFile(audioPath);
        this.resetEncodeState();
        this.logger.debug('audio loaded for call', { callId: this.info.callId });
    }
    setExternalAudioMode(enabled) {
        this.audioEngine.setExternalMode(enabled);
        if (enabled) {
            this.resetEncodeState();
            this.logger.debug('external audio mode enabled', { callId: this.info.callId });
        }
    }
    feedLiveAudio(data) {
        return this.audioEngine.feedExternalAudio(data);
    }
    feedLiveVideo(data, timestampUs) {
        if (!this.videoSendActive ||
            !this.videoRtpSession ||
            !this.srtpSession ||
            !this.sctpRelay.hasConnection() ||
            !data.length)
            return 0;
        const payloads = packetizeH264AnnexB(data, 800);
        const timestamp = Math.floor((Math.max(0, timestampUs) * 90) / 1000) >>> 0;
        const keyFrame = isH264KeyFrame(data);
        const receiverEstimate = this.announcedReceiverEstimate;
        for (let index = 0; index < payloads.length; index++) {
            const firstPacket = index === 0;
            const packet = this.videoRtpSession.createPacketAtTimestamp(payloads[index], timestamp, index === payloads.length - 1);
            packet.header.extension = true;
            packet.header.extensionProfile = WA_RTP_EXTENSION_PROFILE;
            packet.header.extensionData = this.buildVideoExtension(keyFrame, firstPacket, this.videoTransportSequence++, firstPacket ? receiverEstimate : 0);
            const encrypted = this.srtpSession.protect(packet);
            this.sctpRelay.broadcast(toArrayBuffer(encrypted));
            this.videoPacketCount++;
            this.videoOctetCount += payloads[index].length;
        }
        if (this.videoReportSchedule.shouldReport(Date.now())) {
            this.sendSenderReport(this.videoRtpSession.getSsrc(), this.videoPacketCount, this.videoOctetCount, timestamp, this.videoReception, true);
        }
        this.videoFrameNumber = (this.videoFrameNumber + 1) & 0xffff;
        this.videoSendFrames++;
        if (this.videoSendFrames === 1 || this.videoSendFrames % 30 === 0) {
            this.logger.debug('video sent', {
                callId: this.info.callId,
                frames: this.videoSendFrames,
                bytes: data.length,
                packets: payloads.length
            });
        }
        return payloads.length;
    }
    get announcedReceiverEstimate() {
        return this.receiverEstimateBitrate > 0
            ? this.receiverEstimateBitrate
            : INITIAL_RECEIVER_ESTIMATE;
    }
    buildVideoExtension(keyFrame, firstPacket, transportSequence, receiverEstimate) {
        const extension = this.videoExtensionScratch;
        let offset = 0;
        extension[offset++] = firstPacket ? 0x32 : 0x30;
        extension[offset++] = keyFrame ? 0x08 : 0x20;
        if (firstPacket) {
            extension[offset++] = (this.videoFrameNumber >>> 8) & 0xff;
            extension[offset++] = this.videoFrameNumber & 0xff;
        }
        extension[offset++] = 0x51;
        extension[offset++] = 0;
        extension[offset++] = 0;
        extension[offset++] = 0x61;
        extension[offset++] = 0;
        extension[offset++] = 0;
        extension[offset++] = 0x91;
        extension[offset++] = (transportSequence >>> 8) & 0xff;
        extension[offset++] = transportSequence & 0xff;
        if (receiverEstimate > 0) {
            offset += writeFastRembExtension(extension, offset, receiverEstimate);
        }
        const padded = padTo32Bits(offset);
        if (padded > offset)
            extension.fill(0, offset, padded);
        return this.videoExtensionViews[padded >>> 2];
    }
    getLiveBufferMs() {
        return this.audioEngine.getLiveBufferMs();
    }
    async sendIncomingPreaccept(peerJid) {
        try {
            const preacceptNode = buildPreacceptStanza(peerJid, this.info.callId, this.info.callCreator);
            await this.deps.lowLevelCoordinator.sendNode(preacceptNode);
        }
        catch (err) {
            this.logger.error('error sending preaccept', {
                message: toError(err).message
            });
        }
    }
    async sendIncomingRelayLatency() {
        if (!this.info.relayData)
            return;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const destinationJids = this.info.relayData.participantJids || [];
        const seenRelayNames = new Set();
        for (const ep of this.info.relayData.endpoints) {
            const name = ep.relayName || '';
            if (!name || seenRelayNames.has(name))
                continue;
            seenRelayNames.add(name);
            try {
                const relayData = [
                    {
                        relayName: name,
                        latency: ep.c2rRtt || 0,
                        addressBytes: ep.addressBytes
                    }
                ];
                const relayLatencyNode = buildRelayLatencyStanza(this.info.peerJid, callId, callCreator, relayData, destinationJids, meId);
                await this.deps.lowLevelCoordinator.sendNode(relayLatencyNode);
            }
            catch (err) {
                this.logger.error('error sending incoming relaylatency', {
                    relayName: name,
                    message: toError(err).message
                });
            }
        }
    }
    async handleCallAccept(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        let srtpFromPeerKey = false;
        if (needsDecryption(nodeInfo.tag)) {
            try {
                const peerCallKey = await decryptCallKey(this.deps, nodeInfo.innerNode, peerJid, this.logger.child({ component: 'signaling' }));
                if (peerCallKey) {
                    const ourCallKey = this.info.encryptionKey;
                    const keysMatch = ourCallKey
                        ? uint8TimingSafeEqual(ourCallKey, peerCallKey)
                        : false;
                    if (!keysMatch && ourCallKey) {
                        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
                        const meJid = this.deps.authClient.getCurrentCredentials()?.meJid;
                        const ourCredJid = meLid || meJid || '';
                        const ourBase = ourCredJid ? toUserJid(ourCredJid) : '';
                        const participants = this.info.relayData?.participantJids || [];
                        const ourDeviceJid = participants.find((jid) => {
                            const jBase = toUserJid(jid);
                            return jBase === ourBase && /:\d+@/.test(jid);
                        }) || ourCredJid;
                        if (ourDeviceJid && peerJid) {
                            try {
                                const sendKeying = derivePerJidSrtpKey(ourCallKey, this.ensureDeviceJid(ourDeviceJid));
                                const recvKeying = derivePerJidSrtpKey(peerCallKey, this.ensureDeviceJid(peerJid));
                                this.srtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
                                this.srtcpContext = new SrtcpContext(sendKeying);
                                this.srtcpRecvSession = new SrtcpSession(recvKeying);
                                srtpFromPeerKey = true;
                                this.logger.debug('srtp re-initialized with peer call_key', {
                                    callId: this.info.callId
                                });
                            }
                            catch (err) {
                                this.logger.error('per-jid srtp re-derivation failed', {
                                    message: toError(err).message
                                });
                            }
                        }
                    }
                }
            }
            catch (err) {
                this.logger.error('accept decrypt error', {
                    message: toError(err).message
                });
            }
        }
        try {
            this.info.applyTransition({ type: 'remote_accepted' });
            this.delegate.emitState(this.info);
        }
        catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message });
        }
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
        const ourJid = meLid || meId;
        const ourBase = ourJid ? toUserJid(ourJid) : '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const acceptingDeviceJid = this.info.mediaType === CallMediaType.Video && !/:\d+@/.test(peerJid)
            ? peerJid
            : this.info.mediaType === CallMediaType.Video
                ? this.info.relayData?.participantJids?.find((jid) => {
                    const jidBase = toUserJid(jid);
                    return jidBase !== ourBase && /:[1-9]\d*@/.test(jid);
                }) || peerJid
                : peerJid;
        this.acceptedByJid = acceptingDeviceJid;
        if (this.actualPeerSsrc !== null) {
            const calculatedJid = this.ensureDeviceJid(acceptingDeviceJid);
            this.logger.debug('accept keeping actual peer ssrc', {
                callId,
                actualPeerSsrc: `0x${this.actualPeerSsrc.toString(16)}`,
                calculatedJid
            });
        }
        else {
            const peerDeviceJidForSsrc = this.ensureDeviceJid(acceptingDeviceJid);
            const acceptSsrc = generateSecureSsrc(callId, peerDeviceJidForSsrc);
            this.peerSsrcs = [acceptSsrc];
            this.logger.debug('accept ssrc assigned', {
                callId,
                jid: peerDeviceJidForSsrc,
                ssrc: `0x${acceptSsrc.toString(16)}`
            });
        }
        const relaySlots = this.info.mediaType === CallMediaType.Video
            ? WA_VIDEO_CALL_SSRC_SLOTS
            : WA_AUDIO_CALL_SSRC_SLOTS;
        const acceptedPeerDeviceJid = this.ensureDeviceJid(acceptingDeviceJid);
        this.peerStreamSsrcs = relaySlots.map((slot) => generateSecureSsrc(callId, acceptedPeerDeviceJid, slot));
        if (this.info.mediaType === CallMediaType.Audio) {
            const peerBase = toUserJid(peerJid);
            const peerDevices = (this.info.relayData?.participantJids || [])
                .filter((jid) => toUserJid(jid) === peerBase)
                .map((jid) => this.ensureDeviceJid(jid));
            this.peerStreamSsrcs = Array.from(new Set([acceptedPeerDeviceJid, ...peerDevices].flatMap((jid) => [
                generateSecureSsrc(callId, jid, WA_SSRC_SLOT.AUDIO.MAIN),
                generateSecureSsrc(callId, jid, WA_SSRC_SLOT.APP_DATA.MAIN)
            ])));
            this.trackPeerAppDataSsrcs([acceptedPeerDeviceJid, ...peerDevices]);
        }
        else {
            this.trackPeerAppDataSsrcs([acceptedPeerDeviceJid]);
        }
        if (this.videoReceivePathOpened) {
            this.mergePeerVideoSlots(acceptedPeerDeviceJid);
        }
        this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
        this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs, this.peerStreamSsrcs);
        this.sctpRelay.resendSubscriptions();
        if (!srtpFromPeerKey) {
            this.initSrtpKeys();
        }
        if (this.info.relayData?.participantJids) {
            const otherDevices = this.info.relayData.participantJids.filter((jid) => {
                if (jid === acceptingDeviceJid)
                    return false;
                const jidBase = toUserJid(jid);
                if (jidBase === ourBase)
                    return false;
                return true;
            });
            for (const deviceJid of otherDevices) {
                try {
                    const terminateNode = buildTerminateStanza(deviceJid, callId, callCreator, undefined, 'accepted_elsewhere');
                    await this.deps.lowLevelCoordinator.sendNode(terminateNode);
                }
                catch (err) {
                    this.logger.error('error sending terminate_elsewhere', {
                        deviceJid,
                        message: toError(err).message
                    });
                }
            }
        }
        try {
            const transportNode = buildTransportStanza(acceptingDeviceJid, callId, callCreator, meId, '1', '1');
            await this.deps.lowLevelCoordinator.sendNode(transportNode);
        }
        catch (err) {
            this.logger.error('error sending transport', {
                message: toError(err).message
            });
        }
        const acceptMsgId = node.attrs?.id;
        if (acceptMsgId) {
            try {
                const receiptNode = buildAcceptReceiptStanza(acceptingDeviceJid, acceptMsgId, callId, callCreator, ourJid);
                await this.deps.lowLevelCoordinator.sendNode(receiptNode);
            }
            catch (err) {
                this.logger.error('error sending accept receipt', {
                    message: toError(err).message
                });
            }
        }
        if (this.sctpRelay.hasConnection()) {
            try {
                this.info.applyTransition({ type: 'media_connected' });
                this.delegate.emitState(this.info);
                this.startMediaFlow();
                this.announceInitialMuteState();
            }
            catch (err) {
                this.logger.trace('call transition skipped', { message: toError(err).message });
            }
        }
        else if (this.info.relayData) {
            await this.connectRelays(this.info.relayData.endpoints);
        }
    }
    async handleCallPreaccept(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        if (this.info.direction === CallDirection.Outgoing && this.info.relayData) {
            const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
            const callId = this.info.callId;
            const callCreator = this.info.callCreator;
            const destinationJids = this.info.relayData.participantJids || [];
            const seenRelayNames = new Set();
            for (const ep of this.info.relayData.endpoints) {
                const name = ep.relayName || '';
                if (!name || seenRelayNames.has(name))
                    continue;
                seenRelayNames.add(name);
                try {
                    const relayData = [
                        {
                            relayName: name,
                            latency: ep.c2rRtt || 0,
                            addressBytes: ep.addressBytes
                        }
                    ];
                    const relayLatencyNode = buildRelayLatencyStanza(this.info.peerJid, callId, callCreator, relayData, destinationJids, meId);
                    await this.deps.lowLevelCoordinator.sendNode(relayLatencyNode);
                }
                catch (err) {
                    this.logger.error('error sending relaylatency', {
                        relayName: name,
                        message: toError(err).message
                    });
                }
            }
            if (!this.initialTransportSent) {
                try {
                    const basePeerJid = toUserJid(peerJid);
                    const transportNode = buildTransportStanza(basePeerJid, callId, callCreator, meId);
                    await this.deps.lowLevelCoordinator.sendNode(transportNode);
                    this.initialTransportSent = true;
                }
                catch (err) {
                    this.logger.error('error sending initial transport', {
                        message: toError(err).message
                    });
                }
            }
        }
    }
    async handleCallTransport(_node) {
        const nodeInfo = extractNodeInfo(_node);
        if (!nodeInfo)
            return;
        const relays = extractRelayEndpoints(nodeInfo.innerNode);
        if (relays.length > 0 && !this.sctpRelay.hasConnection()) {
            this.info.relayData = {
                ...this.info.relayData,
                endpoints: relays
            };
            await this.connectRelays(relays);
        }
    }
    async handleCallAck(node) {
        const ackType = node.attrs?.type;
        if (ackType !== 'offer')
            return;
        const error = node.attrs?.error;
        if (error) {
            this.logger.error('ack error', { callId: this.info.callId, error });
            return;
        }
        if (!this.info.voipSettings) {
            this.applyVoipSettings(parseVoipSettings(node, this.logger));
        }
        const { relays, participantJids, uuid, selfPid, peerPid, hbhKey } = parseRelayFromAck(node);
        if (relays.length > 0) {
            this.info.relayData = {
                endpoints: relays,
                participantJids,
                uuid,
                selfPid,
                peerPid,
                hbhKey
            };
            this.logger.debug('offer ack relays parsed', {
                callId: this.info.callId,
                relayCount: relays.length,
                participantCount: participantJids.length
            });
            const callKey = this.info.encryptionKey;
            if (participantJids.length > 0) {
                const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
                const meId = this.deps.authClient.getCurrentCredentials()?.meJid;
                const ourCredJid = meLid || meId || '';
                const ourBase = ourCredJid ? toUserJid(ourCredJid) : '';
                const ourDeviceJid = this.ensureDeviceJid(participantJids.find((jid) => {
                    const jidBase = toUserJid(jid);
                    return jidBase === ourBase && /:\d+@/.test(jid);
                }) || ourCredJid);
                this.selfDeviceJid = ourDeviceJid;
                this.openAppDataStream(ourDeviceJid);
                const peerJids = participantJids.filter((jid) => {
                    const jidBase = toUserJid(jid);
                    return jidBase !== ourBase;
                });
                const peerCandidate = peerJids.find((jid) => /:\d+@/.test(jid) && !/:0@/.test(jid)) || peerJids[0];
                const peerDeviceJid = peerCandidate
                    ? this.ensureDeviceJid(peerCandidate)
                    : undefined;
                const newSelfSsrc = generateSecureSsrc(this.info.callId, ourDeviceJid);
                if (newSelfSsrc !== this.selfSsrc) {
                    this.selfSsrc = newSelfSsrc;
                    this.rtpSession = RtpSession.whatsappOpus(newSelfSsrc);
                }
                if (this.info.mediaType === CallMediaType.Video) {
                    const relaySlots = WA_VIDEO_CALL_SSRC_SLOTS;
                    this.selfStreamSsrcs = relaySlots.map((slot) => generateSecureSsrc(this.info.callId, ourDeviceJid, slot));
                    this.selfSsrc = this.selfStreamSsrcs[0];
                    this.rtpSession = RtpSession.whatsappOpus(this.selfSsrc);
                    this.videoRtpSession = new RtpSession(generateSecureSsrc(this.info.callId, ourDeviceJid, WA_SSRC_SLOT.VIDEO.MAIN), PayloadType.WhatsAppH264, VIDEO_CLOCK_RATE, VIDEO_TICKS_PER_FRAME);
                    if (peerDeviceJid) {
                        this.peerStreamSsrcs = relaySlots.map((slot) => generateSecureSsrc(this.info.callId, peerDeviceJid, slot));
                    }
                    this.sctpRelay.setSsrc(this.selfSsrc);
                    this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs, this.peerStreamSsrcs);
                }
                if (peerDeviceJid) {
                    const peerDeviceSsrc = generateSecureSsrc(this.info.callId, peerDeviceJid);
                    this.peerSsrcs = [peerDeviceSsrc];
                    this.trackPeerAppDataSsrcs([peerDeviceJid]);
                }
                if (callKey) {
                    this.initSrtpKeys();
                }
                else {
                    this.logger.debug('no call_key, srtp not initialized', {
                        callId: this.info.callId
                    });
                }
            }
            if (this.info.isInitiator && !this.outgoingPreacceptSent) {
                try {
                    const preacceptNode = buildPreacceptStanza(this.info.peerJid, this.info.callId, this.info.callCreator);
                    await this.deps.lowLevelCoordinator.sendNode(preacceptNode);
                    this.outgoingPreacceptSent = true;
                }
                catch (err) {
                    this.logger.error('error sending preaccept (caller)', {
                        message: toError(err).message
                    });
                }
            }
            await this.connectRelays(relays);
            if (this.srtpSession &&
                this.rtpSession &&
                this.opusCodec &&
                this.sctpRelay.hasConnection()) {
                this.audioEngine.startSilenceCapture();
            }
        }
    }
    async handleCallRelaylatency(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const inner = nodeInfo.innerNode;
        const callId = inner.attrs?.['call-id'] || this.info.callId;
        const callCreator = inner.attrs?.['call-creator'] || this.info.callCreator;
        const teNodes = getNodeChildrenByTag(inner, 'te');
        if (teNodes.length === 0)
            return;
        const destinationJids = this.info.relayData?.participantJids || [];
        if (destinationJids.length > 0) {
            const forwardNode = buildRelaylatencyForwardStanza(peerJid, callId, callCreator, teNodes, destinationJids);
            try {
                await this.deps.lowLevelCoordinator.sendNode(forwardNode);
            }
            catch (err) {
                this.logger.error('error forwarding relaylatency', {
                    message: toError(err).message
                });
            }
        }
    }
    handleRelayElection(node) {
        const inner = getFirstNodeChild(node);
        if (!inner)
            return;
        let electedRelayIdx;
        if (inner.attrs?.['elected_relay_idx'] !== undefined) {
            const parsed = Number(inner.attrs['elected_relay_idx']);
            if (Number.isSafeInteger(parsed) && parsed >= 0)
                electedRelayIdx = parsed;
        }
        else if (inner.attrs?.['relay_id'] !== undefined) {
            const parsed = Number(inner.attrs['relay_id']);
            if (Number.isSafeInteger(parsed) && parsed >= 0)
                electedRelayIdx = parsed;
        }
        else if (inner.content instanceof Uint8Array) {
            const bytes = inner.content;
            if (bytes.length >= 4)
                electedRelayIdx = readUInt32BE(bytes, 0);
            else if (bytes.length > 0)
                electedRelayIdx = bytes[0];
        }
        if (electedRelayIdx !== undefined) {
            this.info.electedRelayIdx = electedRelayIdx;
            this.logger.debug('elected relay index', {
                callId: this.info.callId,
                electedRelayIdx
            });
        }
    }
    handleCallMuteV2(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        if (this.isOwnAccountJid(peerJid)) {
            this.logger.debug('ignoring mute_v2 from another device of this account', { peerJid });
            return;
        }
        const payload = parseMuteV2(nodeInfo.innerNode);
        if (payload.isRequest) {
            this.logger.debug('ignoring mute request on a 1:1 call', { peerJid });
            return;
        }
        if (payload.muted === null) {
            this.logger.debug('mute_v2 carries no readable mute-state', { peerJid });
            return;
        }
        if (this.info.stateData.peerAudioMuted === payload.muted)
            return;
        this.info.stateData.peerAudioMuted = payload.muted;
        this.delegate.emitPeerMute(this.info, payload.muted);
        this.delegate.emitState(this.info);
    }
    isOwnAccountJid(jid) {
        const creds = this.deps.authClient.getCurrentCredentials();
        const user = toUserJid(jid);
        return ((!!creds?.meLid && user === toUserJid(creds.meLid)) ||
            (!!creds?.meJid && user === toUserJid(creds.meJid)));
    }
    handleCallUserAction(node, peerJid) {
        this.applyPeerRaiseHand(node, peerJid);
    }
    handleCallRaiseHand(node, peerJid) {
        this.applyPeerRaiseHand(node, peerJid);
    }
    applyPeerRaiseHand(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        if (this.isOwnAccountJid(peerJid)) {
            this.logger.debug('ignoring raise hand from another device of this account', {
                peerJid
            });
            return;
        }
        const raised = parseRaiseHandState(nodeInfo.innerNode);
        if (raised === null) {
            this.logger.trace('call stanza without raise-hand state, ignored', {
                tag: nodeInfo.tag,
                action: nodeInfo.innerNode.attrs?.action
            });
            return;
        }
        const raisedHands = this.info.raisedHands;
        if (raisedHands.has(peerJid) === raised)
            return;
        if (raised) {
            if (raisedHands.size >= MAX_TRACKED_RAISED_HANDS) {
                this.logger.debug('raised-hand tracking full, state dropped', {
                    participantJid: peerJid,
                    tracked: raisedHands.size
                });
                return;
            }
            raisedHands.add(peerJid);
        }
        else {
            raisedHands.delete(peerJid);
        }
        this.logger.debug('peer raise hand state changed', {
            participantJid: peerJid,
            raised
        });
        this.delegate.emitHandRaise(this.info, peerJid, raised);
    }
    handleCallScreenShare(node) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const share = parseScreenShareNode(nodeInfo.innerNode);
        if (!share) {
            this.logger.debug('screen share stanza carried no state', {
                callId: this.info.callId,
                tag: nodeInfo.tag
            });
            return;
        }
        this.info.peerScreenShare = share;
        this.logger.debug('peer screen share state', {
            callId: this.info.callId,
            tag: nodeInfo.tag,
            state: share.state,
            requestState: share.requestState,
            version: share.version
        });
        this.delegate.emitScreenShare(this.info, share);
        this.delegate.emitState(this.info);
    }
    handleCallVideoState(node) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const change = parseVideoStateNode(nodeInfo.innerNode);
        if (!change) {
            this.logger.debug('video state stanza without a readable state, ignored', {
                callId: this.info.callId
            });
            return;
        }
        if (this.isStaleVideoState(change.transactionId)) {
            this.logger.debug('stale video state', {
                callId: this.info.callId,
                transactionId: change.transactionId,
                lastTransactionId: this.info.peerVideoState?.transactionId ?? null,
                enforced: this.videoStateTxnEnforced
            });
            if (this.videoStateTxnEnforced)
                return;
        }
        this.applyVoipSettings(parseVoipSettings(node, this.logger));
        this.info.peerVideoState = change;
        this.peerVideoStateSeen++;
        this.ensureVideoReceivePath();
        this.applyPeerUpgradeState(change.state);
        this.logger.debug('peer video state changed', {
            callId: this.info.callId,
            state: change.state,
            transactionId: change.transactionId,
            decoderCodec: change.decoderCodec,
            encoderCodec: change.encoderCodec
        });
        this.delegate.emitPeerVideoState(this.info, change);
    }
    isStaleVideoState(transactionId) {
        if (transactionId === null)
            return false;
        const last = this.info.peerVideoState?.transactionId ?? null;
        return last !== null && transactionId <= last;
    }
    applyPeerUpgradeState(state) {
        switch (state) {
            case WA_VIDEO_STATE.UpgradeRequest:
            case WA_VIDEO_STATE.UpgradeRequestV2:
                this.peerVideoUpgradeRequested = true;
                return;
            case WA_VIDEO_STATE.UpgradeAccept:
                this.peerVideoUpgradeRequested = false;
                if (this.pendingVideoUpgrade) {
                    this.openVideoSendPath();
                    this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.Accepted);
                    void this.sendVideoState(WA_VIDEO_STATE.Enabled).catch(() => { });
                }
                return;
            case WA_VIDEO_STATE.UpgradeReject:
                this.peerVideoUpgradeRequested = false;
                this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.Rejected);
                return;
            case WA_VIDEO_STATE.UpgradeRejectByTimeout:
                this.peerVideoUpgradeRequested = false;
                this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.RejectedByTimeout);
                return;
            case WA_VIDEO_STATE.Error:
                this.peerVideoUpgradeRequested = false;
                this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.Failed);
                return;
            case WA_VIDEO_STATE.UpgradeCancel:
            case WA_VIDEO_STATE.UpgradeCancelByTimeout:
                this.peerVideoUpgradeRequested = false;
                return;
            case WA_VIDEO_STATE.Disabled:
                this.peerVideoUpgradeRequested = false;
                return;
            default:
                return;
        }
    }
    async requestVideoUpgrade() {
        if (!this.info.isActive) {
            throw new Error(`Call ${this.info.callId} is not active`);
        }
        if (this.videoSendActive) {
            throw new Error(`Call ${this.info.callId} already carries video`);
        }
        if (this.pendingVideoUpgrade) {
            return this.pendingVideoUpgrade.promise;
        }
        if (this.peerVideoUpgradeRequested) {
            await this.acceptVideoUpgrade();
            return WA_VIDEO_UPGRADE_RESULT.Accepted;
        }
        let settle;
        const promise = new Promise((resolve) => {
            settle = resolve;
        });
        const timer = setTimeout(() => {
            this.onVideoUpgradeTimeout();
        }, WA_VIDEO_UPGRADE_TIMEOUT_MS);
        timer.unref?.();
        this.pendingVideoUpgrade = { timer, settle, promise };
        try {
            await this.sendVideoState(WA_VIDEO_STATE.UpgradeRequestV2);
        }
        catch (err) {
            this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.Failed);
            throw err;
        }
        this.logger.debug('video upgrade requested', {
            callId: this.info.callId,
            timeoutMs: WA_VIDEO_UPGRADE_TIMEOUT_MS
        });
        return promise;
    }
    async acceptVideoUpgrade() {
        if (!this.peerVideoUpgradeRequested)
            return;
        const seen = this.peerVideoStateSeen;
        this.peerVideoUpgradeRequested = false;
        try {
            await this.sendVideoState(WA_VIDEO_STATE.UpgradeAccept);
        }
        catch (err) {
            this.restorePeerRequest(seen);
            throw err;
        }
        this.openVideoSendPath();
        await this.sendVideoState(WA_VIDEO_STATE.Enabled).catch(() => { });
        this.logger.debug('video upgrade accepted', { callId: this.info.callId });
    }
    async rejectVideoUpgrade() {
        if (!this.peerVideoUpgradeRequested)
            return;
        const seen = this.peerVideoStateSeen;
        this.peerVideoUpgradeRequested = false;
        try {
            await this.sendVideoState(WA_VIDEO_STATE.UpgradeReject);
        }
        catch (err) {
            this.restorePeerRequest(seen);
            throw err;
        }
        this.logger.debug('video upgrade rejected', { callId: this.info.callId });
    }
    restorePeerRequest(seen) {
        if (this.peerVideoStateSeen !== seen)
            return;
        this.peerVideoUpgradeRequested = true;
    }
    async cancelVideoUpgrade() {
        if (!this.pendingVideoUpgrade)
            return;
        this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.Cancelled);
        await this.sendVideoState(WA_VIDEO_STATE.UpgradeCancel);
        this.logger.debug('video upgrade cancelled', { callId: this.info.callId });
    }
    onVideoUpgradeTimeout() {
        if (!this.pendingVideoUpgrade)
            return;
        this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.TimedOut);
        this.peerVideoUpgradeRequested = false;
        this.logger.debug('video upgrade timed out, staying on audio', {
            callId: this.info.callId,
            timeoutMs: WA_VIDEO_UPGRADE_TIMEOUT_MS
        });
        void this.sendVideoState(WA_VIDEO_STATE.Disabled).catch(() => { });
    }
    settleVideoUpgrade(result) {
        const pending = this.pendingVideoUpgrade;
        if (!pending)
            return;
        this.pendingVideoUpgrade = null;
        clearTimeout(pending.timer);
        pending.settle(result);
    }
    async sendVideoState(state) {
        this.videoStateTransactionId++;
        const id = this.videoStateTransactionId;
        const node = buildVideoStateStanza(this.acceptedByJid ?? this.info.peerJid, this.info.callId, this.info.callCreator, { state, transactionId: id });
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('video state send failed', {
                callId: this.info.callId,
                state,
                message: toError(err).message
            });
            throw err;
        }
    }
    openVideoSendPath() {
        this.ensureVideoReceivePath();
        if (this.videoSendPathOpened || this.info.mediaType === CallMediaType.Video) {
            this.announceVideoLive();
            return;
        }
        this.videoSendPathOpened = true;
        if (this.selfDeviceJid) {
            for (const slot of VIDEO_ONLY_SSRC_SLOTS) {
                const ssrc = generateSecureSsrc(this.info.callId, this.selfDeviceJid, slot);
                if (!this.selfStreamSsrcs.includes(ssrc)) {
                    this.selfStreamSsrcs.push(ssrc);
                }
            }
            if (!this.videoRtpSession) {
                this.videoRtpSession = new RtpSession(generateSecureSsrc(this.info.callId, this.selfDeviceJid, WA_SSRC_SLOT.VIDEO.MAIN), PayloadType.WhatsAppH264, VIDEO_CLOCK_RATE, VIDEO_TICKS_PER_FRAME);
            }
        }
        this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs, this.peerStreamSsrcs);
        this.sctpRelay.resendSubscriptions();
        this.announceVideoLive();
        this.logger.debug('video send path opened mid-call', {
            callId: this.info.callId,
            hasVideoRtpSession: this.videoRtpSession !== null
        });
    }
    announceVideoLive() {
        if (!this.info.stateData.videoOff)
            return;
        try {
            this.info.applyTransition({ type: 'video_state_changed', off: false });
        }
        catch (err) {
            this.logger.trace('video state transition skipped', {
                message: toError(err).message
            });
            return;
        }
        this.delegate.emitState(this.info);
    }
    get videoSendActive() {
        return this.info.mediaType === CallMediaType.Video || this.videoSendPathOpened;
    }
    ensureVideoReceivePath() {
        if (this.videoReceivePathOpened || this.info.mediaType === CallMediaType.Video)
            return;
        this.videoReceivePathOpened = true;
        const peerDeviceJid = this.ensureDeviceJid(this.acceptedByJid ?? this.info.peerJid);
        this.mergePeerVideoSlots(peerDeviceJid);
        if (!this.videoRtpSession && this.selfDeviceJid) {
            this.videoRtpSession = new RtpSession(generateSecureSsrc(this.info.callId, this.selfDeviceJid, WA_SSRC_SLOT.VIDEO.MAIN), PayloadType.WhatsAppH264, VIDEO_CLOCK_RATE, VIDEO_TICKS_PER_FRAME);
        }
        this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs, this.peerStreamSsrcs);
        this.sctpRelay.resendSubscriptions();
        this.logger.debug('video receive path opened mid-call', {
            callId: this.info.callId,
            peerDeviceJid,
            hasVideoRtpSession: this.videoRtpSession !== null
        });
    }
    mergePeerVideoSlots(peerDeviceJid) {
        const slots = [WA_SSRC_SLOT.VIDEO.MAIN, WA_SSRC_SLOT.VIDEO.FEC, WA_SSRC_SLOT.VIDEO.OOB_NACK];
        for (const slot of slots) {
            const ssrc = generateSecureSsrc(this.info.callId, peerDeviceJid, slot);
            if (!this.peerStreamSsrcs.includes(ssrc)) {
                this.peerStreamSsrcs.push(ssrc);
            }
        }
    }
    onRelayLost(reason) {
        if (this.info.isEnded)
            return;
        this.logger.warn('call lost its last relay leg', {
            callId: this.info.callId,
            reason
        });
        this.delegate.endCall(this.info, EndCallReason.RelayLost);
    }
    handleCallTerminate() {
        try {
            this.info.applyTransition({
                type: 'terminated',
                reason: EndCallReason.UserEnded
            });
        }
        catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message });
        }
        this.delegate.emitEnded(this.info);
        this.delegate.emitState(this.info);
        this.cleanup();
    }
    sendCapturedAudio(data) {
        const hasRelay = this.sctpRelay.hasConnection();
        if (!this.rtpSession || !this.srtpSession || !this.opusCodec || !hasRelay) {
            this.audioDropCount++;
            if (this.audioDropCount === 1 || this.audioDropCount % 500 === 0) {
                const missing = [
                    !this.rtpSession && 'rtpSession',
                    !this.srtpSession && 'srtpSession',
                    !this.opusCodec && 'opusCodec',
                    !hasRelay && 'relayConnection'
                ]
                    .filter(Boolean)
                    .join(', ');
                this.logger.debug('audio dropped', {
                    callId: this.info.callId,
                    dropCount: this.audioDropCount,
                    missing
                });
            }
            return;
        }
        for (let i = 0; i < data.length; i++) {
            if (!Number.isFinite(data[i])) {
                data[i] = 0;
            }
        }
        const frameSamples = this.encodeFrameSamples;
        if (!this.encodeBuffer) {
            if (!this.encodeBufferA) {
                this.encodeBufferA = new Float32Array(frameSamples);
                this.encodeBufferB = new Float32Array(frameSamples);
            }
            this.encodeBuffer = this.encodeBufferA;
            this.encodeBufferPos = 0;
        }
        let offset = 0;
        while (offset < data.length) {
            const toCopy = Math.min(data.length - offset, frameSamples - this.encodeBufferPos);
            this.encodeBuffer.set(data.subarray(offset, offset + toCopy), this.encodeBufferPos);
            this.encodeBufferPos += toCopy;
            offset += toCopy;
            if (this.encodeBufferPos < frameSamples)
                break;
            const frameData = this.encodeBuffer;
            this.encodeBuffer =
                frameData === this.encodeBufferA ? this.encodeBufferB : this.encodeBufferA;
            this.encodeBufferPos = 0;
            try {
                const opusFrame = this.opusCodec.encode(frameData);
                this.sendOpusFrame(opusFrame, false);
                this.realAudioSendCount++;
            }
            catch (err) {
                this.logger.error('encode error', {
                    callId: this.info.callId,
                    message: toError(err).message
                });
            }
        }
    }
    cleanup() {
        const opusStats = this.opusCodec?.getStats();
        this.logger.debug('call stats', {
            callId: this.info.callId,
            relayPackets: this.relayPacketCount,
            recvOk: this.audioRecvCount,
            srtpErrors: this.srtpErrorCount,
            sent: this.audioSendCount,
            dropped: this.audioDropCount,
            videoFecDiscarded: this.reedSolomonFecPackets,
            opusOk: opusStats?.success ?? 0,
            opusErr: opusStats?.errors ?? 0
        });
        this.audioEngine.setOnAudioFinished(null);
        this.audioEngine.setPlaybackSink(null);
        this.audioEngine.stop();
        if (this.subscriptionRefreshInterval) {
            clearInterval(this.subscriptionRefreshInterval);
            this.subscriptionRefreshInterval = null;
        }
        this.sctpRelay.cleanup();
        if (this.opusCodec) {
            this.opusCodec.destroy();
            this.opusCodec = null;
        }
        this.rtpSession = null;
        this.videoRtpSession = null;
        this.srtpSession = null;
        this.srtcpContext = null;
        this.srtcpRecvSession = null;
        this.appDataStream?.close();
        this.appDataStream = null;
        this.peerAppDataSsrcs.clear();
        for (const depacketizer of this.h264Depacketizers.values())
            depacketizer.reset();
        this.h264Depacketizers.clear();
        this.audioSendCount = 0;
        this.audioOctetCount = 0;
        this.audioDropCount = 0;
        this.audioRecvCount = 0;
        this.srtpErrorCount = 0;
        this.relayPacketCount = 0;
        this.stunResponseCount = 0;
        this.selfEchoCount = 0;
        this.reedSolomonFecPackets = 0;
        this.audioReception.reset();
        this.videoReception.reset();
        this.audioReportSchedule.reset();
        this.videoReportSchedule.reset();
        this.receiverEstimateSchedule.reset();
        this.videoRecvOctets = 0;
        this.receiverEstimateWindowStartedAt = 0;
        this.receiverEstimateBitrate = 0;
        this.rtcpCname = null;
        this.actualPeerSsrc = null;
        this.ssrcResubscribed = false;
        this.recvRealCount = 0;
        this.recvDtxCount = 0;
        this.initialTransportSent = false;
        this.outgoingPreacceptSent = false;
        this.videoReceivePathOpened = false;
        this.settleVideoUpgrade(WA_VIDEO_UPGRADE_RESULT.Cancelled);
        this.peerVideoUpgradeRequested = false;
        this.peerVideoStateSeen = 0;
        this.videoSendPathOpened = false;
        this.videoStateTransactionId = 0;
        this.firstPacketSent = false;
        this.realAudioSendCount = 0;
        this.encodeBuffer = null;
        this.encodeBufferPos = 0;
        this.acceptedByJid = null;
    }
    get encodeFrameSamples() {
        return this.opusCodec?.getFrameSize() ?? 960;
    }
    get rtpTsDelta() {
        return this.encodeFrameSamples;
    }
    sendOpusFrame(opusFrame, isSilence) {
        if (!this.rtpSession || !this.srtpSession)
            return;
        try {
            let rtpPayload = opusFrame;
            const authPadding = SRTP_AUTH_TAG_LEN - SRTP_SEND_AUTH_TAG_LEN;
            if (authPadding > 0) {
                if (!this.authPaddingBuffer || this.authPaddingBuffer.length !== authPadding) {
                    this.authPaddingBuffer = new Uint8Array(authPadding);
                }
                rtpPayload = concatBytes([rtpPayload, this.authPaddingBuffer]);
            }
            const marker = !this.firstPacketSent;
            const tsDelta = this.rtpTsDelta;
            const rtpPacket = this.rtpSession.createPacketWithDuration(rtpPayload, tsDelta, marker);
            if (this.debeEnabled) {
                rtpPacket.header.extension = true;
                rtpPacket.header.extensionProfile = WA_RTP_EXTENSION_PROFILE;
                rtpPacket.header.extensionData = WaCallMediaSession.EMPTY_BYTES;
            }
            if (!this.firstPacketSent) {
                this.firstPacketSent = true;
            }
            const srtpData = this.srtpSession.protect(rtpPacket);
            this.sctpRelay.broadcast(toArrayBuffer(srtpData));
            this.audioSendCount++;
            this.audioOctetCount += rtpPayload.length;
            if (this.audioReportSchedule.shouldReport(rtpPacket.header.timestamp)) {
                this.sendSenderReport(this.rtpSession.getSsrc(), this.audioSendCount, this.audioOctetCount, rtpPacket.header.timestamp, this.audioReception);
            }
            if (this.audioSendCount === 1 || this.audioSendCount % 500 === 0) {
                this.logger.debug('audio sent', {
                    callId: this.info.callId,
                    sendCount: this.audioSendCount,
                    opusBytes: opusFrame.length,
                    srtpBytes: srtpData.length,
                    silence: isSilence
                });
            }
        }
        catch (err) {
            this.logger.error('error sending audio', {
                callId: this.info.callId,
                message: toError(err).message
            });
        }
    }
    sendReaction(reaction) {
        if (!this.appDataStream) {
            this.logger.debug('reaction dropped, app data stream not open', {
                callId: this.info.callId
            });
            return false;
        }
        if (!this.info.isActive) {
            this.logger.debug('reaction dropped, call not active', { callId: this.info.callId });
            return false;
        }
        return this.appDataStream.sendReaction(reaction);
    }
    openAppDataStream(selfDeviceJid) {
        const ssrc = generateSecureSsrc(this.info.callId, selfDeviceJid, WA_SSRC_SLOT.APP_DATA.MAIN);
        if (this.appDataStream?.ssrc === ssrc)
            return;
        this.appDataStream?.close();
        this.appDataStream = new WaAppDataStream({
            logger: this.logger.child({ component: 'app-data' }),
            ssrc,
            sendPacket: (packet) => {
                if (!this.srtpSession)
                    return false;
                return this.sctpRelay.broadcast(toArrayBuffer(this.srtpSession.protect(packet)));
            }
        });
        this.appDataStream.setSframe(this.appDataSframeRequired, null);
    }
    trackPeerAppDataSsrcs(deviceJids) {
        for (const jid of deviceJids) {
            if (!jid)
                continue;
            if (this.peerAppDataSsrcs.size >= MAX_TRACKED_PEER_APP_DATA_SSRCS)
                break;
            this.peerAppDataSsrcs.add(generateSecureSsrc(this.info.callId, jid, WA_SSRC_SLOT.APP_DATA.MAIN));
        }
    }
    onAppDataPacket(data, payloadType, ssrc) {
        const stream = this.appDataStream;
        if (!stream || !this.srtpSession)
            return;
        try {
            const packet = this.srtpSession.unprotect(data);
            stream.observeInboundPayloadType(payloadType);
            for (const reaction of stream.receive(packet.payload, ssrc)) {
                this.delegate.emitCallReaction?.(this.info, reaction);
            }
        }
        catch (err) {
            this.logger.debug('app data packet dropped', {
                callId: this.info.callId,
                payloadType,
                message: toError(err).message
            });
        }
    }
    ensureDeviceJid(jid) {
        if (/:\d+@/.test(jid))
            return jid;
        return jid.replace('@', ':0@');
    }
    initSrtpKeys() {
        const callKey = this.info.encryptionKey;
        if (!callKey) {
            this.logger.debug('no call_key, srtp not initialized', { callId: this.info.callId });
            return;
        }
        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid;
        const ourCredJid = meLid || meId || '';
        const ourBase = toUserJid(ourCredJid);
        const participants = this.info.relayData?.participantJids || [];
        const ourDeviceJid = this.ensureDeviceJid(participants.find((jid) => {
            const jBase = toUserJid(jid);
            return jBase === ourBase && /:\d+@/.test(jid);
        }) || ourCredJid);
        let rawPeerJid = this.acceptedByJid || this.info.peerJid;
        if (!this.acceptedByJid) {
            const peerFromParticipants = participants.find((jid) => {
                const jBase = toUserJid(jid);
                return jBase !== ourBase;
            });
            if (peerFromParticipants)
                rawPeerJid = peerFromParticipants;
        }
        const peerDeviceJid = this.ensureDeviceJid(rawPeerJid);
        try {
            const sendKeying = derivePerJidSrtpKey(callKey, ourDeviceJid);
            const recvKeying = derivePerJidSrtpKey(callKey, peerDeviceJid);
            this.srtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
            this.srtcpContext = new SrtcpContext(sendKeying);
            this.srtcpRecvSession = new SrtcpSession(recvKeying);
            this.logger.debug('srtp per-jid keys initialized', {
                callId: this.info.callId,
                sendJid: ourDeviceJid,
                recvJid: peerDeviceJid
            });
        }
        catch (err) {
            this.logger.debug('srtp key derivation failed', {
                callId: this.info.callId,
                message: toError(err).message
            });
        }
    }
    resetEncodeState() {
        this.encodeBuffer = null;
        this.encodeBufferPos = 0;
        this.realAudioSendCount = 0;
        this.audioReception.reset();
        this.opusCodec?.resetSequence();
    }
    onRelayConnected() {
        if (this.info.stateData.state === CallState.Connecting) {
            try {
                this.info.applyTransition({ type: 'media_connected' });
                this.delegate.emitState(this.info);
                this.startMediaFlow();
                this.announceInitialMuteState();
                this.logger.debug('relay connected, call active', { callId: this.info.callId });
            }
            catch (err) {
                this.logger.trace('call transition skipped', { message: toError(err).message });
            }
        }
    }
    onRelayData(data) {
        this.relayPacketCount++;
        if (isStunPacket(data)) {
            this.stunResponseCount++;
            return;
        }
        if (isRtcpPacket(data)) {
            if (!this.srtcpRecvSession)
                return;
            try {
                const rtcp = this.srtcpRecvSession.unprotect(data);
                const arrivedAt = Date.now();
                this.audioReception.observeSenderReport(rtcp, arrivedAt);
                this.videoReception.observeSenderReport(rtcp, arrivedAt);
                this.logger.trace('srtcp packet received', {
                    callId: this.info.callId,
                    packetType: rtcp[1],
                    feedbackFormat: rtcp[0] & 0x1f,
                    bytes: rtcp.length
                });
            }
            catch (err) {
                this.logger.trace('srtcp unprotect failed', {
                    callId: this.info.callId,
                    message: toError(err).message
                });
            }
            return;
        }
        if (!isRtpPacket(data))
            return;
        const pt = data[1] & 0x7f;
        if (!this.srtpSession)
            return;
        if (data.length >= 12) {
            const ssrc = readUInt32BE(data, 8);
            if (ssrc === this.selfSsrc || this.selfStreamSsrcs.includes(ssrc)) {
                this.selfEchoCount++;
                return;
            }
            if (this.peerAppDataSsrcs.has(ssrc)) {
                this.onAppDataPacket(data, pt, ssrc);
                return;
            }
            if (!this.ssrcResubscribed && this.actualPeerSsrc === null) {
                this.actualPeerSsrc = ssrc;
                const knownSsrc = this.peerSsrcs.includes(ssrc);
                if (!knownSsrc) {
                    this.peerSsrcs = [ssrc];
                    this.ssrcResubscribed = true;
                    this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
                    this.sctpRelay.resendSubscriptions();
                }
            }
        }
        try {
            const rtpPacket = this.srtpSession.unprotect(data);
            if (pt !== 120) {
                if (pt === 97) {
                    this.ensureVideoReceivePath();
                    this.videoRecvPackets++;
                    this.videoReception.observe(rtpPacket.header.ssrc, rtpPacket.header.sequenceNumber, rtpPacket.header.timestamp, Date.now());
                    this.videoRecvOctets += rtpPacket.payload.length;
                    this.sendReceiverEstimate(rtpPacket.header.ssrc);
                    if (this.videoRecvPackets === 1 || this.videoRecvPackets % 100 === 0) {
                        this.logger.debug('video packet received', {
                            callId: this.info.callId,
                            packets: this.videoRecvPackets,
                            payloadType: pt,
                            ssrc: `0x${rtpPacket.header.ssrc.toString(16)}`
                        });
                    }
                    if (this.videoRecvPackets <= 20) {
                        const nalType = rtpPacket.payload[0] & 0x1f;
                        const fuHeader = nalType === 28 && rtpPacket.payload.length > 1
                            ? rtpPacket.payload[1]
                            : 0;
                        this.logger.debug('video rtp details', {
                            callId: this.info.callId,
                            packet: this.videoRecvPackets,
                            sequenceNumber: rtpPacket.header.sequenceNumber,
                            timestamp: rtpPacket.header.timestamp,
                            marker: rtpPacket.header.marker,
                            nalType,
                            fuStart: (fuHeader & 0x80) !== 0,
                            fuEnd: (fuHeader & 0x40) !== 0,
                            bytes: rtpPacket.payload.length
                        });
                    }
                    if (!rtpPacket.payload.length)
                        return;
                    this.delegate.emitInboundVideoRtp(this.info, {
                        payloadType: pt,
                        sequenceNumber: rtpPacket.header.sequenceNumber,
                        timestamp: rtpPacket.header.timestamp,
                        ssrc: rtpPacket.header.ssrc,
                        marker: rtpPacket.header.marker,
                        payload: rtpPacket.payload
                    });
                    let depacketizer = this.h264Depacketizers.get(rtpPacket.header.ssrc);
                    if (!depacketizer) {
                        depacketizer = new H264Depacketizer();
                        setBoundedMapEntry(this.h264Depacketizers, rtpPacket.header.ssrc, depacketizer, MAX_H264_DEPACKETIZERS, (_ssrc, evicted) => evicted.reset());
                    }
                    const frames = depacketizer.push(rtpPacket.payload, rtpPacket.header.timestamp, rtpPacket.header.marker, rtpPacket.header.sequenceNumber);
                    for (const frame of frames) {
                        if (frame.keyFrame)
                            this.receivedVideoKeyFrame = true;
                        if (!this.receivedVideoKeyFrame &&
                            Date.now() - this.lastVideoPliAt >= 300) {
                            this.lastVideoPliAt = Date.now();
                            if (this.srtcpContext && this.videoRtpSession) {
                                const senderSsrc = this.videoRtpSession.getSsrc();
                                const pli = buildPictureLossIndication(senderSsrc, rtpPacket.header.ssrc, true);
                                this.sctpRelay.broadcast(toArrayBuffer(this.srtcpContext.protect(pli, senderSsrc)));
                                const fir = buildFullIntraRequest(senderSsrc, rtpPacket.header.ssrc, this.videoFirSequence++);
                                this.sctpRelay.broadcast(toArrayBuffer(this.srtcpContext.protect(fir, senderSsrc)));
                                this.logger.debug('video key frame requested', {
                                    callId: this.info.callId,
                                    mediaSsrc: `0x${rtpPacket.header.ssrc.toString(16)}`
                                });
                            }
                        }
                        this.logger.debug('video frame assembled', {
                            callId: this.info.callId,
                            timestamp: frame.timestamp,
                            keyFrame: frame.keyFrame,
                            bytes: frame.data.length
                        });
                        this.delegate.emitInboundVideo(this.info, {
                            codec: 'h264',
                            ssrc: rtpPacket.header.ssrc,
                            timestamp: frame.timestamp,
                            keyFrame: frame.keyFrame,
                            data: frame.data
                        });
                    }
                }
                else if (isReedSolomonFecPayloadType(pt)) {
                    const fecPackets = ++this.reedSolomonFecPackets;
                    if (fecPackets === 1 || fecPackets % 100 === 0) {
                        this.logger.debug('reed-solomon fec packet discarded', {
                            callId: this.info.callId,
                            packets: fecPackets,
                            payloadType: pt,
                            ssrc: `0x${rtpPacket.header.ssrc.toString(16)}`
                        });
                    }
                }
                return;
            }
            if (!this.opusCodec)
                return;
            const opusPayload = rtpPacket.payload;
            this.audioRecvCount++;
            const seq = rtpPacket.header.sequenceNumber;
            this.audioReception.observe(rtpPacket.header.ssrc, seq, rtpPacket.header.timestamp, Date.now());
            if (opusPayload.length === 0)
                return;
            const isDtx = opusPayload.length <= 2;
            if (isDtx)
                this.recvDtxCount++;
            else
                this.recvRealCount++;
            this.opusCodec.decodeSequenced(seq, opusPayload, this.onDecodedAudio);
            if (this.audioRecvCount % 100 === 0) {
                this.opusCodec.setExpectedPacketLossPercent(this.audioReception.lossPercent);
                const stats = this.opusCodec.getStats();
                this.logger.debug('audio recv stats', {
                    callId: this.info.callId,
                    recvCount: this.audioRecvCount,
                    real: this.recvRealCount,
                    dtx: this.recvDtxCount,
                    decodeOk: stats.success,
                    decodeErr: stats.errors,
                    plc: stats.plc,
                    fec: stats.fec,
                    late: stats.late
                });
            }
        }
        catch (err) {
            this.srtpErrorCount++;
            if (this.srtpErrorCount <= 5) {
                const ssrc = data.length >= 12 ? readUInt32BE(data, 8) : 0;
                this.logger.debug('srtp recv error', {
                    callId: this.info.callId,
                    errorCount: this.srtpErrorCount,
                    message: toError(err).message,
                    ssrc: `0x${ssrc.toString(16)}`
                });
            }
        }
    }
    async connectRelays(endpoints) {
        this.logger.debug('connecting relays', {
            callId: this.info.callId,
            endpointCount: endpoints.length
        });
        const seen = new Set();
        const uniqueEndpoints = [];
        for (const ep of endpoints) {
            if ((ep.protocol ?? 0) !== 0)
                continue;
            const key = `${ep.ip}:${ep.port}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueEndpoints.push(ep);
            }
        }
        const dialPort = (ep) => this.useOriginalRelayPort ? ep.port : TRUE_WEB_CLIENT_RELAY_PORT;
        const relays = uniqueEndpoints
            .filter((ep) => ep.key && ep.rawToken)
            .map((ep) => ({
            ip: ep.ip,
            port: dialPort(ep),
            token: ep.token,
            authToken: ep.authToken,
            rawAuthToken: ep.rawAuthToken,
            rawToken: ep.rawToken,
            key: ep.key,
            relayId: ep.relayId,
            name: ep.relayName || `${ep.ip}:${dialPort(ep)}`,
            authTokenId: ep.authTokenId,
            originalPort: ep.port
        }));
        if (relays.length === 0) {
            this.logger.error('no relay configs', { callId: this.info.callId });
            return;
        }
        this.sctpRelay.setSsrc(this.selfSsrc);
        this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
        this.sctpRelay.setStreamSsrcs(this.selfStreamSsrcs, this.peerStreamSsrcs);
        this.sctpRelay.setParticipantIds(this.info.relayData?.selfPid, this.info.relayData?.peerPid);
        try {
            await this.sctpRelay.configureRelays(relays);
            this.logger.debug('sctp relays configured', {
                callId: this.info.callId,
                connected: this.sctpRelay.getConnectedCount()
            });
        }
        catch (err) {
            this.logger.error('sctp relay error', {
                callId: this.info.callId,
                message: toError(err).message
            });
        }
    }
    startMediaFlow() {
        this.resetEncodeState();
        this.audioEngine.startPlayback();
        this.audioEngine.startCapture();
        if (!this.subscriptionRefreshInterval) {
            this.subscriptionRefreshInterval = setInterval(() => {
                this.sctpRelay.resendSubscriptions();
            }, 5000);
        }
    }
    sendSenderReport(senderSsrc, packetCount, octetCount, rtpTimestamp, reception, whatsappVideoProfile = false) {
        const srtcpContext = this.srtcpContext;
        if (!srtcpContext)
            return;
        let cname = this.rtcpCname;
        if (!cname) {
            cname = randomBytes(RTCP_CNAME_LENGTH);
            this.rtcpCname = cname;
        }
        try {
            const report = buildSenderReportWithSdes(senderSsrc, packetCount, octetCount, rtpTimestamp, cname, reception.report(Date.now()), undefined, true, whatsappVideoProfile);
            this.sctpRelay.broadcast(toArrayBuffer(srtcpContext.protect(report, senderSsrc)));
        }
        catch (err) {
            this.logger.trace('sender report send failed', {
                callId: this.info.callId,
                senderSsrc: `0x${senderSsrc.toString(16)}`,
                message: toError(err).message
            });
        }
    }
    sendReceiverEstimate(mediaSsrc) {
        const now = Date.now();
        if (this.receiverEstimateWindowStartedAt === 0) {
            this.receiverEstimateWindowStartedAt = now;
        }
        if (!this.receiverEstimateSchedule.shouldReport(now))
            return;
        const bitrate = nextReceiverMaxBitrate(this.receiverEstimateBitrate, this.videoRecvOctets, now - this.receiverEstimateWindowStartedAt, this.videoReception.lossPercent);
        this.receiverEstimateBitrate = bitrate;
        this.videoRecvOctets = 0;
        this.receiverEstimateWindowStartedAt = now;
        if (this.rtcpRembDisabled)
            return;
        const srtcpContext = this.srtcpContext;
        const videoRtpSession = this.videoRtpSession;
        if (!srtcpContext || !videoRtpSession)
            return;
        const senderSsrc = videoRtpSession.getSsrc();
        try {
            const remb = buildReceiverEstimatedMaxBitrate(senderSsrc, mediaSsrc, bitrate);
            this.sctpRelay.broadcast(toArrayBuffer(srtcpContext.protect(remb, senderSsrc)));
            this.logger.trace('receiver estimate sent', {
                callId: this.info.callId,
                mediaSsrc: `0x${mediaSsrc.toString(16)}`,
                bitrate
            });
        }
        catch (err) {
            this.logger.trace('receiver estimate send failed', {
                callId: this.info.callId,
                senderSsrc: `0x${senderSsrc.toString(16)}`,
                message: toError(err).message
            });
        }
    }
}

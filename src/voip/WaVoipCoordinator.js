import { WA_MESSAGE_TAGS } from './shim/protocol.js';
import { WaCallManager } from './call/WaCallManager.js';
import { routeCallAck, routeCallReceipt, routeCallStanza } from './signaling/bridge.js';
import { WA_VIDEO_STATE, WA_VIDEO_UPGRADE_RESULT } from './signaling/signaling.js';
import { WaVideoEngine } from './media/WaVideoEngine.js';
/**
 * WaClient-facing VOIP coordinator. Owns a {@link WaCallManager}, registers
 * incoming `<call>` / call-class `<ack>` / call `<receipt>` handlers (prepend,
 * returns `true`) so the core client does not double-ack, and re-emits manager
 * events on the host {@link WaClient}.
 */
/**
 * ffmpeg emits Annex-B access units that start with an Access Unit Delimiter NAL (type 9).
 * WhatsApp does not want it on the wire, so drop it and re-frame with 4-byte start codes.
 */
function stripAccessUnitDelimiters(au) {
    const starts = [];
    for (let i = 0; i + 3 < au.length;) {
        const four = au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 0 && au[i + 3] === 1;
        const three = au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1;
        if (four || three) {
            starts.push({ start: i, size: four ? 4 : 3 });
            i += four ? 4 : 3;
        }
        else
            i++;
    }
    const parts = [];
    for (let i = 0; i < starts.length; i++) {
        const from = starts[i].start + starts[i].size;
        const to = i + 1 < starts.length ? starts[i + 1].start : au.length;
        if (to <= from || (au[from] & 0x1f) === 9)
            continue;
        parts.push(au.subarray(from, to));
    }
    if (parts.length === 0)
        return null;
    const out = new Uint8Array(parts.reduce((n, part) => n + 4 + part.length, 0));
    let off = 0;
    for (const part of parts) {
        out.set([0, 0, 0, 1], off);
        out.set(part, off + 4);
        off += 4 + part.length;
    }
    return out;
}
export class WaVoipCoordinator {
    manager;
    deps;
    logger;
    unregisterHandlers = [];
    /** callId -> { engine, timestampUs } : ffmpeg-backed video sources (baileys-lite). */
    videoSources = new Map();
    /** callId -> { width, height, frameRate } requested at startCall. */
    videoConfigs = new Map();
    constructor(ctx, options = {}) {
        this.deps = ctx.deps;
        this.logger = ctx.logger.child({ scope: '@zapo-js/voip' }, { level: options.logLevel });
        this.manager = new WaCallManager({
            deps: ctx.deps,
            stores: ctx.stores,
            logger: this.logger,
            maxConcurrentCalls: options.maxConcurrentCalls,
            useOriginalRelayPort: options.useOriginalRelayPort,
            useRawUdpTransport: options.useRawUdpTransport
        });
        this.registerIncomingHandlers(ctx);
        this.wireClientEvents(ctx);
        this.wireVideoSources();
    }
    /**
     * Place an outgoing call to `options.peerJid` (optionally video, with a
     * preloaded `audioFile`). Resolves with the new call id once the offer is
     * sent; progress then arrives via `voip_call_state`. Rejects when at the
     * concurrent-call limit or if the offer fails to send.
     */
    async startCall(options) {
        const callId = await this.manager.startCall(options);
        if (options.videoConfig)
            this.videoConfigs.set(callId, options.videoConfig);
        return callId;
    }
    /**
     * Accept a ringing incoming call. Throws if `callId` is unknown or not in
     * an acceptable state.
     */
    async acceptCall(callId) {
        return this.manager.acceptCall(callId);
    }
    /**
     * Reject a ringing incoming call, optionally with an {@link EndCallReason}
     * (defaults to `Declined`). Sends the reject stanza, then tears the call
     * down.
     */
    async rejectCall(callId, reason) {
        return this.manager.rejectCall(callId, reason);
    }
    /**
     * End an active or connecting call, optionally with an {@link EndCallReason}
     * (defaults to `UserEnded`). Sends the terminate stanza, then tears the
     * call down. No-op if the call is unknown or already ended.
     */
    async endCall(callId, reason) {
        return this.manager.endCall(callId, reason);
    }
    /**
     * Preload an audio file (decoded via ffmpeg) as the outbound audio for
     * `callId`, played once the call is active. For an unbounded or live source
     * use {@link setExternalAudioMode} + {@link feedLiveAudio} instead. Needs
     * ffmpeg on PATH; throws if the file is missing or ffmpeg is unavailable.
     */
    async loadAudio(callId, audioPath) {
        return this.manager.loadAudio(callId, audioPath);
    }
    /**
     * Mute or unmute the local outbound audio for `callId` and announce it to the peer. A
     * no-op toggle, an inactive call and an unknown `callId` all do nothing.
     */
    setMute(callId, muted) {
        this.manager.setMute(callId, muted);
    }
    /**
     * Raise or lower the local hand on `callId` and announce it to the peer. Durable state:
     * the peer keeps seeing the hand until it is lowered. Repeating it sends nothing, an
     * inactive call is a no-op, and the peer's own hands are `voip_call_hand_raise` /
     * {@link CallInfo.raisedHands}. Throws on an unknown `callId` or a failed send.
     */
    async setHandRaised(callId, raised) {
        return this.manager.setHandRaised(callId, raised);
    }
    /**
     * Start or stop sharing the screen on `callId`, announcing it to the peer. Not a second
     * stream: the screen replaces the camera on the call's existing video stream, so
     * whatever reaches {@link feedLiveVideo} from here on is what the peer renders as the
     * share. Throws on an unknown `callId` or a failed send, and - starting a share only -
     * on a group call or one with no video yet ({@link requestVideoUpgrade} first).
     */
    async setScreenShare(callId, sharing) {
        return this.manager.setScreenShare(callId, sharing);
    }
    /**
     * Sends an emoji reaction on a call, as the glyph itself. Returns `false` when nothing
     * went on the wire: the call is not active, or its app-data stream is not open yet.
     */
    sendReaction(callId, reaction) {
        return this.manager.sendReaction(callId, reaction);
    }
    /**
     * Ask the peer to turn an audio call into a video call and wait for the answer. Resolves
     * with one of {@link WA_VIDEO_UPGRADE_RESULT}; only `accepted` means
     * {@link feedLiveVideo} now reaches the wire. Bounded by the peer's own guard timer, so
     * it settles in about five seconds even against a client that never answers. Throws on
     * an unknown `callId`, an inactive call, or one that already carries video.
     */
    async requestVideoUpgrade(callId) {
        return this.manager.requestVideoUpgrade(callId);
    }
    /**
     * Accept an upgrade the peer asked for on `callId`, turning the call into a video call
     * and opening the local video sender. The request arrives as a
     * `voip_call_peer_video_state` with `change.state` of `UpgradeRequestV2`; no-op when the
     * peer has none outstanding.
     */
    async acceptVideoUpgrade(callId) {
        return this.manager.acceptVideoUpgrade(callId);
    }
    /**
     * Decline an upgrade the peer asked for on `callId`, leaving the call on audio.
     * No-op when the peer has no request outstanding; throws if `callId` is unknown.
     */
    async rejectVideoUpgrade(callId) {
        return this.manager.rejectVideoUpgrade(callId);
    }
    /**
     * Withdraw an upgrade request sent from this side before the peer has answered it;
     * the pending {@link requestVideoUpgrade} then resolves with `cancelled`. No-op
     * when nothing is in flight; throws if `callId` is unknown.
     */
    async cancelVideoUpgrade(callId) {
        return this.manager.cancelVideoUpgrade(callId);
    }
    /**
     * Switch `callId` to external (live) audio mode. While enabled, outbound
     * audio comes from {@link feedLiveAudio} through a bounded jitter buffer
     * instead of a preloaded file. Disable to return to preloaded playback.
     */
    setExternalAudioMode(callId, enabled) {
        this.manager.setExternalAudioMode(callId, enabled);
    }
    /**
     * Feed a chunk of live mono PCM (`Float32Array` at the engine sample rate)
     * into an active call's outbound audio. Requires external audio mode (see
     * {@link setExternalAudioMode}). Returns the audio currently buffered
     * ahead of the sender in milliseconds, so a producer can pace itself
     * against {@link getFeedWatermarksMs}; returns `0` when no session exists
     * for `callId`. The buffer is bounded and drops the oldest samples on
     * overflow.
     */
    feedLiveAudio(callId, data) {
        return this.manager.feedLiveAudio(callId, data);
    }
    /**
     * Feed one H.264 Annex-B encoded access unit into an active video call.
     * `timestampUs` is the capture timestamp in microseconds. Returns the number
     * of RTP packets sent, or `0` when video media is not active.
     */
    feedLiveVideo(callId, data, timestampUs) {
        return this.manager.feedLiveVideo(callId, data, timestampUs);
    }
    /**
     * Milliseconds of live audio currently buffered ahead of the sender for
     * `callId` (`0` when no session exists or external mode is off). Poll it to
     * drive backpressure against {@link getFeedWatermarksMs}.
     */
    getLiveBufferMs(callId) {
        return this.manager.getLiveBufferMs(callId);
    }
    /**
     * Backpressure watermarks for the live feed, in milliseconds. Constants of
     * the feed contract, independent of any specific call: pause feeding once
     * {@link getLiveBufferMs} reaches `pauseMs`, resume once it drains to
     * `resumeMs`. `pauseMs` stays below the engine's internal drop threshold,
     * so a producer that respects it never loses audio.
     */
    getFeedWatermarksMs() {
        return this.manager.getFeedWatermarksMs();
    }
    /** Current {@link CallInfo} snapshot for `callId`, or `null` if unknown. */
    getCall(callId) {
        return this.manager.getCall(callId);
    }
    /** Snapshot of every tracked call (ringing, connecting, or active). */
    getCalls() {
        return this.manager.getCalls();
    }
    /**
     * Subscribe directly to a low-level {@link CallManagerEvents} event. Most
     * consumers should use the client-level `client.on('voip_*')` events
     * instead. Returns `this` for chaining.
     */
    on(event, listener) {
        this.manager.on(event, listener);
        return this;
    }
    /** Remove a listener registered via {@link on}. Returns `this`. */
    off(event, listener) {
        this.manager.off(event, listener);
        return this;
    }
    /** Like {@link on}, but the listener fires at most once. Returns `this`. */
    once(event, listener) {
        this.manager.once(event, listener);
        return this;
    }
    /**
     * Tear down the coordinator: unregister the incoming `<call>` / ack /
     * receipt handlers and destroy all active calls. Invoked by the plugin
     * system on client disconnect; not normally called directly.
     */
    dispose() {
        for (const unregister of this.unregisterHandlers.splice(0)) {
            unregister();
        }
        for (const callId of [...this.videoSources.keys()])
            this.dropVideoSource(callId);
        this.manager.destroy();
    }
    // ---- baileys-lite additions: play a video file as the call's camera ------------------
    // zapo only ships feedLiveVideo (you supply H.264 access units). The ffmpeg pipeline
    // that turns a file into those access units lives in media/WaVideoEngine.js.
    sessionOf(callId) {
        const session = this.manager.calls.get(callId);
        if (!session)
            throw new Error(`Unknown call ${callId}`);
        return session;
    }
    videoSourceOf(callId) {
        let entry = this.videoSources.get(callId);
        if (entry)
            return entry;
        const engine = new WaVideoEngine({ ...(this.videoConfigs.get(callId) ?? {}), logger: this.logger });
        entry = { engine, timestampUs: 0 };
        engine.setVideoSender({
            sendCapturedVideoAU: (au, durationMs) => {
                const session = this.manager.calls.get(callId);
                if (!session)
                    return;
                const payload = stripAccessUnitDelimiters(au);
                if (!payload)
                    return;
                entry.timestampUs += Math.round(durationMs * 1000);
                session.feedLiveVideo(payload, entry.timestampUs);
            }
        });
        this.videoSources.set(callId, entry);
        return entry;
    }
    dropVideoSource(callId) {
        const entry = this.videoSources.get(callId);
        if (!entry)
            return;
        entry.engine.stop();
        this.videoSources.delete(callId);
        this.videoConfigs.delete(callId);
    }
    /** Starts the ffmpeg source as soon as the call is active and able to send video. */
    maybeStartVideo(callId) {
        const entry = this.videoSources.get(callId);
        const session = this.manager.calls.get(callId);
        if (!entry || !session || entry.engine.isRunning() || !entry.engine.hasSource())
            return;
        if (!session.info.isActive || !session.videoSendActive)
            return;
        entry.engine.start();
    }
    wireVideoSources() {
        this.manager.on('call_state', (call) => this.maybeStartVideo(call.callId));
        this.manager.on('call_ended', (call) => this.dropVideoSource(call.callId));
    }
    /** Use `videoPath` as the camera (and loop its audio). Starts as soon as video can flow. */
    async loadVideo(callId, videoPath) {
        const session = this.sessionOf(callId);
        const entry = this.videoSourceOf(callId);
        entry.engine.stop({ keepSource: true });
        await entry.engine.loadVideoFile(videoPath);
        session.audioEngine?.setLoopMode?.(true);
        this.maybeStartVideo(callId);
    }
    /** Local only: make sure a source exists (black frames if none) and start it when allowed. */
    async enableVideoMidCall(callId) {
        this.sessionOf(callId);
        const entry = this.videoSourceOf(callId);
        if (!entry.engine.hasSource())
            await entry.engine.loadBlankSource();
        this.maybeStartVideo(callId);
    }
    disableVideoMidCall(callId, options = {}) {
        this.videoSources.get(callId)?.engine.stop({ keepSource: !!options.keepSource });
    }
    /**
     * Turn video on in the middle of a call. On an audio call this runs zapo's upgrade
     * handshake and only sends once the peer accepts; resolves with the handshake result
     * ({@link WA_VIDEO_UPGRADE_RESULT}). On a call that already carries video it just
     * re-announces the camera.
     */
    async startVideoMidCall(callId) {
        const session = this.sessionOf(callId);
        if (session.videoSendActive) {
            await session.sendVideoState(WA_VIDEO_STATE.Enabled).catch(() => { });
        }
        else {
            const result = await this.manager.requestVideoUpgrade(callId);
            if (result !== WA_VIDEO_UPGRADE_RESULT.Accepted)
                return result;
        }
        await this.enableVideoMidCall(callId);
        return WA_VIDEO_UPGRADE_RESULT.Accepted;
    }
    async stopVideoMidCall(callId, options = {}) {
        this.disableVideoMidCall(callId, options);
        const session = this.manager.calls.get(callId);
        if (session?.videoSendActive) {
            await session.sendVideoState(WA_VIDEO_STATE.Stopped).catch(() => { });
        }
    }
    registerIncomingHandlers(ctx) {
        this.unregisterHandlers.push(ctx.registerIncomingHandler({
            tag: 'call',
            prepend: true,
            handler: async (node) => {
                const tag = await routeCallStanza(this.manager, this.deps, node, this.logger);
                return tag !== null;
            }
        }), ctx.registerIncomingHandler({
            tag: WA_MESSAGE_TAGS.ACK,
            prepend: true,
            handler: async (node) => {
                if (node.attrs.class !== 'call') {
                    return false;
                }
                await routeCallAck(this.manager, node);
                return true;
            }
        }), ctx.registerIncomingHandler({
            tag: WA_MESSAGE_TAGS.RECEIPT,
            prepend: true,
            handler: async (node) => routeCallReceipt(this.deps, node)
        }));
    }
    wireClientEvents(ctx) {
        this.manager.on('call_state', (call) => {
            ctx.emit('voip_call_state', call);
        });
        this.manager.on('call_incoming', (call) => {
            ctx.emit('voip_call_incoming', call);
        });
        this.manager.on('call_ended', (call) => {
            ctx.emit('voip_call_ended', call);
        });
        this.manager.on('call_peer_mute', (call, muted) => {
            ctx.emit('voip_call_peer_mute', { call, muted });
        });
        this.manager.on('call_inbound_audio', (call, pcm) => {
            ctx.emit('voip_call_inbound_audio', { call, pcm });
        });
        this.manager.on('call_inbound_video_rtp', (call, packet) => {
            ctx.emit('voip_call_inbound_video_rtp', { call, packet });
        });
        this.manager.on('call_inbound_video', (call, frame) => {
            ctx.emit('voip_call_inbound_video', { call, frame });
        });
        this.manager.on('call_screen_share', (call, share) => {
            ctx.emit('voip_call_screen_share', { call, share });
        });
        this.manager.on('call_peer_video_state', (call, change) => {
            ctx.emit('voip_call_peer_video_state', { call, change });
        });
        this.manager.on('call_outbound_audio_finished', (call) => {
            ctx.emit('voip_call_outbound_audio_finished', call);
        });
        this.manager.on('call_hand_raise', (call, participantJid, raised) => {
            ctx.emit('voip_call_hand_raise', { call, participantJid, raised });
        });
        this.manager.on('call_reaction', (call, reaction) => {
            ctx.emit('voip_call_reaction', { call, reaction });
        });
        this.manager.on('call_error', (error) => {
            ctx.emit('voip_call_error', error);
        });
    }
}

import { EventEmitter } from 'node:events';
import { createNoopLogger } from '../shim/core.js';
import { isLidJid } from '../shim/protocol.js';
import { hasNodeChild } from '../shim/transport.js';
import { resolvePositive, toError } from '../shim/util.js';
import { generateCallKey } from '../crypto/encryption.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { buildOfferStanza, decryptCallKey, extractNodeInfo, generateCallId } from '../signaling/signaling.js';
import { parseVoipSettings } from '../signaling/voip-settings.js';
import { CallDirection, CallMediaType, EndCallReason } from '../types.js';
import { CallInfo } from './call-state.js';
import { WaCallMediaSession } from './WaCallMediaSession.js';
const DEFAULT_MAX_CONCURRENT_CALLS = 1;
export class WaCallManager extends EventEmitter {
    deps;
    stores;
    logger;
    maxConcurrentCalls;
    useOriginalRelayPort;
    useRawUdpTransport;
    calls = new Map();
    constructor(config) {
        super();
        this.deps = config.deps;
        this.stores = config.stores;
        this.logger = config.logger ?? createNoopLogger();
        this.maxConcurrentCalls = resolvePositive(config.maxConcurrentCalls, DEFAULT_MAX_CONCURRENT_CALLS, 'maxConcurrentCalls');
        this.useOriginalRelayPort = config.useOriginalRelayPort ?? false;
        this.useRawUdpTransport = config.useRawUdpTransport ?? false;
    }
    async startCall(options) {
        if (this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
        const callId = generateCallId();
        const mediaType = options.isVideo ? CallMediaType.Video : CallMediaType.Audio;
        const creds = this.deps.authClient.getCurrentCredentials();
        const callCreator = creds?.meLid || creds?.meJid || '';
        const peerJid = await this.resolvePeerLid(options.peerJid);
        const info = CallInfo.newOutgoing(callId, peerJid, callCreator, mediaType);
        const callKey = generateCallKey();
        info.encryptionKey = callKey;
        const session = this.createSession(info);
        try {
            session.resetOutgoingFlags();
            const selfLid = creds?.meLid || creds?.meJid || '';
            await session.initMedia(selfLid, peerJid);
            const offerStanza = await buildOfferStanza(this.deps, this.stores, callId, callKey, peerJid, options.isVideo ?? false, this.logger.child({ component: 'signaling' }));
            await this.deps.lowLevelCoordinator.sendNode(offerStanza);
        }
        catch (err) {
            session.cleanup();
            this.calls.delete(callId);
            throw err;
        }
        info.applyTransition({ type: 'offer_sent' });
        this.emitState(info);
        this.logger.debug('outgoing offer sent', { callId, peerJid });
        return callId;
    }
    async acceptCall(callId) {
        const session = this.getSessionOrThrow(callId);
        if (!session.info.canAccept) {
            throw new Error(`Call ${callId} cannot be accepted in state ${session.info.stateData.state}`);
        }
        await session.acceptCall();
    }
    async rejectCall(callId, reason = EndCallReason.Declined) {
        const session = this.getSessionOrThrow(callId);
        await session.rejectCall(reason);
        this.calls.delete(callId);
        await this.maybeUnblockWaitingCalls();
    }
    async endCall(callId, reason = EndCallReason.UserEnded) {
        const session = this.calls.get(callId);
        if (!session || session.info.isEnded)
            return;
        await session.endCall(reason);
        this.calls.delete(callId);
        await this.maybeUnblockWaitingCalls();
    }
    setMute(callId, muted) {
        this.calls.get(callId)?.setMute(muted);
    }
    async setHandRaised(callId, raised) {
        const session = this.getSessionOrThrow(callId);
        await session.setHandRaised(raised);
    }
    async setScreenShare(callId, sharing) {
        const session = this.getSessionOrThrow(callId);
        await session.setScreenShare(sharing);
    }
    sendReaction(callId, reaction) {
        const session = this.getSessionOrThrow(callId);
        return session.sendReaction(reaction);
    }
    requestVideoUpgrade(callId) {
        const session = this.getSessionOrThrow(callId);
        return session.requestVideoUpgrade();
    }
    async acceptVideoUpgrade(callId) {
        const session = this.getSessionOrThrow(callId);
        await session.acceptVideoUpgrade();
    }
    async rejectVideoUpgrade(callId) {
        const session = this.getSessionOrThrow(callId);
        await session.rejectVideoUpgrade();
    }
    async cancelVideoUpgrade(callId) {
        const session = this.getSessionOrThrow(callId);
        await session.cancelVideoUpgrade();
    }
    async loadAudio(callId, audioPath) {
        const session = this.getSessionOrThrow(callId);
        await session.loadAudio(audioPath);
    }
    setExternalAudioMode(callId, enabled) {
        const session = this.getSessionOrThrow(callId);
        session.setExternalAudioMode(enabled);
    }
    feedLiveAudio(callId, data) {
        const session = this.calls.get(callId);
        return session?.feedLiveAudio(data) ?? 0;
    }
    feedLiveVideo(callId, data, timestampUs) {
        return this.calls.get(callId)?.feedLiveVideo(data, timestampUs) ?? 0;
    }
    getLiveBufferMs(callId) {
        const session = this.calls.get(callId);
        return session?.getLiveBufferMs() ?? 0;
    }
    getFeedWatermarksMs() {
        return WaAudioEngine.feedWatermarksMs();
    }
    getCall(callId) {
        return this.calls.get(callId)?.info ?? null;
    }
    getCalls() {
        const result = [];
        for (const session of this.calls.values()) {
            result.push(session.info);
        }
        return result;
    }
    async handleCallOffer(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo?.callId)
            return;
        const callId = nodeInfo.callId;
        const existing = this.calls.get(callId);
        if (existing) {
            if (!existing.info.isEnded) {
                this.logger.debug('duplicate offer for active call, ignoring', { callId });
                return;
            }
            existing.cleanup();
            this.calls.delete(callId);
        }
        const callCreator = nodeInfo.innerNode.attrs?.['call-creator'] || peerJid;
        const callerPn = nodeInfo.innerNode.attrs?.['caller_pn'];
        const isVideo = hasNodeChild(nodeInfo.innerNode, 'video');
        const signalingLogger = this.logger.child({ component: 'signaling' });
        const callKey = await decryptCallKey(this.deps, nodeInfo.innerNode, peerJid, signalingLogger);
        const voipSettings = parseVoipSettings(node, signalingLogger);
        const { relays, participantJids, uuid, selfPid, peerPid, hbhKey } = parseRelayFromAck(nodeInfo.innerNode);
        const mediaType = isVideo ? CallMediaType.Video : CallMediaType.Audio;
        const info = CallInfo.newIncoming(callId, peerJid, callCreator, callerPn, mediaType);
        if (callKey) {
            info.encryptionKey = callKey;
        }
        if (relays.length > 0) {
            info.relayData = {
                endpoints: relays,
                participantJids,
                uuid,
                selfPid,
                peerPid,
                hbhKey
            };
        }
        const atCapacity = this.activeCallCount >= this.maxConcurrentCalls;
        const session = this.createSession(info, { acceptBlocked: atCapacity });
        session.applyVoipSettings(voipSettings);
        if (!atCapacity) {
            try {
                const creds = this.deps.authClient.getCurrentCredentials();
                const selfLid = creds?.meLid || creds?.meJid || '';
                const peerDeviceJids = await this.resolvePeerDeviceJids(peerJid);
                if (info.relayData) {
                    info.relayData.participantJids = [
                        ...peerDeviceJids,
                        ...(info.relayData.participantJids || []).filter((jid) => !peerDeviceJids.includes(jid))
                    ];
                }
                const mediaPeerJid = isVideo
                    ? peerDeviceJids.find((jid) => /:[1-9]\d*@/.test(jid)) || peerJid
                    : peerJid;
                await session.initMedia(selfLid, mediaPeerJid);
                await session.sendIncomingPreaccept(peerJid);
                await session.sendIncomingRelayLatency();
            }
            catch (err) {
                this.logger.error('incoming call activation failed', {
                    callId,
                    message: toError(err).message
                });
                try {
                    info.applyTransition({ type: 'terminated', reason: EndCallReason.Failed });
                }
                catch (transitionErr) {
                    this.logger.trace('failed-activation transition skipped', {
                        message: toError(transitionErr).message
                    });
                }
                this.emit('call_ended', info);
                this.emitState(info);
                session.cleanup();
                this.calls.delete(callId);
                await this.maybeUnblockWaitingCalls();
                return;
            }
        }
        else {
            this.logger.debug('incoming call waiting, at capacity', {
                callId,
                peerJid,
                maxConcurrentCalls: this.maxConcurrentCalls
            });
        }
        this.emit('call_incoming', info);
        this.emitState(info);
        this.logger.debug('incoming call', {
            callId,
            peerJid,
            callCreator,
            isVideo,
            relayCount: relays.length,
            acceptBlocked: atCapacity
        });
    }
    async handleCallAccept(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallAccept(node, peerJid);
    }
    async handleCallPreaccept(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallPreaccept(node, peerJid);
    }
    async handleCallTransport(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallTransport(node);
    }
    async handleCallAck(node) {
        const session = this.resolveSessionForOfferAck(node);
        if (!session)
            return;
        await session.handleCallAck(node);
    }
    async handleCallRelaylatency(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallRelaylatency(node, peerJid);
    }
    handleRelayElection(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleRelayElection(node);
    }
    handleCallMuteV2(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallMuteV2(node, peerJid);
    }
    handleCallUserAction(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallUserAction(node, peerJid);
    }
    /**
     * A top-level `<raise_hand>`: a message type of its own rather than a variant of
     * `<user_action>`, and both are live on the wire, so both have to route.
     */
    handleCallRaiseHand(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallRaiseHand(node, peerJid);
    }
    handleCallScreenShare(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallScreenShare(node);
    }
    handleCallVideoState(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallVideoState(node);
    }
    async handleCallTerminate(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        const action = Array.isArray(node.content)
            ? node.content.find((child) => child && typeof child === 'object' && child.tag === 'terminate')
            : undefined;
        this.logger.warn('remote terminated call', {
            callId: session.callId,
            stanzaId: node.attrs?.id,
            from: node.attrs?.from,
            terminateAttrs: action?.attrs ?? {}
        });
        if (session.shouldIgnoreTerminate(peerJid, action?.attrs?.reason)) {
            this.logger.debug('ignoring accepted_elsewhere from non-selected companion', {
                callId: session.callId,
                from: peerJid
            });
            return;
        }
        session.handleCallTerminate();
        this.calls.delete(session.callId);
        await this.maybeUnblockWaitingCalls();
    }
    destroy() {
        for (const session of this.calls.values()) {
            session.cleanup();
        }
        this.calls.clear();
        this.removeAllListeners();
    }
    get activeCallCount() {
        let count = 0;
        for (const session of this.calls.values()) {
            if (!session.info.isEnded && !session.info.isAcceptBlocked)
                count++;
        }
        return count;
    }
    createSession(info, options = {}) {
        const prior = this.calls.get(info.callId);
        if (prior) {
            if (!prior.info.isEnded) {
                throw new Error(`call ${info.callId} already exists`);
            }
            prior.cleanup();
            this.calls.delete(info.callId);
        }
        const acceptBlocked = options.acceptBlocked ?? false;
        if (!acceptBlocked && this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
        if (acceptBlocked) {
            info.stateData.acceptBlocked = true;
        }
        const sessionLogger = this.logger.child({ callId: info.callId });
        const session = new WaCallMediaSession({
            deps: this.deps,
            logger: sessionLogger,
            info,
            useOriginalRelayPort: this.useOriginalRelayPort,
            useRawUdpTransport: this.useRawUdpTransport,
            delegate: {
                emitState: (call) => this.emitState(call),
                emitIncoming: (call) => this.emit('call_incoming', call),
                emitEnded: (call) => this.emit('call_ended', call),
                emitPeerMute: (call, muted) => this.emit('call_peer_mute', call, muted),
                emitInboundAudio: (call, pcm) => this.emit('call_inbound_audio', call, pcm),
                emitInboundVideoRtp: (call, packet) => this.emit('call_inbound_video_rtp', call, packet),
                emitInboundVideo: (call, frame) => this.emit('call_inbound_video', call, frame),
                emitOutboundAudioFinished: (call) => this.emit('call_outbound_audio_finished', call),
                emitHandRaise: (call, participantJid, raised) => this.emit('call_hand_raise', call, participantJid, raised),
                emitCallReaction: (call, reaction) => this.emit('call_reaction', call, reaction),
                emitScreenShare: (call, share) => this.emit('call_screen_share', call, share),
                emitPeerVideoState: (call, change) => this.emit('call_peer_video_state', call, change),
                endCall: (call, reason) => {
                    this.endCall(call.callId, reason).catch((err) => {
                        this.logger.warn('ending a call with no media path failed', {
                            callId: call.callId,
                            message: toError(err).message
                        });
                    });
                }
            }
        });
        this.calls.set(info.callId, session);
        return session;
    }
    getSessionOrThrow(callId) {
        const session = this.calls.get(callId);
        if (!session) {
            throw new Error(`No call with id ${callId}`);
        }
        return session;
    }
    resolveSessionFromNode(node) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo?.callId) {
            this.logger.debug('stanza missing call-id, ignored');
            return null;
        }
        const session = this.calls.get(nodeInfo.callId);
        if (!session) {
            this.logger.debug('no session for call-id', { callId: nodeInfo.callId });
            return null;
        }
        return session;
    }
    resolveSessionForOfferAck(node) {
        const callId = node.attrs?.['call-id'];
        if (callId) {
            const session = this.calls.get(callId);
            if (session)
                return session;
        }
        const active = [];
        for (const session of this.calls.values()) {
            if (!session.info.isEnded && session.info.stateData.connectedAt === undefined) {
                active.push(session);
            }
        }
        // WhatsApp omits call-id from some offer ACKs sent after accepting an
        // incoming call. When there is only one live call, it is unambiguous
        // and the ACK contains the final relay participant/device metadata.
        if (active.length === 1)
            return active[0];
        this.logger.debug('offer ack could not be routed', {
            callId: callId ?? null,
            candidateCount: active.length
        });
        return null;
    }
    emitState(call) {
        this.emit('call_state', call);
    }
    async resolvePeerLid(peerJid) {
        if (isLidJid(peerJid))
            return peerJid;
        try {
            const [mapped] = await this.deps.signalDeviceSync.queryLidsByPhoneJids([peerJid]);
            if (mapped?.lidJid)
                return mapped.lidJid;
        }
        catch (err) {
            this.logger.trace('lid resolution failed', { message: toError(err).message });
        }
        return peerJid;
    }
    async resolvePeerDeviceJids(peerJid) {
        const primaryJid = /:\d+@/.test(peerJid) ? peerJid : peerJid.replace('@', ':0@');
        if (/:[1-9]\d*@/.test(peerJid))
            return [peerJid];
        try {
            const synced = await this.deps.signalDeviceSync.syncDeviceList([peerJid]);
            const devices = synced.flatMap((entry) => entry.deviceJids);
            const resolved = Array.from(new Set([primaryJid, ...devices]));
            if (resolved.length > 0) {
                this.logger.debug('incoming peer device resolved', {
                    peerJid,
                    peerDeviceJids: resolved,
                    deviceCount: resolved.length
                });
                return resolved;
            }
        }
        catch (err) {
            this.logger.trace('incoming peer device resolution failed', {
                peerJid,
                message: toError(err).message
            });
        }
        return [primaryJid];
    }
    async maybeUnblockWaitingCalls() {
        while (this.activeCallCount < this.maxConcurrentCalls) {
            const waiting = [...this.calls.values()].find((session) => session.info.direction === CallDirection.Incoming &&
                session.info.isRinging &&
                session.info.isAcceptBlocked);
            if (!waiting)
                break;
            await this.activateWaitingIncoming(waiting);
        }
    }
    async activateWaitingIncoming(session) {
        session.info.stateData.acceptBlocked = false;
        const creds = this.deps.authClient.getCurrentCredentials();
        const selfLid = creds?.meLid || creds?.meJid || '';
        const peerDeviceJids = await this.resolvePeerDeviceJids(session.info.peerJid);
        if (session.info.relayData) {
            session.info.relayData.participantJids = [
                ...peerDeviceJids,
                ...(session.info.relayData.participantJids || []).filter((jid) => !peerDeviceJids.includes(jid))
            ];
        }
        const mediaPeerJid = session.info.mediaType === CallMediaType.Video
            ? peerDeviceJids.find((jid) => /:[1-9]\d*@/.test(jid)) || session.info.peerJid
            : session.info.peerJid;
        await session.initMedia(selfLid, mediaPeerJid);
        await session.sendIncomingPreaccept(session.info.peerJid);
        await session.sendIncomingRelayLatency();
        this.emitState(session.info);
        this.logger.debug('waiting incoming call unblocked', { callId: session.callId });
    }
}

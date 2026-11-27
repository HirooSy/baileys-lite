import { access } from 'node:fs/promises';
import { decodePcm16 } from '../../ffmpeg/index.js';
import { createNoopLogger } from '../shim/core.js';
import { DEFAULT_AUDIO_CONFIG } from '../types.js';
const MAX_DECODE_BYTES = 128 * 1024 * 1024;
function createSelfCorrectingInterval(callback, intervalMs) {
    let expected = performance.now() + intervalMs;
    let timer = null;
    let stopped = false;
    function tick() {
        if (stopped) return;
        if (performance.now() - expected > intervalMs * 3) {
            expected = performance.now();
        }
        callback();
        expected += intervalMs;
        timer = setTimeout(tick, Math.max(0, expected - performance.now()));
    }
    timer = setTimeout(tick, intervalMs);
    return {
        clear() {
            stopped = true;
            if (timer) clearTimeout(timer);
        }
    };
}
export class WaAudioEngine {
    logger;
    audioSender = null;
    audioBuffer = null;
    audioScale = 1;
    audioPosition = 0;
    audioFinished = false;
    onAudioFinished = null;
    playbackInterval = null;
    captureInterval = null;
    circularBuffer;
    bufferWritePos = 0;
    bufferReadPos = 0;
    bufferLength = 0;
    sampleRate;
    captureChunkSize;
    maxBuffer;
    outputSize;
    intervalMs;
    silenceMode = false;
    externalMode = false;
    loopMode = false;
    liveWritePos = 0;
    extStarted = false;
    extPreBufferSize;
    extTargetBuffer;
    extHighWater;
    extMaxBuffer;
    captureChunkBuffer;
    silenceChunkBuffer;
    playbackOutputBuffer;
    constructor(config = {}) {
        const c = { ...DEFAULT_AUDIO_CONFIG, ...config };
        this.logger = config.logger ?? createNoopLogger();
        this.sampleRate = c.sampleRate;
        this.captureChunkSize = c.captureChunkSize;
        this.maxBuffer = c.maxBufferSize;
        this.outputSize = c.playbackOutputSize;
        this.intervalMs = c.intervalMs;
        this.circularBuffer = new Float32Array(this.maxBuffer);
        this.captureChunkBuffer = new Float32Array(this.captureChunkSize);
        this.silenceChunkBuffer = new Float32Array(this.captureChunkSize);
        this.playbackOutputBuffer = new Float32Array(this.outputSize);
        this.extPreBufferSize = Math.floor(this.sampleRate * 0.06);
        this.extTargetBuffer = Math.floor(this.sampleRate * 0.06);
        this.extHighWater = Math.floor(this.sampleRate * 0.2);
        this.extMaxBuffer = Math.floor(this.sampleRate);
    }
    setAudioSender(sender) {
        this.audioSender = sender;
    }
    setLoopMode(enabled) {
        this.loopMode = enabled;
    }
    setOnAudioFinished(callback) {
        this.onAudioFinished = callback;
    }
    setExternalMode(enabled) {
        this.externalMode = enabled;
        this.extStarted = false;
        if (enabled) {
            this.audioBuffer = new Float32Array(this.extMaxBuffer);
            this.audioScale = 1;
            this.audioPosition = 0;
            this.liveWritePos = 0;
            this.audioFinished = false;
        }
    }
    isExternalMode() {
        return this.externalMode;
    }
    feedExternalAudio(data) {
        if (!this.externalMode || !this.audioBuffer)
            return 0;
        let incoming = data;
        if (incoming.length > this.extMaxBuffer) {
            incoming = incoming.subarray(incoming.length - this.extMaxBuffer);
        }
        if (this.liveWritePos + incoming.length > this.audioBuffer.length) {
            const unconsumed = this.liveWritePos - this.audioPosition;
            if (unconsumed > 0 && this.audioPosition > 0) {
                this.audioBuffer.copyWithin(0, this.audioPosition, this.liveWritePos);
            }
            this.liveWritePos = Math.max(0, unconsumed);
            this.audioPosition = 0;
        }
        const overflow = this.liveWritePos + incoming.length - this.extMaxBuffer;
        if (overflow > 0) {
            const drop = Math.min(overflow, this.liveWritePos);
            if (drop > 0) {
                this.audioBuffer.copyWithin(0, drop, this.liveWritePos);
                this.liveWritePos -= drop;
            }
        }
        this.audioBuffer.set(incoming, this.liveWritePos);
        this.liveWritePos += incoming.length;
        return ((this.liveWritePos - this.audioPosition) / this.sampleRate) * 1000;
    }
    getLiveBufferMs() {
        if (!this.externalMode || !this.audioBuffer)
            return 0;
        return ((this.liveWritePos - this.audioPosition) / this.sampleRate) * 1000;
    }
    static feedWatermarksMs() {
        return {
            pauseMs: 120,
            resumeMs: 60
        };
    }
    isAudioFinished() {
        return this.audioFinished;
    }
    async loadSource(source) {
        await this.loadAudioFile(source);
    }
    async loadAudioFile(audioPath) {
        this.setExternalMode(false);
        try {
            await access(audioPath);
        }
        catch {
            throw new Error(`File not found: ${audioPath}`);
        }
        this.audioBuffer = null;
        this.audioBuffer = await decodePcm16(audioPath, { sampleRate: this.sampleRate, channels: 1, maxBytes: MAX_DECODE_BYTES });
        if (!this.audioBuffer) {
            throw new Error(`Could not decode audio: ${audioPath}`);
        }
        this.audioScale = 1 / 32768;
        this.audioPosition = 0;
        this.audioFinished = false;
    }
    generateTestTone(frequency = 440, duration = 3, amplitude = 0.3) {
        const samples = this.sampleRate * duration;
        this.audioBuffer = new Float32Array(samples);
        this.audioScale = 1;
        this.audioPosition = 0;
        this.audioFinished = false;
        for (let i = 0; i < samples; i++) {
            const t = i / this.sampleRate;
            this.audioBuffer[i] = Math.sin(2 * Math.PI * frequency * t) * amplitude;
        }
    }
    startPlayback() {
        if (this.playbackInterval) {
            return;
        }
        this.resetBuffer();
        this.playbackInterval = createSelfCorrectingInterval(() => {
            this.readFromBuffer(this.outputSize);
        }, this.intervalMs);
    }
    stopPlayback() {
        if (this.playbackInterval) {
            this.playbackInterval.clear();
            this.playbackInterval = null;
        }
    }
    onPlaybackData(audioData) {
        this.writeToBuffer(audioData);
    }
    startSilenceCapture() {
        if (this.captureInterval) {
            return;
        }
        this.silenceMode = true;
        this.captureInterval = createSelfCorrectingInterval(() => {
            if (this.audioSender) {
                try {
                    this.audioSender.sendCapturedAudio(this.silenceChunkBuffer);
                }
                catch { }
            }
        }, this.intervalMs);
    }
    startCapture() {
        if (this.captureInterval && this.silenceMode) {
            this.captureInterval.clear();
            this.captureInterval = null;
        }
        if (this.captureInterval) {
            return;
        }
        this.silenceMode = false;
        if (this.externalMode) {
            this.audioPosition = Math.max(0, this.liveWritePos - this.extPreBufferSize);
            const available = this.liveWritePos - this.audioPosition;
            this.extStarted = available >= this.extPreBufferSize;
        }
        else {
            this.audioPosition = 0;
        }
        this.captureInterval = createSelfCorrectingInterval(() => {
            const chunk = this.getNextChunk();
            if (this.audioSender) {
                try {
                    this.audioSender.sendCapturedAudio(chunk);
                }
                catch { }
            }
        }, this.intervalMs);
    }
    stopCapture() {
        if (this.captureInterval) {
            this.captureInterval.clear();
            this.captureInterval = null;
        }
    }
    stop() {
        this.stopPlayback();
        this.stopCapture();
    }
    release() {
        this.stop();
        this.audioBuffer = null;
        this.audioPosition = 0;
        this.liveWritePos = 0;
        this.resetBuffer();
    }
    hasAudio() {
        return this.audioBuffer !== null && this.audioBuffer.length > 0;
    }
    resetBuffer() {
        this.bufferWritePos = 0;
        this.bufferReadPos = 0;
        this.bufferLength = 0;
    }
    writeToBuffer(data) {
        for (let i = 0; i < data.length && this.bufferLength < this.maxBuffer; i++) {
            this.circularBuffer[this.bufferWritePos] = data[i];
            this.bufferWritePos = (this.bufferWritePos + 1) % this.maxBuffer;
            this.bufferLength++;
        }
    }
    readFromBuffer(count) {
        this.playbackOutputBuffer.fill(0);
        for (let i = 0; i < count; i++) {
            if (this.bufferLength > 0) {
                this.playbackOutputBuffer[i] = this.circularBuffer[this.bufferReadPos];
                this.bufferReadPos = (this.bufferReadPos + 1) % this.maxBuffer;
                this.bufferLength--;
            }
        }
        return this.playbackOutputBuffer;
    }
    getNextChunk() {
        if (!this.audioBuffer) {
            return this.silenceChunkBuffer;
        }
        const endPos = this.externalMode ? this.liveWritePos : this.audioBuffer.length;
        if (endPos === 0 || (this.audioFinished && !this.externalMode)) {
            return this.silenceChunkBuffer;
        }
        if (this.externalMode) {
            const available = endPos - this.audioPosition;
            if (!this.extStarted) {
                if (available < this.extPreBufferSize) {
                    return this.silenceChunkBuffer;
                }
                this.extStarted = true;
            }
            if (available > this.extHighWater) {
                this.audioPosition = endPos - this.extTargetBuffer;
            }
            if (this.audioPosition >= endPos) {
                return this.silenceChunkBuffer;
            }
        }
        this.captureChunkBuffer.fill(0);
        for (let i = 0; i < this.captureChunkSize; i++) {
            if (this.audioPosition >= endPos) {
                if (this.loopMode && !this.externalMode && endPos > 0) {
                    this.audioPosition = 0;
                    if (this.audioPosition >= endPos) break;
                    continue;
                }
                if (!this.externalMode && !this.audioFinished) {
                    this.audioFinished = true;
                    if (this.onAudioFinished) {
                        const cb = this.onAudioFinished;
                        setTimeout(() => cb(), 0);
                    }
                }
                break;
            }
            this.captureChunkBuffer[i] = this.audioBuffer[this.audioPosition] * this.audioScale;
            this.audioPosition++;
        }
        return this.captureChunkBuffer;
    }
}

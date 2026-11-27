import { createNoopLogger } from '../shim/core.js';
import { DEFAULT_VIDEO_CONFIG } from '../types.js';
const UNSUPPORTED_MESSAGE = 'Video is not supported by the built-in media engine.';
export class WaVideoEngine {
    logger;
    videoSender = null;
    width;
    height;
    frameRate;
    frameDurationMs;
    constructor(config = {}) {
        const c = { ...DEFAULT_VIDEO_CONFIG, ...config };
        this.logger = config.logger ?? createNoopLogger();
        this.width = c.width;
        this.height = c.height;
        this.frameRate = c.frameRate;
        this.frameDurationMs = 1000 / this.frameRate;
    }
    setVideoSender(sender) {
        this.videoSender = sender;
    }
    isRunning() {
        return false;
    }
    hasSource() {
        return false;
    }
    async loadVideoFile() {
        throw new Error(UNSUPPORTED_MESSAGE);
    }
    async loadBlankSource() {
        throw new Error(UNSUPPORTED_MESSAGE);
    }
    start() { }
    stop() { }
}

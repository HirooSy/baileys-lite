import { WaSctpRelay } from './WaSctpRelay.js';

export class WaWrtcRelay extends WaSctpRelay {
    videoSsrc = 0;

    setSsrc(ssrc) {
        super.setSsrc(ssrc);
        this.#syncStreams();
    }

    setVideoSsrc(ssrc) {
        this.videoSsrc = ssrc || 0;
        this.#syncStreams();
    }

    setStreamSsrcs(selfSsrcs, peerSsrcs) {
        super.setStreamSsrcs(selfSsrcs, peerSsrcs);
    }

    getSendBacklog() {
        let total = 0;
        for (const conn of this.connections.values()) {
            const buffered = conn.channel?.bufferedAmount;
            if (typeof buffered === 'number') total += buffered;
        }
        return total;
    }

    #syncStreams() {
        const self = [this.audioSsrc, this.videoSsrc].filter(Boolean);
        if (self.length) this.selfStreamSsrcs = self;
    }
}

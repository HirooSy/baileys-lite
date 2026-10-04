const START_CODE = new Uint8Array([0, 0, 0, 1]);
const NAL_TYPE_IDR = 5;
export function packetizeH264AnnexB(data, maxPayload = 1100) {
    if (maxPayload < 3)
        throw new Error('H264 RTP payload size must be at least 3 bytes');
    const starts = [];
    for (let i = 0; i + 3 < data.length;) {
        const four = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
        const three = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
        if (four || three) {
            starts.push({ start: i, size: four ? 4 : 3 });
            i += four ? 4 : 3;
        }
        else
            i++;
    }
    const nals = [];
    if (!starts.length && data.length)
        nals.push(data);
    for (let i = 0; i < starts.length; i++) {
        const from = starts[i].start + starts[i].size;
        const to = i + 1 < starts.length ? starts[i + 1].start : data.length;
        if (to > from)
            nals.push(data.subarray(from, to));
    }
    const payloads = [];
    for (const nal of nals) {
        if (nal.length <= maxPayload) {
            payloads.push(nal);
            continue;
        }
        const indicator = (nal[0] & 0xe0) | 28;
        const nalType = nal[0] & 0x1f;
        const chunkSize = maxPayload - 2;
        for (let offset = 1; offset < nal.length; offset += chunkSize) {
            const end = Math.min(nal.length, offset + chunkSize);
            const payload = new Uint8Array(2 + end - offset);
            payload[0] = indicator;
            payload[1] = nalType | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
            payload.set(nal.subarray(offset, end), 2);
            payloads.push(payload);
        }
    }
    return payloads;
}
export function isH264KeyFrame(data) {
    let startCodes = 0;
    for (let i = 0; i + 3 < data.length;) {
        if (data[i] === 0 && data[i + 1] === 0) {
            if (data[i + 2] === 1) {
                startCodes++;
                if ((data[i + 3] & 0x1f) === NAL_TYPE_IDR)
                    return true;
                i += 4;
                continue;
            }
            if (data[i + 2] === 0 && data[i + 3] === 1) {
                startCodes++;
                if (i + 4 < data.length && (data[i + 4] & 0x1f) === NAL_TYPE_IDR)
                    return true;
                i += 5;
                continue;
            }
        }
        i++;
    }
    if (!startCodes && data.length)
        return (data[0] & 0x1f) === NAL_TYPE_IDR;
    return false;
}
const SEQUENCE_MODULUS = 0x10000;
export class H264Depacketizer {
    static MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
    static NO_FU_RUN = -1;
    timestamp = null;
    parts = [];
    nalHeaders = [];
    fuParts = [];
    fuNalType = H264Depacketizer.NO_FU_RUN;
    fuLastSequence = H264Depacketizer.NO_FU_RUN;
    bufferedBytes = 0;
    push(payload, timestamp, marker, sequenceNumber) {
        if (!payload.length)
            return [];
        const completed = [];
        let previous = null;
        if (this.timestamp !== null && this.timestamp !== timestamp) {
            previous = this.flush();
            this.resetFrame(timestamp);
        }
        if (previous)
            completed.push(previous);
        if (this.timestamp === null)
            this.timestamp = timestamp;
        if (this.bufferedBytes + payload.length + START_CODE.length >
            H264Depacketizer.MAX_BUFFERED_BYTES) {
            this.resetFrame(timestamp);
            return completed;
        }
        const type = payload[0] & 0x1f;
        if (type >= 1 && type <= 23)
            this.appendNal(payload);
        else if (type === 24)
            this.appendStapA(payload);
        else if (type === 28)
            this.appendFuA(payload, sequenceNumber);
        else
            return completed;
        if (marker && !this.fuParts.length) {
            const current = this.flush();
            if (current)
                completed.push(current);
        }
        return completed;
    }
    reset() {
        this.timestamp = null;
        this.parts = [];
        this.nalHeaders.length = 0;
        this.fuParts = [];
        this.fuNalType = H264Depacketizer.NO_FU_RUN;
        this.fuLastSequence = H264Depacketizer.NO_FU_RUN;
        this.bufferedBytes = 0;
    }
    resetFrame(timestamp) {
        this.parts = [];
        this.nalHeaders.length = 0;
        this.fuParts = [];
        this.fuNalType = H264Depacketizer.NO_FU_RUN;
        this.fuLastSequence = H264Depacketizer.NO_FU_RUN;
        this.timestamp = timestamp;
        this.bufferedBytes = 0;
    }
    appendNal(nal) {
        if (this.bufferedBytes + START_CODE.length + nal.length >
            H264Depacketizer.MAX_BUFFERED_BYTES) {
            this.resetFrame(this.timestamp ?? 0);
            return;
        }
        this.parts.push(START_CODE, nal.slice());
        this.nalHeaders.push(nal[0]);
        this.bufferedBytes += START_CODE.length + nal.length;
    }
    appendStapA(payload) {
        let offset = 1;
        while (offset + 2 <= payload.length) {
            const size = (payload[offset] << 8) | payload[offset + 1];
            offset += 2;
            if (!size || offset + size > payload.length)
                break;
            this.appendNal(payload.subarray(offset, offset + size));
            offset += size;
        }
    }
    appendFuA(payload, sequenceNumber) {
        if (payload.length < 2)
            return;
        const indicator = payload[0];
        const header = payload[1];
        const start = (header & 0x80) !== 0;
        const end = (header & 0x40) !== 0;
        const nalType = header & 0x1f;
        if (start) {
            for (const part of this.fuParts)
                this.bufferedBytes -= part.length;
            this.fuParts = [new Uint8Array([(indicator & 0xe0) | nalType]), payload.slice(2)];
            this.fuNalType = nalType;
            this.fuLastSequence = sequenceNumber;
            this.bufferedBytes += payload.length - 1;
        }
        else if (this.fuNalType === nalType) {
            if (sequenceNumber === (this.fuLastSequence + 1) % SEQUENCE_MODULUS) {
                this.fuParts.push(payload.slice(2));
                this.fuLastSequence = sequenceNumber;
                this.bufferedBytes += payload.length - 2;
            }
            else {
                for (const part of this.fuParts)
                    this.bufferedBytes -= part.length;
                this.fuParts = [];
                this.fuNalType = H264Depacketizer.NO_FU_RUN;
                this.fuLastSequence = H264Depacketizer.NO_FU_RUN;
                return;
            }
        }
        else {
            return;
        }
        if (end) {
            this.parts.push(START_CODE, ...this.fuParts);
            this.nalHeaders.push(this.fuParts[0][0]);
            this.fuParts = [];
            this.fuNalType = H264Depacketizer.NO_FU_RUN;
            this.fuLastSequence = H264Depacketizer.NO_FU_RUN;
        }
    }
    flush() {
        if (!this.parts.length || this.timestamp === null)
            return null;
        const size = this.parts.reduce((sum, part) => sum + part.length, 0);
        const data = new Uint8Array(size);
        let offset = 0;
        for (const part of this.parts) {
            data.set(part, offset);
            offset += part.length;
        }
        let keyFrame = false;
        for (let index = 0; index < this.nalHeaders.length; index++) {
            if ((this.nalHeaders[index] & 0x1f) === NAL_TYPE_IDR) {
                keyFrame = true;
                break;
            }
        }
        const result = { timestamp: this.timestamp, data, keyFrame };
        this.reset();
        return result;
    }
}

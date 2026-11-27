async function attempt(task) {
  try {
    const [{ run }, { probe }] = await Promise.all([import('./lib/pipeline.js'), import('./lib/probe.js')]);
    return await task(run, probe);
  } catch {
    return null;
  }
}

function parsePcm16Wav(buffer, channels) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = { tag: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.bits !== 16 || format.channels !== channels || (format.tag !== 1 && format.tag !== 0xfffe)) return null;
      const length = Math.floor((Math.min(body + size, buffer.length) - body) / 2) * 2;
      if ((buffer.byteOffset + body) % 2 === 0) return new Int16Array(buffer.buffer, buffer.byteOffset + body, length / 2);
      const bytes = new Uint8Array(length);
      bytes.set(buffer.subarray(body, body + length));
      return new Int16Array(bytes.buffer);
    }
    offset = body + size + (size & 1);
  }
  return null;
}

async function toPcm16(run, input, info, sampleRate, channels, maxBytes) {
  const bytes = (info.format.duration || 0) * sampleRate * channels * 2;
  const source = info.streams.find((s) => s.type === 'audio')?.channels;
  if (bytes > maxBytes || (source > 2 && source !== channels)) return null;
  const { output } = await run({ input, output: { format: 'wav' }, sampleRate, channels, codec: 'pcm_s16le', sizeHint: Math.ceil(bytes * 1.02) + 65536 });
  return output.length > maxBytes + 1024 ? null : parsePcm16Wav(output, channels);
}

export const probeNative = (input) => attempt((run, probe) => probe(input));

export const decodePcm16 = (input, { sampleRate, channels = 1, maxBytes = Infinity }) =>
  attempt(async (run, probe) => toPcm16(run, input, await probe(input), sampleRate, channels, maxBytes));

export const decodeFirstChannel = (input) =>
  attempt(async (run, probe) => {
    const info = await probe(input);
    const channels = info.streams.find((s) => s.type === 'audio')?.channels;
    const pcm = channels ? await toPcm16(run, input, info, 16000, channels, Infinity) : null;
    if (!pcm) return null;
    const mono = new Float32Array(Math.floor(pcm.length / channels));
    for (let i = 0; i < mono.length; i++) mono[i] = pcm[i * channels] / 32768;
    return mono;
  });

export const imageThumb = (input, width) =>
  attempt(async (run, probe) => {
    const { streams } = await probe(input);
    return {
      buffer: (await run({ input, output: { format: 'jpg' }, videoFilter: `scale=w='min(${width},iw)':h=-2`, qscale: 12, maxPixels: 16e6 })).output,
      original: { width: streams[0].width, height: streams[0].height },
    };
  });

import fs from 'node:fs';
import pathMod from 'node:path';
import { badArg, noSupport } from '../errors.js';
import { detectImage, probeImage, decodeImage, decodeGifFrame, encodeImage, subsamplingOf, codecNames } from './index.js';
import { parseFilters, applyFilters } from '../filter/video.js';

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

async function loadInput(src) {
  if (Buffer.isBuffer(src)) return src;
  if (src instanceof Uint8Array) return Buffer.from(src.buffer, src.byteOffset, src.length);
  if (typeof src === 'string') return fs.promises.readFile(src);
  throw badArg('invalid image input');
}

function pickFrame(buf, opts) {
  if (detectImage(buf) === 'gif') return decodeGifFrame(buf, opts.startSec);
  return decodeImage(buf);
}

async function runImage(opts, format) {
  if (opts.inputs.length !== 1) throw badArg('image output accepts exactly one input');
  const toFile = typeof opts.output === 'string';
  const src = opts.inputs[0];
  let abs = null;
  if (toFile) {
    abs = pathMod.resolve(opts.output);
    if (typeof src === 'string' && pathMod.resolve(src) === abs) throw badArg('output must differ from input');
    if (!opts.overwrite && fs.existsSync(abs)) throw badArg('output exists: ' + opts.output);
  }
  const buf = await loadInput(src);
  const info = probeImage(buf);
  if (!info) throw noSupport('unsupported image input');
  if (opts.maxPixels && info.width * info.height > opts.maxPixels) throw noSupport('image is too large for native processing');
  const filters = parseFilters(opts.videoFilter);
  const hints = {};
  await yieldLoop();
  let frame = pickFrame(buf, opts);
  await yieldLoop();
  frame = applyFilters(frame, filters, hints);
  await yieldLoop();
  const sub = subsamplingOf(opts.pixFmt || hints.pixFmt);
  const encodeOptions = {};
  if (opts.qscale !== undefined) encodeOptions.qscale = opts.qscale;
  if (opts.quality !== undefined) encodeOptions.quality = opts.quality;
  if (opts.compressionLevel !== undefined) encodeOptions.level = opts.compressionLevel;
  if (sub) Object.assign(encodeOptions, sub);
  const out = encodeImage(frame, format, encodeOptions);
  const result = { format, size: out.length, duration: 0, streams: [{ index: 0, type: 'video', codec: codecNames[format] }] };
  if (toFile) {
    try {
      await fs.promises.writeFile(abs, out);
    } catch (e) {
      try {
        await fs.promises.unlink(abs);
      } catch (ignored) {
        result.cleanup = false;
      }
      throw e;
    }
    delete result.cleanup;
    result.output = opts.output;
  } else result.output = out;
  return result;
}

export { runImage };

/**
 * Public sync API: `read(buffer, options)` / `write(png, options)` — mirrors `pngjs`'s PNG.sync.
 * Vendored from `pngjs` 7.0.0 (MIT). Only require()/module.exports converted to import/export
 * (zlib/util/assert/buffer -> node: specifiers). See ./LICENSE.
 * Algorithm body unchanged vs. upstream md5 57db1eb23be674e473fa48a26b493ca7.
 * https://github.com/pngjs/pngjs
 */
"use strict";

import parse from './parser-sync.js'
import pack from './packer-sync.js'

export const read = function (buffer, options) {
  return parse(buffer, options || {});
};

export const write = function (png, options) {
  return pack(png, options);
};

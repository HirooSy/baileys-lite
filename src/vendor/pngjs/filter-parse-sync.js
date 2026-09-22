/**
 * Synchronous driver for filter-parse.js: unfilters a whole IDAT buffer at once.
 * Vendored from `pngjs` 7.0.0 (MIT). Only require()/module.exports converted to import/export. See ./LICENSE.
 * Algorithm body unchanged vs. upstream md5 6b0d6b55fd9979ecf821a282c4310756.
 * https://github.com/pngjs/pngjs
 */
"use strict";

import SyncReader from './sync-reader.js'
import Filter from './filter-parse.js'

export const process = function (inBuffer, bitmapInfo) {
  let outBuffers = [];
  let reader = new SyncReader(inBuffer);
  let filter = new Filter(bitmapInfo, {
    read: reader.read.bind(reader),
    write: function (bufferPart) {
      outBuffers.push(bufferPart);
    },
    complete: function () {},
  });

  filter.start();
  reader.process();

  return Buffer.concat(outBuffers);
};

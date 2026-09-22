/**
 * Synchronous whole-buffer PNG encode entry point: signature + IHDR + gAMA + deflated IDAT + IEND.
 * Vendored from `pngjs` 7.0.0 (MIT). Only require()/module.exports converted to import/export
 * (zlib/util/assert/buffer -> node: specifiers). See ./LICENSE.
 * Algorithm body unchanged vs. upstream md5 51da0119926dab0998788987873fc853.
 * https://github.com/pngjs/pngjs
 */
"use strict";

let hasSyncZlib = true;
import zlib from 'node:zlib'
if (!zlib.deflateSync) {
  hasSyncZlib = false;
}
import constants from './constants.js'
import Packer from './packer.js'

const packSync = function (metaData, opt) {
  if (!hasSyncZlib) {
    throw new Error(
      "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
    );
  }

  let options = opt || {};

  let packer = new Packer(options);

  let chunks = [];

  // Signature
  chunks.push(Buffer.from(constants.PNG_SIGNATURE));

  // Header
  chunks.push(packer.packIHDR(metaData.width, metaData.height));

  if (metaData.gamma) {
    chunks.push(packer.packGAMA(metaData.gamma));
  }

  let filteredData = packer.filterData(
    metaData.data,
    metaData.width,
    metaData.height
  );

  // compress it
  let compressedData = zlib.deflateSync(
    filteredData,
    packer.getDeflateOptions()
  );
  filteredData = null;

  if (!compressedData || !compressedData.length) {
    throw new Error("bad png - invalid compressed data response");
  }
  chunks.push(packer.packIDAT(compressedData));

  // End
  chunks.push(packer.packIEND());

  return Buffer.concat(chunks);
};

export default packSync;

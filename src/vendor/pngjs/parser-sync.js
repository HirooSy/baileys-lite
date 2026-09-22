/**
 * Synchronous whole-buffer PNG decode entry point: parse chunks, zlib-inflate IDAT, unfilter, bitmap, normalise.
 * Vendored from `pngjs` 7.0.0 (MIT). Only require()/module.exports converted to import/export
 * (zlib/util/assert/buffer -> node: specifiers). See ./LICENSE.
 * Algorithm body unchanged vs. upstream md5 dc170d369c632b306a208ae9527d9c5a.
 * https://github.com/pngjs/pngjs
 */
"use strict";

let hasSyncZlib = true;
import zlib from 'node:zlib'
import inflateSync from './sync-inflate.js'
if (!zlib.deflateSync) {
  hasSyncZlib = false;
}
import SyncReader from './sync-reader.js'
import * as FilterSync from './filter-parse-sync.js'
import Parser from './parser.js'
import * as bitmapper from './bitmapper.js'
import formatNormaliser from './format-normaliser.js'

const parseSync = function (buffer, options) {
  if (!hasSyncZlib) {
    throw new Error(
      "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
    );
  }

  let err;
  function handleError(_err_) {
    err = _err_;
  }

  let metaData;
  function handleMetaData(_metaData_) {
    metaData = _metaData_;
  }

  function handleTransColor(transColor) {
    metaData.transColor = transColor;
  }

  function handlePalette(palette) {
    metaData.palette = palette;
  }

  function handleSimpleTransparency() {
    metaData.alpha = true;
  }

  let gamma;
  function handleGamma(_gamma_) {
    gamma = _gamma_;
  }

  let inflateDataList = [];
  function handleInflateData(inflatedData) {
    inflateDataList.push(inflatedData);
  }

  let reader = new SyncReader(buffer);

  let parser = new Parser(options, {
    read: reader.read.bind(reader),
    error: handleError,
    metadata: handleMetaData,
    gamma: handleGamma,
    palette: handlePalette,
    transColor: handleTransColor,
    inflateData: handleInflateData,
    simpleTransparency: handleSimpleTransparency,
  });

  parser.start();
  reader.process();

  if (err) {
    throw err;
  }

  //join together the inflate datas
  let inflateData = Buffer.concat(inflateDataList);
  inflateDataList.length = 0;

  let inflatedData;
  if (metaData.interlace) {
    inflatedData = zlib.inflateSync(inflateData);
  } else {
    let rowSize =
      ((metaData.width * metaData.bpp * metaData.depth + 7) >> 3) + 1;
    let imageSize = rowSize * metaData.height;
    inflatedData = inflateSync(inflateData, {
      chunkSize: imageSize,
      maxLength: imageSize,
    });
  }
  inflateData = null;

  if (!inflatedData || !inflatedData.length) {
    throw new Error("bad png - invalid inflate data response");
  }

  let unfilteredData = FilterSync.process(inflatedData, metaData);
  inflateData = null;

  let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
  unfilteredData = null;

  let normalisedBitmapData = formatNormaliser(
    bitmapData,
    metaData,
    options.skipRescale
  );

  metaData.data = normalisedBitmapData;
  metaData.gamma = gamma || 0;

  return metaData;
};

export default parseSync;

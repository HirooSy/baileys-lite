/**
 * Queues fixed-length read requests and satisfies them from an in-memory buffer (no real streaming).
 * Vendored from `pngjs` 7.0.0 (MIT). Only require()/module.exports converted to import/export
 * (zlib/util/assert/buffer -> node: specifiers). See ./LICENSE.
 * Algorithm body unchanged vs. upstream md5 2f8cd5d2a5f159a57f163a5fad634463.
 * https://github.com/pngjs/pngjs
 */
"use strict";

let SyncReader = function (buffer) {
  this._buffer = buffer;
  this._reads = [];
};

SyncReader.prototype.read = function (length, callback) {
  this._reads.push({
    length: Math.abs(length), // if length < 0 then at most this length
    allowLess: length < 0,
    func: callback,
  });
};

SyncReader.prototype.process = function () {
  // as long as there is any data and read requests
  while (this._reads.length > 0 && this._buffer.length) {
    let read = this._reads[0];

    if (
      this._buffer.length &&
      (this._buffer.length >= read.length || read.allowLess)
    ) {
      // ok there is any data so that we can satisfy this request
      this._reads.shift(); // == read

      let buf = this._buffer;

      this._buffer = buf.slice(read.length);

      read.func.call(this, buf.slice(0, read.length));
    } else {
      break;
    }
  }

  if (this._reads.length > 0) {
    throw new Error("There are some read requests waitng on finished stream");
  }

  if (this._buffer.length > 0) {
    throw new Error("unrecognised content at end of stream");
  }
};

export default SyncReader;

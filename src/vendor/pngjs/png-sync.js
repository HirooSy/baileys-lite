"use strict";

import parse from './parser-sync.js'
import pack from './packer-sync.js'

export const read = function (buffer, options) {
  return parse(buffer, options || {});
};

export const write = function (png, options) {
  return pack(png, options);
};

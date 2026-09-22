/**
 * Paeth predictor (PNG filter type 4) used by both the parser and packer.
 * Vendored from `pngjs` 7.0.0 (MIT). Only require()/module.exports converted to import/export. See ./LICENSE.
 * Algorithm body unchanged vs. upstream md5 05b33c66f5c16acd9267747c40a24054.
 * https://github.com/pngjs/pngjs
 */
"use strict";

export default function paethPredictor(left, above, upLeft) {
  let paeth = left + above - upLeft;
  let pLeft = Math.abs(paeth - left);
  let pAbove = Math.abs(paeth - above);
  let pUpLeft = Math.abs(paeth - upLeft);

  if (pLeft <= pAbove && pLeft <= pUpLeft) {
    return left;
  }
  if (pAbove <= pUpLeft) {
    return above;
  }
  return upLeft;
};

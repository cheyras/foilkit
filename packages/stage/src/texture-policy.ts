// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Texture policy — cap by on-screen size, share by URL.
//
// A 300px tile has no use for a 600w scan, and at three hundred cards the face
// textures are the budget: the GLSL is close to free next to them. Two rules
// carry it:
//
//   1. Decode at a size chosen from the card's on-screen box, bucketed to
//      powers of two so a grid of slightly-different tiles does not produce a
//      different decode each.
//   2. Key the cache by URL, so two tiles showing the same card upload once.
//
// KTX2/Basis is deliberately out of scope. Compressed textures mean a new
// pipeline stage plus a ~200KB client transcoder; resolution capping and a
// shared cache are measured first, and are very likely sufficient.

/** Upper bound on any face texture edge. A card face is never worth more. */
export const MAX_FACE_TEXTURE_PX = 1024
/** Lower bound — below this a card face is mush regardless of its box. */
export const MIN_FACE_TEXTURE_PX = 64

export interface TextureBudgetOptions {
  /** Device pixel ratio, already capped by the stage. Default 1. */
  pixelRatio?: number
  /** Headroom over the on-screen size, so a card can grow a little without a
   *  re-decode. Default 1.25. */
  oversample?: number
  max?: number
  min?: number
}

/**
 * The decode width for a face shown at `cssWidth` CSS px.
 *
 * Bucketed UP to a power of two: a virtualized grid resizes tiles by a few px
 * as the scrollbar appears and disappears, and a policy that tracked the exact
 * box would re-decode the whole screen when it did.
 */
export function faceTextureWidth(cssWidth: number, options: TextureBudgetOptions = {}): number {
  const pixelRatio = options.pixelRatio ?? 1
  const oversample = options.oversample ?? 1.25
  const max = options.max ?? MAX_FACE_TEXTURE_PX
  const min = options.min ?? MIN_FACE_TEXTURE_PX
  const want = Math.max(1, cssWidth) * pixelRatio * oversample
  const bucket = 2 ** Math.ceil(Math.log2(Math.max(want, min)))
  return Math.max(min, Math.min(max, bucket))
}

/** Masks never need face resolution, and never benefit from it. */
export const MAX_MASK_TEXTURE_PX = 512

/**
 * The rasterisation width for a card's MASK at `cssWidth` CSS px.
 *
 * `uMaskTex` is low-frequency alpha — the feather is 0.008 UV, which at any
 * plausible size is several pixels wide — so a mask matched to the face's
 * resolution would spend memory on detail the shader immediately blurs away.
 * Half the face budget, capped lower.
 *
 * This is what makes a VECTOR mask the right stored form: the geometry is
 * resolution-independent, so the stage picks a size and the mask is rasterised
 * to it client-side. Mask resizing never becomes a question, and no stored
 * raster is ever the wrong size for the box it lands in.
 */
export function maskTextureWidth(cssWidth: number, options: TextureBudgetOptions = {}): number {
  return faceTextureWidth(cssWidth, {
    ...options,
    oversample: (options.oversample ?? 1.25) * 0.5,
    max: options.max ?? MAX_MASK_TEXTURE_PX,
  })
}

/**
 * Should an already-decoded texture be replaced by a larger decode?
 *
 * Only ever upward, and only past a whole bucket — a card that shrinks keeps
 * the bigger texture it already has, because throwing it away costs an upload
 * and saves memory nobody was short of.
 */
export function needsLargerDecode(haveWidth: number, wantWidth: number): boolean {
  return wantWidth > haveWidth
}

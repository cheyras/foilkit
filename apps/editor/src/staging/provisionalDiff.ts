// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The PROVISIONAL local diff.
//
// A staged session has no `derivation_method`, no agreement number and no diff
// artifact until it is submitted, because `writeMaskRecord` derives all three
// server-side by diffing the saved pixels against what the declared seed
// actually rasterizes to. That is correct — the client must never label a mask
// — but it would mean editing entirely blind for a whole session, which is a
// poor experience and, worse, hides the one number that tells a contributor
// whether they are improving the rule or fighting it.
//
// So: the client owns the rasterizer. It can compute the same number offline.
// It is labelled PROVISIONAL everywhere it is shown, and the server's answer
// replaces it at submit. It never enters a session record, never rides a
// payload, and is never persisted — a provisional number that got written down
// would eventually be read as a measured one.
//
// ── A PORT, WITH A PARITY TEST ─────────────────────────────────────────────
//
// `rasterizePriorAlpha` and `diffMask` live in `@foilkit/forge`, but that
// module reaches `./png.ts` which reaches `node:zlib` — it cannot be imported
// into a browser bundle. So the two functions below are a deliberate
// line-for-line port of the forge originals, and `provisionalDiff.test.ts`
// asserts byte-equality against the real implementations over a spread of
// rects, radii and inversions. If forge's rasterizer moves and this one does
// not, that test fails, which is the only way a port stays a port.

/** alpha >= 128 counts as foil (strokes are ~binary). Forge's FOIL_THRESHOLD. */
export const FOIL_THRESHOLD = 128

export interface PriorGeometry {
  /** UV y-up [x, y, w, h] — exactly what `maskForScope()` returns. */
  rect: [number, number, number, number]
  /** Corner radius as a fraction of card WIDTH. */
  radius: number
  invert: boolean
}

/**
 * Rasterize the deterministic era-rule prior to an alpha plane.
 *
 * PORT OF `@foilkit/forge` `rasterizePriorAlpha`. Same rounded-rect SDF the
 * shader and `MaskEditor` use, same 1 px antialiased edge, same rounding.
 */
export function rasterizePriorAlpha(width: number, height: number, prior: PriorGeometry): Uint8Array {
  const [rx, ryUp, rw, rh] = prior.rect
  // UV y-up rect → pixel-space y-down rect.
  const px = rx * width
  const py = (1 - ryUp - rh) * height
  const pw = rw * width
  const ph = rh * height
  const rad = Math.min(prior.radius * width, pw / 2, ph / 2)
  const cx = px + pw / 2
  const cy = py + ph / 2
  const hw = pw / 2
  const hh = ph / 2

  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const qx = Math.abs(x + 0.5 - cx) - hw + rad
      const qy = Math.abs(y + 0.5 - cy) - hh + rad
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
      const inside = Math.min(Math.max(qx, qy), 0)
      const d = outside + inside - rad
      let cov = Math.min(1, Math.max(0, 0.5 - d))
      if (prior.invert) cov = 1 - cov
      alpha[y * width + x] = Math.round(cov * 255)
    }
  }
  return alpha
}

export interface ProvisionalStats {
  addedPx: number
  removedPx: number
  unchangedPx: number
  /** unchanged ÷ union. 1 when both planes are empty. */
  agreement: number
  /** ALWAYS true here. Present so a caller cannot forget which number this is. */
  provisional: true
}

/**
 * Diff a drawn mask's alpha against a rasterized plane.
 *
 * PORT OF `@foilkit/forge` `diffMask`'s statistics half. The visual PNG the
 * server produces is not reproduced — the editor already draws the mask over
 * the card, which is a better picture of the same thing than a red/green
 * bitmap, and it is live.
 */
export function diffAlpha(handAlpha: Uint8Array, priorAlpha: Uint8Array): ProvisionalStats {
  if (handAlpha.length !== priorAlpha.length) throw new Error('prior/hand size mismatch')
  let addedPx = 0
  let removedPx = 0
  let unchangedPx = 0
  for (let i = 0; i < priorAlpha.length; i++) {
    const inHand = handAlpha[i]! >= FOIL_THRESHOLD
    const inPrior = priorAlpha[i]! >= FOIL_THRESHOLD
    if (inHand && inPrior) unchangedPx++
    else if (inHand) addedPx++
    else if (inPrior) removedPx++
  }
  const union = unchangedPx + addedPx + removedPx
  return {
    addedPx,
    removedPx,
    unchangedPx,
    agreement: union === 0 ? 1 : Number((unchangedPx / union).toFixed(4)),
    provisional: true,
  }
}

/** The alpha channel of an RGBA buffer — what a canvas `getImageData` hands back. */
export function alphaOfRgba(rgba: Uint8ClampedArray | Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i++) out[i] = rgba[i * 4 + 3]!
  return out
}

/**
 * The two numbers a session can honestly show while it is being worked on.
 *
 *  * `vsRule` — the drawn mask against the DETERMINISTIC era rule. This is the
 *    codify score: how wrong the shared rule is on this printing, which is what
 *    makes the work worth doing to anyone but this card's owner.
 *  * `vsParent` — the drawn mask against the mask this session was seeded from.
 *    This is the correction signal: what the human changed relative to what
 *    they were given. Null when the session started from the layout rule,
 *    because there is nothing to have changed.
 */
export interface ProvisionalReport {
  vsRule: ProvisionalStats
  vsParent: ProvisionalStats | null
  /** Did the human actually put a stroke down? Cheap, conservative version of
   *  forge's `countPaintedOver`; see the note below about the seam band. */
  changed: boolean
}

export function provisionalReport(
  handAlpha: Uint8Array,
  ruleGeom: PriorGeometry,
  width: number,
  height: number,
  parentAlpha: Uint8Array | null,
): ProvisionalReport {
  const rule = rasterizePriorAlpha(width, height, ruleGeom)
  const vsRule = diffAlpha(handAlpha, rule)
  const vsParent = parentAlpha === null ? null : diffAlpha(handAlpha, parentAlpha)
  // "Changed" against the thing the session actually started from. Against a
  // rasterized rect this over-reports slightly in the 1 px antialiasing seam —
  // forge's `countPaintedOver` spends a 3×3 neighbourhood test to exclude it,
  // and reproducing that here would be claiming a precision this number is not
  // allowed to have. The server decides `derivation_method`; this only decides
  // whether to enable a button.
  const basis = vsParent ?? vsRule
  return { vsRule, vsParent, changed: basis.addedPx + basis.removedPx > 0 }
}

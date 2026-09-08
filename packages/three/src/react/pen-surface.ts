// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// foil/pen-surface.ts — the DOM half of the pen, minus the DOM.
//
// `PenEditor.tsx` is a React component and therefore only testable through a browser, which is
// the exact bargain `pen-engine.ts` refused to make for the pen's behaviour. Everything the
// surface does that is arithmetic rather than rendering lives here instead: turning a
// PointerEvent into a `PenInput`, sizing chrome so it stays the same size on SCREEN at every
// zoom, and rasterising the pen document into mask alpha. Plain functions over plain values,
// driven by `node --test` in a millisecond.
//
// THE THREE THINGS THIS FILE EXISTS TO GET RIGHT:
//
//   * ONE SCALE FACTOR, NAMED ONCE. `screenPerDoc` is screen pixels per document unit, and it
//     is read off `getBoundingClientRect()` of the displayed overlay — which already carries
//     both the card's on-screen size AND the view controller's CSS zoom, exactly as
//     `MaskEditor.toMask` relies on. So POSITION needs no zoom term, and everything measured in
//     screen pixels — hit radii, anchor squares, handle dots, line widths — is divided by it.
//     Two different conversions, one factor, and neither of them is a second source of truth.
//
//   * THE MASK RASTER GOES THROUGH `rasterizePolygons`, THE SAME FUNCTION THE TEMPLATES AND THE
//     FITTED MASKS GO THROUGH. A second rasteriser in the editor would mean the preview and the
//     committed artifact disagree at every hole, and the disagreement would only ever show up
//     after a save. Nonzero winding is inherited with it: overlapping subpaths wound the same
//     way union, wound opposite they cut a hole, which is how one mask carries several regions.
//
//   * NO CHROME IN THE RASTER, STRUCTURALLY. `rasterizePenDoc` takes a `PenDoc` and nothing
//     else — not the selection, not the hover, not the rubber band — so there is no value it
//     could consult to draw a handle into the artifact even by accident. The chrome renders to
//     a separate SVG layer that never touches these bytes. That is not a convention to remember;
//     it is the function signature, and `pen-surface.test.ts` asserts the halo around a filled
//     square stays empty while its anchors are selected and hovered.

import {
  flattenPath,
  rasterizePolygons,
  toVPath,
  type PenDoc,
  type PenInput,
  type PenMods,
  type Vec,
} from '@foilkit/forge/geometry'

/** The overlay's on-screen box. `DOMRect` structurally, so a test can pass a literal. */
export interface DisplayRect {
  left: number
  top: number
  width: number
  height: number
}

/** The subset of a PointerEvent the normaliser reads. Structural so tests need no DOM. */
export interface PointerLike {
  clientX: number
  clientY: number
  button?: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  /**
   * Narrowed to the one modifier that is read, deliberately: React types this as
   * `(key: ModifierKey) => boolean`, and a `(key: string) => boolean` parameter would be
   * contravariantly incompatible with it — so a widened signature here makes every call site
   * cast, which is how the CapsLock read quietly becomes optional.
   */
  getModifierState?: (key: 'CapsLock') => boolean
}

/** The subset of a KeyboardEvent the normaliser reads. */
export interface KeyLike {
  key: string
  code?: string
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  getModifierState?: (key: 'CapsLock') => boolean
}

/**
 * Screen pixels per document unit.
 *
 * `rect` is the DISPLAYED box of the overlay, so at 2x view zoom it is already twice as wide and
 * this is already twice as large. `docWidth` is the canonical mask width. Guarded against a
 * zero-width rect because a card that has not been laid out yet would otherwise divide the whole
 * surface by zero and put every anchor at infinity.
 */
export function screenPerDoc(rect: DisplayRect, docWidth: number): number {
  return rect.width > 0 ? rect.width / docWidth : 1
}

/**
 * Client coordinates -> DOCUMENT coordinates.
 *
 * The same trick `MaskEditor.toMask` uses: the rect of the *displayed* element already accounts
 * for the CSS transform the view controller applies, so there is no zoom term here. Passing the
 * card's un-zoomed rect instead is the classic version of this bug — it works perfectly at 1x
 * and puts every anchor in the wrong place the moment anyone zooms.
 */
export function docPoint(
  rect: DisplayRect,
  clientX: number,
  clientY: number,
  docWidth: number,
  docHeight: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  return {
    x: ((clientX - rect.left) / rect.width) * docWidth,
    y: ((clientY - rect.top) / rect.height) * docHeight,
  }
}

/**
 * Modifier state, including the two the engine needs that no event property carries.
 *
 * `capsLock` comes from `getModifierState('CapsLock')` — there is no `event.capsLockKey`, and
 * Caps Lock replacing every cursor with a bare crosshair (spec I.93) is the number one cause of
 * "my pen cursor turned into an X", so a surface that cannot see it cannot explain it. `space`
 * is tracked by the surface itself, because the browser reports Space as a key event and never
 * as a modifier, and the engine needs to know it is HELD, not that it was pressed.
 */
export function penMods(
  e: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; getModifierState?: (k: 'CapsLock') => boolean },
  space: boolean,
): PenMods {
  return {
    alt: e.altKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    space,
    capsLock: e.getModifierState?.('CapsLock') ?? false,
  }
}

/** A pointer event as the engine's input. `zoom` is screen px per document unit — see above. */
export function pointerInput(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  e: PointerLike,
  rect: DisplayRect,
  docWidth: number,
  docHeight: number,
  space: boolean,
): PenInput {
  return {
    type,
    point: docPoint(rect, e.clientX, e.clientY, docWidth, docHeight),
    button: e.button ?? 0,
    mods: penMods(e, space),
    zoom: screenPerDoc(rect, docWidth),
  }
}

/**
 * A keyboard event as the engine's input.
 *
 * `key` is passed through untouched apart from Space: `KeyboardEvent.key` for the spacebar is
 * `' '`, which `PenInput` documents as accepted, but a keyboard layout that reports `'Spacebar'`
 * exists in the wild and `e.code` is the reliable one. Normalising here means the engine never
 * has to know which browser it is in.
 */
export function keyInput(
  type: 'keydown' | 'keyup',
  e: KeyLike,
  rect: DisplayRect,
  docWidth: number,
  space: boolean,
): PenInput {
  return {
    type,
    key: e.code === 'Space' ? ' ' : e.key,
    mods: penMods(e, space),
    zoom: screenPerDoc(rect, docWidth),
  }
}

/**
 * Chrome sizes in SCREEN pixels — spec F.3, conformance item 100.
 *
 * These are the only numbers in the surface that are allowed to be literals, and they are here
 * rather than in the component so the test that proves they stay screen-constant does not have
 * to render React to find them.
 */
export const PEN_CHROME_PX = Object.freeze({
  /** Half-width of an anchor square. Illustrator's default is a 4px-ish box. */
  anchor: 3,
  /** Radius of a direction point. */
  handleDot: 3,
  /** Direction lines — deliberately thinner than the path outline. */
  directionLine: 1,
  /** The path outline and the rubber band. Spec A.4: 1px, selection colour, no stroke attrs. */
  outline: 1.25,
  /** The marquee's dash length. */
  marqueeDash: 4,
  /** Multiplier applied to the anchor under the pointer (*Highlight anchors on mouse over*). */
  hoverBoost: 1.7,
})

export interface PenChromeMetrics {
  anchor: number
  handleDot: number
  directionLine: number
  outline: number
  marqueeDash: number
  hoverAnchor: number
}

/**
 * `PEN_CHROME_PX` converted into DOCUMENT units for a given scale.
 *
 * Every field is `px / scale`, which is the whole of item 100: at 4x zoom the scale is four
 * times larger, the document-space size is four times smaller, and the thing on screen is
 * exactly the same size it was at 1x. Chrome that scales with the artwork is the tell that an
 * editor was written by someone who only ever tested at 100%.
 */
export function chromeMetrics(scale: number): PenChromeMetrics {
  const s = scale > 0 ? scale : 1
  return {
    anchor: PEN_CHROME_PX.anchor / s,
    handleDot: PEN_CHROME_PX.handleDot / s,
    directionLine: PEN_CHROME_PX.directionLine / s,
    outline: PEN_CHROME_PX.outline / s,
    marqueeDash: PEN_CHROME_PX.marqueeDash / s,
    hoverAnchor: (PEN_CHROME_PX.anchor * PEN_CHROME_PX.hoverBoost) / s,
  }
}

/** Flattening tolerance, document units. A tenth of a mask pixel is well under the raster grid. */
export const PEN_SAGITTA = 0.1
/** Supersampling rows per pixel, matching `rasterizeTemplate`'s default. */
export const PEN_SUPERSAMPLE = 4

/**
 * The pen document as fill loops.
 *
 * A subpath needs three anchors before it encloses anything, so one- and two-point paths
 * contribute nothing — they are a path being started, not a region. An OPEN path with three or
 * more anchors DOES contribute, implicitly closed, because that is precisely what closing it
 * would produce and the live preview is only useful if it previews the answer rather than the
 * empty set. `rasterizePolygons` closes every loop it is handed anyway; saying so here is what
 * stops the next reader from "fixing" it.
 */
export function penLoops(doc: PenDoc, sagitta: number = PEN_SAGITTA): Vec[][] {
  const loops: Vec[][] = []
  for (const path of doc.paths) {
    if (path.points.length < 3) continue
    loops.push(flattenPath(toVPath(path), sagitta))
  }
  return loops
}

/**
 * The pen document as mask alpha, through the SHARED rasteriser.
 *
 * Takes a document and nothing else. There is no selection, no hover and no rubber band in this
 * signature, so no amount of future carelessness can bake a handle into the artifact — the
 * chrome is not reachable from here. See the header.
 */
export function rasterizePenDoc(
  doc: PenDoc,
  width: number,
  height: number,
  supersample: number = PEN_SUPERSAMPLE,
  sagitta: number = PEN_SAGITTA,
): Uint8Array {
  return rasterizePolygons(penLoops(doc, sagitta), width, height, supersample)
}

/**
 * Alpha coverage -> RGBA bytes, in place.
 *
 * The mask canvas's ALPHA is the mask; RGB is only the on-screen tint (`MaskEditor`'s header
 * says the same thing about the same canvas). Writing the tint at full strength and modulating
 * only alpha is what keeps a saved PNG's colour channel constant, so a diff of two masks is a
 * diff of coverage rather than of anti-aliased colour.
 */
export function paintAlpha(rgba: Uint8ClampedArray | Uint8Array, alpha: Uint8Array, rgb: [number, number, number]): void {
  for (let i = 0; i < alpha.length; i++) {
    const o = i * 4
    rgba[o] = rgb[0]
    rgba[o + 1] = rgb[1]
    rgba[o + 2] = rgb[2]
    rgba[o + 3] = alpha[i]!
  }
}

/**
 * The pen document as an SVG `d` attribute, for the chrome layer's path outline.
 *
 * A segment whose two facing handles are retracted is emitted as `L` rather than a degenerate
 * `C`, for the same reason `toVPath` emits a `LinePrim`: a straight edge should read as a
 * straight edge in whatever form you are looking at it in.
 */
export function penPathD(doc: PenDoc): string[] {
  const out: string[] = []
  for (const path of doc.paths) {
    const pts = path.points
    if (pts.length === 0) continue
    let d = `M ${pts[0]!.anchor[0]} ${pts[0]!.anchor[1]}`
    const segs = pts.length < 2 ? 0 : path.closed ? pts.length : pts.length - 1
    for (let i = 0; i < segs; i++) {
      const a = pts[i]!
      const b = pts[(i + 1) % pts.length]!
      const straight =
        a.rightDirection[0] === a.anchor[0] &&
        a.rightDirection[1] === a.anchor[1] &&
        b.leftDirection[0] === b.anchor[0] &&
        b.leftDirection[1] === b.anchor[1]
      d += straight
        ? ` L ${b.anchor[0]} ${b.anchor[1]}`
        : ` C ${a.rightDirection[0]} ${a.rightDirection[1]} ${b.leftDirection[0]} ${b.leftDirection[1]} ${b.anchor[0]} ${b.anchor[1]}`
    }
    if (path.closed) d += ' Z'
    out.push(d)
  }
  return out
}

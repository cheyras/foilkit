// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The pen SURFACE's arithmetic, driven without a browser.
//
// `PenEditor.tsx` cannot be unit-tested — it is React and pointer capture and requestAnimationFrame
// — so everything in it that is a calculation rather than a render was moved into
// `pen-surface.ts` and is tested here. Three things are worth a test rather than a comment:
//
//   * NORMALISATION. A pointer event lands in the right DOCUMENT coordinate through a rect that
//     already carries the CSS zoom, and Caps Lock reaches the engine, because no event property
//     carries it and the engine's whole crosshair rule (I.93) hangs off it.
//   * SCREEN-CONSTANT CHROME (item 100). The invariant is stated as an equation rather than as
//     a set of expected numbers: size_in_doc_units * scale is the same at every scale.
//   * NO CHROME IN THE ARTIFACT. The one this file exists for.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createPenState,
  cornerPoint,
  reduce,
  type PenDoc,
  type PenPath,
  type PenState,
} from '@foilkit/forge/geometry'
import {
  PEN_CHROME_PX,
  chromeMetrics,
  consumesKey,
  docPoint,
  keyInput,
  paintAlpha,
  penLoops,
  penPathD,
  pointerInput,
  rasterizePenDoc,
  screenPerDoc,
} from '../react/pen-surface.ts'

const W = 504
const H = 704

/** A square, closed, all handles retracted — so the raster is exactly the square. */
function squarePath(x0: number, y0: number, x1: number, y1: number): PenPath {
  return {
    closed: true,
    points: [
      cornerPoint({ x: x0, y: y0 }),
      cornerPoint({ x: x1, y: y0 }),
      cornerPoint({ x: x1, y: y1 }),
      cornerPoint({ x: x0, y: y1 }),
    ],
  }
}

// ── Normalisation ───────────────────────────────────────────────────────────

test('a pointer event maps to document space through the DISPLAYED rect, with no zoom term', () => {
  // The rect a browser reports for a 2x-zoomed overlay is already twice as wide. Feeding that in
  // must give the SAME document point as the 1x rect does for the corresponding client position
  // — that is the whole reason `MaskEditor.toMask` needs no zoom factor and this must not either.
  const at1 = docPoint({ left: 100, top: 50, width: 504, height: 704 }, 100 + 252, 50 + 352, W, H)
  const at2 = docPoint({ left: 100, top: 50, width: 1008, height: 1408 }, 100 + 504, 50 + 704, W, H)
  assert.deepEqual(at1, { x: 252, y: 352 })
  assert.deepEqual(at2, { x: 252, y: 352 })
})

test('a zero-width rect does not put every anchor at infinity', () => {
  assert.deepEqual(docPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10, W, H), { x: 0, y: 0 })
  assert.equal(screenPerDoc({ left: 0, top: 0, width: 0, height: 0 }, W), 1)
})

test('`zoom` handed to the engine is screen px per DOCUMENT unit, not the view controller zoom', () => {
  // The card face is rarely 504 screen px wide, so the two are different numbers and using the
  // controller's zoom would make every hit radius wrong by the card's fit factor.
  const rect = { left: 0, top: 0, width: 555, height: 775 }
  const input = pointerInput('pointerdown', mouse(0, 0), rect, W, H, false)
  assert.equal(input.zoom, 555 / W)
})

test('CapsLock reaches the engine, because no event property carries it', () => {
  const rect = { left: 0, top: 0, width: 504, height: 704 }
  const on = pointerInput('pointermove', { ...mouse(10, 10), getModifierState: (k) => k === 'CapsLock' }, rect, W, H, false)
  const off = pointerInput('pointermove', mouse(10, 10), rect, W, H, false)
  assert.equal(on.mods.capsLock, true)
  assert.equal(off.mods.capsLock, false)
  // And the engine acts on it: caps lock outranks every badge (spec I.93).
  const s = reduce(createPenState(), on, undefined)
  assert.equal(s.capsLock, true)
})

test('space is surface state, not event state — and Space normalises to the key the engine documents', () => {
  const rect = { left: 0, top: 0, width: 504, height: 704 }
  const held = pointerInput('pointermove', mouse(1, 1), rect, W, H, true)
  assert.equal(held.mods.space, true)
  const k = keyInput('keydown', { key: 'Spacebar', code: 'Space', altKey: false, ctrlKey: false, shiftKey: false }, rect, W, false)
  assert.equal(k.key, ' ')
})

// ── Screen-constant chrome (conformance item 100) ───────────────────────────

test('chrome keeps constant SCREEN-pixel size at every zoom', () => {
  for (const scale of [0.5, 0.9, 1, 2.4, 8]) {
    const m = chromeMetrics(scale)
    assert.ok(Math.abs(m.anchor * scale - PEN_CHROME_PX.anchor) < 1e-9, `anchor at ${scale}`)
    assert.ok(Math.abs(m.handleDot * scale - PEN_CHROME_PX.handleDot) < 1e-9, `dot at ${scale}`)
    assert.ok(Math.abs(m.directionLine * scale - PEN_CHROME_PX.directionLine) < 1e-9, `line at ${scale}`)
    assert.ok(Math.abs(m.outline * scale - PEN_CHROME_PX.outline) < 1e-9, `outline at ${scale}`)
  }
})

test('the hovered anchor is bigger than an idle one, and still screen-constant', () => {
  const a = chromeMetrics(1)
  const b = chromeMetrics(4)
  assert.ok(a.hoverAnchor > a.anchor)
  assert.ok(Math.abs(a.hoverAnchor / a.anchor - b.hoverAnchor / b.anchor) < 1e-12)
})

test('a nonsense scale degrades to 1x rather than to NaN or Infinity', () => {
  for (const bad of [0, -3]) {
    for (const v of Object.values(chromeMetrics(bad))) assert.ok(Number.isFinite(v) && v > 0)
  }
})

// ── The one this file exists for: no chrome in the artifact ─────────────────

test('the mask raster is a function of the DOCUMENT alone — selection and hover cannot reach it', () => {
  const doc: PenDoc = { paths: [squarePath(100, 100, 300, 300)] }
  const plain = rasterizePenDoc(doc, W, H)

  // The same geometry, with every anchor selected, an anchor hovered, a marquee open and a
  // rubber band live. If any of that could reach the rasteriser the bytes would move.
  let s: PenState = { ...createPenState(doc), activePathIndex: 0, activeEndpoint: 'last' }
  s = reduce(s, { type: 'keydown', key: 'a', mods: mods({ ctrl: true }), zoom: 1 })
  s = reduce(s, { type: 'pointermove', point: { x: 100, y: 100 }, mods: mods({}), zoom: 1 })
  assert.ok(s.selection.anchors.length === 4, 'select-all selected the anchors')
  assert.ok(s.hover !== null, 'the pointer is over the path')

  const withChrome = rasterizePenDoc(s.doc, W, H)
  assert.deepEqual([...withChrome], [...plain], 'chrome state changed the raster')
})

test('no chrome pixel is baked into the mask: the halo around a filled square stays empty', () => {
  // Anchor squares are drawn ~3 screen px HALF-WIDTH around each anchor, so if the chrome were
  // rasterised the corners would bleed outward. Every pixel outside the square is checked, not a
  // sample: a sampled assertion is one that a future off-by-one walks around.
  const doc: PenDoc = { paths: [squarePath(100, 100, 300, 300)] }
  const alpha = rasterizePenDoc(doc, W, H)
  let outside = 0
  let inside = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = alpha[y * W + x]!
      const within = x >= 100 && x < 300 && y >= 100 && y < 300
      if (within) {
        if (a > 0) inside++
      } else if (a > 0) {
        outside++
      }
    }
  }
  assert.equal(outside, 0, `${outside} lit pixels outside the path`)
  assert.equal(inside, 200 * 200, 'the square itself did not fill')
})

test('a path with fewer than three anchors encloses nothing, so it rasterises to nothing', () => {
  const one: PenDoc = { paths: [{ closed: false, points: [cornerPoint({ x: 200, y: 200 })] }] }
  const two: PenDoc = { paths: [{ closed: false, points: [cornerPoint({ x: 200, y: 200 }), cornerPoint({ x: 260, y: 200 })] }] }
  assert.equal(penLoops(one).length, 0)
  assert.equal(penLoops(two).length, 0)
  assert.ok(rasterizePenDoc(two, W, H).every((v) => v === 0))
})

test('multiple subpaths compose by nonzero winding — the same rule the templates rasterise under', () => {
  // An outer square wound one way and an inner square wound the OTHER cuts a hole; wound the
  // same way it unions. This is how one mask carries several regions, and it is inherited from
  // `rasterizePolygons` rather than re-decided here.
  const outer = squarePath(100, 100, 400, 400)
  const holeCW = squarePath(200, 200, 300, 300)
  const holeCCW: PenPath = { closed: true, points: [...holeCW.points].reverse() }
  const hole = rasterizePenDoc({ paths: [outer, holeCCW] }, W, H)
  const union = rasterizePenDoc({ paths: [outer, holeCW] }, W, H)
  assert.equal(hole[250 * W + 250], 0, 'the reversed subpath did not cut a hole')
  assert.equal(union[250 * W + 250], 255, 'the same-wound subpath did not union')
  assert.equal(hole[150 * W + 150], 255, 'the outer region is missing')
})

test('alpha carries the mask; RGB is a constant tint, so a mask diff is a coverage diff', () => {
  const alpha = new Uint8Array([0, 128, 255])
  const rgba = new Uint8ClampedArray(12)
  paintAlpha(rgba, alpha, [255, 45, 100])
  assert.deepEqual([...rgba], [255, 45, 100, 0, 255, 45, 100, 128, 255, 45, 100, 255])
})

// ── The chrome's own geometry ───────────────────────────────────────────────

test('a segment with both facing handles retracted draws as a LINE, not a degenerate curve', () => {
  // The closing segment is emitted EXPLICITLY and then `Z` — because a closed path's last
  // segment is a real segment that may be a curve, and letting `Z` stand in for it would draw
  // a straight line home wherever the user closed with a drag (spec A.7).
  const [d] = penPathD({ paths: [squarePath(10, 10, 20, 20)] })
  assert.equal(d, 'M 10 10 L 20 10 L 20 20 L 10 20 L 10 10 Z')
})

test('a curved segment draws as a cubic through the stored direction points', () => {
  const path: PenPath = {
    closed: false,
    points: [
      { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [10, 0], pointType: 'smooth' },
      { anchor: [20, 20], leftDirection: [20, 10], rightDirection: [20, 20], pointType: 'corner' },
    ],
  }
  assert.deepEqual(penPathD({ paths: [path] }), ['M 0 0 C 10 0 20 10 20 20'])
})

test('an open path is drawn open — no Z, or every path in progress would look closed', () => {
  const path: PenPath = { closed: false, points: [cornerPoint({ x: 0, y: 0 }), cornerPoint({ x: 5, y: 5 })] }
  assert.equal(penPathD({ paths: [path] })[0], 'M 0 0 L 5 5')
})

test('the surface swallows the chords the pen BINDS, and nothing else on the page', () => {
  // The keydown listener is at WINDOW level, so anything this returns true for is dead for the
  // entire document. It used to be a regex over bare characters — and `c` and `v` are the Anchor
  // Point and Selection tool letters, so `Ctrl+C` and `Ctrl+V` matched it: with the pen open, no
  // `copy` or `paste` event fired anywhere on the page, and `Ctrl+P` never reached print.
  const k = (key: string, m: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {}) =>
    ({ key, altKey: m.alt ?? false, ctrlKey: m.ctrl ?? false, shiftKey: m.shift ?? false })

  // THE BUG, as four assertions. None of these is a pen binding and none may be swallowed.
  for (const key of ['c', 'v', 'p', 'x']) {
    assert.equal(consumesKey(k(key, { ctrl: true })), false, `Ctrl+${key.toUpperCase()} belongs to the page`)
  }

  // …while the bare letters still are the pen's tools, and the real Ctrl chords still are its.
  for (const key of ['p', 'a', 'v', '=', '-', 'Escape', 'Enter', 'Delete', 'Backspace', 'ArrowLeft']) {
    assert.equal(consumesKey(k(key)), true, `bare ${key} is a pen binding`)
  }
  assert.equal(consumesKey(k('z', { ctrl: true })), true, 'Ctrl+Z is the pen\'s undo, not the browser\'s')
  assert.equal(consumesKey(k('z', { ctrl: true, shift: true })), true, 'and Ctrl+Shift+Z its redo')
  assert.equal(consumesKey(k('j', { ctrl: true })), true, 'Ctrl+J really is Join — the pen implements it')
  assert.equal(consumesKey(k('a', { ctrl: true })), true, 'Ctrl+A is Select All')
  assert.equal(consumesKey(k('y', { ctrl: true })), true, 'Ctrl+Y is Outline')
  assert.equal(consumesKey(k('h', { ctrl: true })), true, 'Ctrl+H is Hide Edges')
  assert.equal(consumesKey(k('C', { shift: true })), true, 'Shift+C is the Anchor Point tool')

  // The host's zoom chords survive, which is the distinction the old pair of regexes existed to
  // draw and could not: the pen claims BARE `+`/`=`/`-`, never the Ctrl versions.
  for (const key of ['=', '-', '0', '1']) {
    assert.equal(consumesKey(k(key, { ctrl: true })), false, `Ctrl+${key} is the host's zoom, not the pen's`)
  }

  // And the keys a surface must never take, however tempting the regex.
  for (const key of ['Tab', 'F5', 'F12', 'Home', 'PageDown']) {
    assert.equal(consumesKey(k(key)), false, `${key} must reach whatever implements it`)
  }
})

// ── helpers ─────────────────────────────────────────────────────────────────

function mouse(clientX: number, clientY: number) {
  return { clientX, clientY, button: 0, altKey: false, ctrlKey: false, shiftKey: false }
}
function mods(m: { alt?: boolean; ctrl?: boolean; shift?: boolean; space?: boolean; capsLock?: boolean }) {
  return { alt: false, ctrl: false, shift: false, space: false, capsLock: false, ...m }
}

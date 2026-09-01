// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE PARITY TEST that keeps `provisionalDiff.ts` a port rather than a second
// implementation.
//
// The browser cannot import `@foilkit/forge` (it reaches node:zlib through the
// PNG codec), so the rasterizer and the diff statistics are copied into the
// editor. A copy drifts. This test runs in Node, where BOTH are importable, and
// asserts they agree byte-for-byte over a spread of geometries — including the
// inverted sheet case and the degenerate rects where an SDF is easiest to get
// subtly wrong.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rasterizePriorAlpha as forgeRasterize, diffMask as forgeDiff } from '@foilkit/forge'
import { alphaOfRgba, diffAlpha, provisionalReport, rasterizePriorAlpha, FOIL_THRESHOLD } from './provisionalDiff.ts'

const GEOMS: { name: string; rect: [number, number, number, number]; radius: number; invert: boolean }[] = [
  { name: 'wotc window', rect: [0.0714, 0.5, 0.857, 0.34], radius: 0.02, invert: false },
  { name: 'modern-sv window', rect: [0.0655, 0.5266, 0.869, 0.3749], radius: 0.03, invert: false },
  { name: 'reverse sheet (inverted)', rect: [0.0655, 0.5266, 0.869, 0.3749], radius: 0.03, invert: true },
  { name: 'full face', rect: [0, 0, 1, 1], radius: 0.047619, invert: false },
  { name: 'radius larger than the box', rect: [0.4, 0.4, 0.05, 0.05], radius: 0.9, invert: false },
  { name: 'zero-area rect', rect: [0.5, 0.5, 0, 0], radius: 0.02, invert: false },
  { name: 'off-canvas rect', rect: [-0.2, -0.2, 0.5, 0.5], radius: 0.01, invert: false },
]

// Small rasters: the SDF is resolution-independent, and a 63×88 plane exercises
// every branch in a fraction of the time 504×704 would take.
const W = 63
const H = 88

for (const g of GEOMS) {
  test(`rasterizePriorAlpha matches @foilkit/forge — ${g.name}`, () => {
    const mine = rasterizePriorAlpha(W, H, g)
    const theirs = forgeRasterize(W, H, {
      source: 'layout',
      eraId: 'test',
      scope: g.invert ? 'sheet' : 'window',
      rect: g.rect,
      radius: g.radius,
      invert: g.invert,
      feather: 0.008,
      resolverVersion: 5,
    })
    assert.equal(mine.length, theirs.length)
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] !== theirs[i]) {
        assert.fail(`pixel ${i} (${i % W},${Math.floor(i / W)}): editor ${mine[i]} vs forge ${theirs[i]}`)
      }
    }
  })
}

test('diffAlpha matches forge diffMask statistics, including the empty-plane case', () => {
  const rule = rasterizePriorAlpha(W, H, GEOMS[0]!)
  // A "hand mask": the rule, plus a painted blob, minus a bite out of a corner.
  const rgba = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = rule[i]!
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) rgba[(y * W + x) * 4 + 3] = 255
  for (let y = 40; y < 45; y++) for (let x = 5; x < 12; x++) rgba[(y * W + x) * 4 + 3] = 0

  const theirs = forgeDiff({ width: W, height: H, rgba }, rule).stats
  const mine = diffAlpha(alphaOfRgba(rgba, W * H), rule)
  assert.equal(mine.addedPx, theirs.addedPx)
  assert.equal(mine.removedPx, theirs.removedPx)
  assert.equal(mine.unchangedPx, theirs.unchangedPx)
  assert.equal(mine.agreement, theirs.agreement)
  assert.equal(mine.provisional, true)

  // Two empty planes agree completely — forge returns 1, and so must this.
  const empty = new Uint8Array(W * H)
  assert.equal(diffAlpha(empty, empty).agreement, 1)
  assert.equal(forgeDiff({ width: W, height: H, rgba: new Uint8Array(W * H * 4) }, empty).stats.agreement, 1)
})

test('the threshold is forge’s: alpha 127 is not foil, 128 is', () => {
  assert.equal(FOIL_THRESHOLD, 128)
  const rule = new Uint8Array([255])
  assert.equal(diffAlpha(new Uint8Array([127]), rule).unchangedPx, 0)
  assert.equal(diffAlpha(new Uint8Array([128]), rule).unchangedPx, 1)
})

test('provisionalReport gives both numbers, and vsParent is null with no parent', () => {
  const geom = GEOMS[0]!
  const rule = rasterizePriorAlpha(W, H, geom)
  const hand = Uint8Array.from(rule)
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) hand[y * W + x] = 255

  const noParent = provisionalReport(hand, geom, W, H, null)
  assert.equal(noParent.vsParent, null)
  assert.equal(noParent.vsRule.provisional, true)
  assert.equal(noParent.changed, true)

  const withParent = provisionalReport(hand, geom, W, H, hand)
  assert.equal(withParent.vsParent!.agreement, 1)
  assert.equal(withParent.changed, false, 'identical to its parent is not a change')
})

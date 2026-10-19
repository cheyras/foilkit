// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SECTION, ETCH_H, ETCH_PATTERNS, ETCH_W, LABEL_BLACK, LABEL_KEEP, LABEL_WHITE, SECTION_BASE, SEG_H, SEG_W,
  bakeEtch, distanceInside, patternDark,
} from './patterns.ts'

const segs = (fill: (x: number, y: number) => number) => {
  const a = new Uint8Array(SEG_W * SEG_H)
  for (let y = 0; y < SEG_H; y++) for (let x = 0; x < SEG_W; x++) a[y * SEG_W + x] = fill(x, y)
  return a
}

test('keep shows the base, white is full foil, black is solid', () => {
  const base = new Uint8Array(ETCH_W * ETCH_H).fill(77)
  const out = bakeEtch(segs((x) => (x < 100 ? LABEL_KEEP : x < 200 ? LABEL_WHITE : LABEL_BLACK)), {}, base)
  assert.equal(out[10 * ETCH_W + 50], 77)
  assert.equal(out[10 * ETCH_W + 300], 255)
  assert.equal(out[10 * ETCH_W + 500], 0)
  // no base: keep is plain foil
  assert.equal(bakeEtch(segs(() => LABEL_KEEP), {}, null)[0], 255)
})

test('a parallel section has lines at the chosen pitch and roughly the chosen weight', () => {
  const s = { ...DEFAULT_SECTION, pattern: 'parallel' as const, angle: 0, pitch: 5, weight: 0.5 }
  const out = bakeEtch(segs(() => SECTION_BASE), { A: s }, null)
  let dark = 0
  for (let y = 0; y < 200; y++) dark += out[y * ETCH_W + 400]! < 128 ? 1 : 0
  assert.ok(Math.abs(dark / 200 - 0.5) < 0.12, `dark fraction ${dark / 200}`)
  // angle 0 = horizontal lines: constant along x
  assert.equal(out[50 * ETCH_W + 10], out[50 * ETCH_W + 900])
})

test('contour lines follow the region: distance from the edge sets the line', () => {
  const inside = new Uint8Array(20 * 20)
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) inside[y * 20 + x] = 1
  const d = distanceInside(inside, 20, 20)
  assert.equal(d[5 * 20 + 5], 1)
  assert.ok(d[10 * 20 + 10]! >= 5)
  assert.equal(d[0], 0)
})

test('every library pattern renders without NaN and stays in 0..1', () => {
  for (const p of ETCH_PATTERNS) {
    for (const [x, y] of [[0, 0], [123, 456], [1007, 1407], [504, 704]]) {
      const v = patternDark({ ...DEFAULT_SECTION, pattern: p.id }, x!, y!, 7.3)
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${p.id} at ${x},${y} -> ${v}`)
    }
  }
})

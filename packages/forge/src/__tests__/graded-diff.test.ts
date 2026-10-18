// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The graded half of diffMask (2026-10-18). The binary half thresholds alpha at
// FOIL_THRESHOLD, which is right for "is this pixel foil at all" and wrong for
// a mask that records foil STRENGTH: two masks that both hold a 0.4 panel agree
// perfectly and the binary stats call that panel empty on both sides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffMask } from '../mask-artifacts.ts'

function hand(alpha: number[]): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(alpha.length * 4)
  alpha.forEach((a, i) => { rgba[i * 4 + 3] = a })
  return { width: alpha.length, height: 1, rgba }
}

test('two identical sub-threshold masks: binary sees nothing, graded sees full agreement', () => {
  const lvl = [100, 100, 100, 0]
  const { stats } = diffMask(hand(lvl), Uint8Array.from(lvl))
  assert.equal(stats.unchangedPx, 0)
  assert.equal(stats.agreement, 1) // empty union: the binary stats have no opinion
  assert.deepEqual(stats.strength, { agreement: 1, meanAbs: 0 })
})

test('a level change below the threshold is invisible to the binary stats and measured by the graded ones', () => {
  const { stats } = diffMask(hand([100, 100]), Uint8Array.from([50, 50]))
  assert.equal(stats.addedPx + stats.removedPx + stats.unchangedPx, 0)
  assert.equal(stats.strength!.agreement, 0.5)
  assert.equal(stats.strength!.meanAbs, Number((50 / 255).toFixed(4)))
})

test('the binary stats are unchanged by the addition', () => {
  const { stats } = diffMask(hand([255, 255, 0, 0]), Uint8Array.from([255, 0, 255, 0]))
  assert.equal(stats.unchangedPx, 1)
  assert.equal(stats.addedPx, 1)
  assert.equal(stats.removedPx, 1)
  assert.equal(stats.agreement, Number((1 / 3).toFixed(4)))
  assert.equal(stats.strength!.agreement, Number((255 / 765).toFixed(4)))
})

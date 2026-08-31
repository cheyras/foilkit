// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CANONICAL_CORNER_RADIUS_PX,
  CANONICAL_H,
  CANONICAL_PX_PER_MM,
  CANONICAL_W,
  CARD_ASPECT,
  CARD_ASPECT_INVERSE,
  CARD_CORNER_RADIUS_FRACTION,
  CARD_CORNER_RADIUS_MM,
  CARD_HEIGHT_MM,
  CARD_WIDTH_MM,
  canonicalCorners,
  canonicalPxToMm,
  mmToCanonicalPx,
} from './constants.ts';

describe('canonical space derives from the millimetre constants', () => {
  it('recomputes the raster from mm rather than trusting the export', () => {
    assert.equal(CANONICAL_W, CARD_WIDTH_MM * CANONICAL_PX_PER_MM);
    assert.equal(CANONICAL_H, CARD_HEIGHT_MM * CANONICAL_PX_PER_MM);
    // The values task 4b decided, restated independently so a change to either
    // side of the derivation is visible.
    assert.equal(CANONICAL_W, 504);
    assert.equal(CANONICAL_H, 704);
  });

  it('recomputes the corner from mm', () => {
    assert.equal(CARD_CORNER_RADIUS_FRACTION, CARD_CORNER_RADIUS_MM / CARD_WIDTH_MM);
    assert.ok(Math.abs(CARD_CORNER_RADIUS_FRACTION - 0.047619047619) < 1e-12);
    assert.equal(CANONICAL_CORNER_RADIUS_PX, CARD_CORNER_RADIUS_MM * CANONICAL_PX_PER_MM);
    assert.equal(CANONICAL_CORNER_RADIUS_PX, 24);
  });

  it('is exactly 63:88 with no rounding', () => {
    assert.equal(CANONICAL_W / CANONICAL_H, CARD_ASPECT);
    assert.equal(CARD_ASPECT * CARD_ASPECT_INVERSE, 1);
    // The framing this replaces: TCGdex's 245×337 is 1.55% too wide.
    const tcgdexAspect = 245 / 337;
    assert.ok(tcgdexAspect / CARD_ASPECT - 1 > 0.015);
    assert.ok(tcgdexAspect / CARD_ASPECT - 1 < 0.016);
  });

  it('converts mm and canonical px reversibly', () => {
    assert.equal(mmToCanonicalPx(CARD_WIDTH_MM), CANONICAL_W);
    assert.equal(canonicalPxToMm(CANONICAL_H), CARD_HEIGHT_MM);
  });

  it('lays the canonical corners out clockwise from top-left', () => {
    assert.deepEqual(canonicalCorners(), [
      [0, 0],
      [504, 0],
      [504, 704],
      [0, 704],
    ]);
    assert.deepEqual(canonicalCorners(10, 20), [
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ]);
  });

  // Task 4b's verification item: "a contract test recomputes the raster and the
  // corner from mm and fails a typed-in number". Recomputation alone cannot
  // catch a literal — 504 === 504 either way — so this reads the source back
  // and fails if a derived export was ever assigned a number.
  it('never assigns a derived value a literal', () => {
    const src = readFileSync(fileURLToPath(new URL('./constants.ts', import.meta.url)), 'utf8');
    const derived = [
      'CANONICAL_W',
      'CANONICAL_H',
      'CARD_ASPECT',
      'CARD_ASPECT_INVERSE',
      'CARD_CORNER_RADIUS_FRACTION',
      'CANONICAL_CORNER_RADIUS_PX',
    ];
    for (const name of derived) {
      const literal = new RegExp(`export const ${name}\\s*=\\s*[-\\d.]`);
      assert.ok(
        !literal.test(src),
        `${name} is assigned a numeric literal; it must be computed from the millimetre constants`,
      );
    }
    // …and the four inputs ARE literals, which is what makes them the inputs.
    for (const name of ['CARD_WIDTH_MM', 'CARD_HEIGHT_MM', 'CARD_CORNER_RADIUS_MM', 'CANONICAL_PX_PER_MM']) {
      assert.ok(new RegExp(`export const ${name} = \\d`).test(src), `${name} should be a literal input`);
    }
  });

  it('keeps the provenance honest about the corner radius', () => {
    const src = readFileSync(fileURLToPath(new URL('./constants.ts', import.meta.url)), 'utf8');
    assert.match(src, /TRIANGULATED, NOT OFFICIAL/);
    assert.match(src, /2\.5–3\.0 mm/);
  });
});

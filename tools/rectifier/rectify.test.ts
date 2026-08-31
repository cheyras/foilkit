// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The round-trip measurement. A known canonical raster is rendered into a
// synthetic photograph through a known homography; the rectifier is handed
// nothing but the photo and the four corners, and has to give the raster back.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CANONICAL_H, CANONICAL_W, canonicalCorners } from './constants.ts';
import { type Point, applyHomography, normalizeMat3 } from './homography.ts';
import { aspectError, rectify, resampleFrame } from './rectify.ts';
import { compareImages, renderPhoto, syntheticCard, tiltedQuad } from './synthetic.ts';

const FRAME = { frameWidth: 1500, frameHeight: 1550 };
const MARGIN = 4;

/** Tolerances stated in 8-bit levels, as the task specifies them: x/255. */
const MEAN_TOLERANCE = 2;
const MAX_TOLERANCE = 12;

describe('rectify: synthetic round trip', () => {
  const truth = syntheticCard(CANONICAL_W, CANONICAL_H);
  const quad = tiltedQuad();
  const photo = renderPhoto(truth, quad, FRAME);

  it('recovers the canonical raster within tolerance', () => {
    const out = rectify(photo.image, quad);
    assert.equal(out.width, CANONICAL_W);
    assert.equal(out.height, CANONICAL_H);

    const err = compareImages(out.image, truth, MARGIN);
    console.log(
      `    round trip: mean ${err.mean.toFixed(4)}/255, max ${err.max}/255 over ${err.pixels} px ` +
        `(margin ${MARGIN}px)`,
    );
    assert.ok(err.mean < MEAN_TOLERANCE, `mean error ${err.mean} exceeded ${MEAN_TOLERANCE}/255`);
    assert.ok(err.max < MAX_TOLERANCE, `max error ${err.max} exceeded ${MAX_TOLERANCE}/255`);
  });

  it('recovers the homography that produced the photo', () => {
    const out = rectify(photo.image, quad);
    const a = normalizeMat3(out.toCanonical);
    const b = normalizeMat3(photo.truthToCanonical);
    for (let i = 0; i < 9; i++) {
      assert.ok(Math.abs(a[i]! - b[i]!) < 1e-9, `H entry ${i}: ${a[i]} vs ${b[i]}`);
    }
  });

  it('returns a homography pair that round-trips the corners', () => {
    const out = rectify(photo.image, quad);
    const dst = canonicalCorners();
    for (let i = 0; i < 4; i++) {
      const fwd = applyHomography(out.toCanonical, out.corners[i]!);
      assert.ok(Math.hypot(fwd[0] - dst[i]![0], fwd[1] - dst[i]![1]) < 1e-6);
      const back = applyHomography(out.fromCanonical, dst[i]!);
      assert.ok(Math.hypot(back[0] - out.corners[i]![0], back[1] - out.corners[i]![1]) < 1e-6);
    }
  });

  it('gives the same answer for every cyclic rotation of the corner list', () => {
    const base = rectify(photo.image, quad).image;
    for (let s = 1; s < 4; s++) {
      const rotated: Point[] = [quad[s % 4]!, quad[(s + 1) % 4]!, quad[(s + 2) % 4]!, quad[(s + 3) % 4]!];
      const err = compareImages(rectify(photo.image, rotated).image, base, 0);
      assert.equal(err.max, 0, `rotation by ${s} changed the output`);
    }
  });

  it('gives the same answer for a counter-clockwise detection', () => {
    const base = rectify(photo.image, quad).image;
    const reversed: Point[] = [quad[3]!, quad[2]!, quad[1]!, quad[0]!];
    const out = rectify(photo.image, reversed);
    assert.equal(out.orientation.reversed, true);
    assert.equal(compareImages(out.image, base, 0).max, 0);
  });

  it('records what the orientation resolver decided', () => {
    const rotated: Point[] = [quad[1]!, quad[2]!, quad[3]!, quad[0]!];
    const out = rectify(photo.image, rotated);
    assert.equal(out.orientation.requested, 'auto');
    assert.equal(out.orientation.steps, 3);
    assert.equal(out.orientation.reversed, false);
  });

  it('honours an explicit orientation instead of guessing', () => {
    const sideways = rectify(photo.image, quad, { orientation: 'rotate90' });
    // Reading a portrait card as if turned 90° must NOT reproduce the truth —
    // otherwise the override is a no-op and the test proves nothing.
    assert.ok(compareImages(sideways.image, syntheticCard(CANONICAL_W, CANONICAL_H), MARGIN).mean > 10);
  });

  it('accepts a non-canonical output raster when asked explicitly', () => {
    const out = rectify(photo.image, quad, { width: 252, height: 352 });
    assert.equal(out.image.width, 252);
    assert.equal(out.image.height, 352);
    assert.equal(out.image.rgba.length, 252 * 352 * 4);
  });

  it('rejects a malformed image', () => {
    assert.throws(
      () => rectify({ width: 4, height: 4, rgba: new Uint8Array(10) }, quad),
      /does not match/,
    );
  });
});

describe('rectify: the degenerate-but-legal identity case', () => {
  it('reproduces a full-frame quad on a raster that is already canonical', () => {
    const truth = syntheticCard(CANONICAL_W, CANONICAL_H);
    const out = rectify(truth, canonicalCorners());
    const err = compareImages(out.image, truth, 0);
    console.log(`    identity rectify: mean ${err.mean.toFixed(4)}/255, max ${err.max}/255`);
    assert.ok(err.max <= 1, `an identity warp should be lossless to rounding; got ${err.max}`);
    const H = normalizeMat3(out.toCanonical);
    assert.ok(Math.abs(H[0]! - 1) < 1e-12 && Math.abs(H[4]! - 1) < 1e-12);
    assert.ok(Math.abs(H[2]!) < 1e-9 && Math.abs(H[5]!) < 1e-9);
  });

  it('resamples a differently-framed raster into canonical', () => {
    // A 600×825 catalog raster, the framing every existing mask was drawn in.
    const catalog = syntheticCard(600, 825);
    const out = rectify(catalog, canonicalCorners(600, 825));
    assert.equal(out.image.width, CANONICAL_W);
    assert.equal(out.image.height, CANONICAL_H);
    // Smooth pattern, pure anisotropic resample: the content survives.
    const err = compareImages(out.image, syntheticCard(CANONICAL_W, CANONICAL_H), MARGIN);
    console.log(`    600×825 → canonical: mean ${err.mean.toFixed(4)}/255, max ${err.max}/255`);
    assert.ok(err.mean < MEAN_TOLERANCE);
  });
});

describe('frame records', () => {
  it('describes a pure resample as an anisotropic scale', () => {
    const rec = resampleFrame('tcgdex-high', 600, 825);
    assert.equal(rec.id, 'tcgdex-high');
    assert.deepEqual(rec.raster, [600, 825]);
    assert.equal(rec.toCanonical[2]![2], 1);
    // Row-major: [sx 0 0; 0 sy 0; 0 0 1] with sx ≠ sy — the 1.55% is right here.
    assert.ok(Math.abs(rec.toCanonical[0]![0]! - CANONICAL_W / 600) < 1e-12);
    assert.ok(Math.abs(rec.toCanonical[1]![1]! - CANONICAL_H / 825) < 1e-12);
    assert.ok(Math.abs(rec.toCanonical[0]![1]!) < 1e-12);
    assert.ok(Math.abs(rec.toCanonical[1]![0]!) < 1e-12);
    assert.notEqual(rec.toCanonical[0]![0], rec.toCanonical[1]![1]);
  });

  it('measures the framing error the canonical space exists to fix', () => {
    // Both TCGdex framings are ~1.55% too wide — the number task 4 is about.
    // They are not the same number: 600×825 is exactly 8:11 (11/693 = 1.5873%)
    // while 245×337 is 329/21231 = 1.5496%. Close enough to be quoted as one
    // figure in prose, far enough apart that a shared constant would be wrong.
    assert.ok(Math.abs(aspectError(600, 825) - 11 / 693) < 1e-12);
    assert.ok(Math.abs(aspectError(245, 337) - 329 / 21231) < 1e-12);
    assert.ok(aspectError(600, 825) > 0.0155 && aspectError(600, 825) < 0.016);
    assert.ok(aspectError(245, 337) > 0.0154 && aspectError(245, 337) < 0.0156);
    assert.equal(aspectError(CANONICAL_W, CANONICAL_H), 0);
    // The unknown-provenance residue at 599×836 is ~ the physical aspect.
    assert.ok(Math.abs(aspectError(599, 836)) < 0.001);
  });
});

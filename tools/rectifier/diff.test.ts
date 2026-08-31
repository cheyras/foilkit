// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The classifier scaffolding, exercised against synthetic pairs that stand in
// for the three cases until the photographed pairs exist.
//
// What these tests prove is that the harness SEPARATES the three cases and that
// the numbers land where the thresholds say. What they cannot prove is that the
// thresholds are right for real cards — that needs pairs, and pairs need the
// binder. See README.md, "What is still blocked".

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CANONICAL_H, CANONICAL_W } from './constants.ts';
import type { RgbaImage } from './homography.ts';
import {
  CHANGED_PIXEL_DELTA,
  type FracRect,
  PLACEHOLDER_ART_WINDOW,
  blankCanonical,
  checkAlignment,
  classifyDelta,
  diffPair,
  pairRecord,
} from './diff.ts';
import { syntheticCard } from './synthetic.ts';

const WINDOW: FracRect = PLACEHOLDER_ART_WINDOW;

function clone(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, rgba: Uint8Array.from(img.rgba) };
}

/** Paint a solid block over a fractional rectangle. */
function paint(img: RgbaImage, r: FracRect, rgb: [number, number, number]): RgbaImage {
  const out = clone(img);
  const x0 = Math.round(r.x * img.width);
  const x1 = Math.round((r.x + r.w) * img.width);
  const y0 = Math.round(r.y * img.height);
  const y1 = Math.round((r.y + r.h) * img.height);
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const i = (y * img.width + x) * 4;
      out.rgba[i] = rgb[0];
      out.rgba[i + 1] = rgb[1];
      out.rgba[i + 2] = rgb[2];
    }
  }
  return out;
}

/** Deterministic per-pixel jitter, standing in for scanner noise. */
function jitter(img: RgbaImage, amplitude: number): RgbaImage {
  const out = clone(img);
  let s = 0x2f6e2b1;
  for (let i = 0; i < out.rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const d = ((s >>> 16) % (2 * amplitude + 1)) - amplitude;
      const v = out.rgba[i + c]! + d;
      out.rgba[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

describe('alignment guard', () => {
  const a = syntheticCard(CANONICAL_W, CANONICAL_H);

  it('calls an identical pair aligned at zero shift', () => {
    const r = checkAlignment(a, clone(a));
    assert.equal(r.dx, 0);
    assert.equal(r.dy, 0);
    assert.equal(r.residual, 0);
    assert.equal(r.aligned, true);
  });

  it('finds a deliberate shift and refuses to call it aligned', () => {
    // Shift the card 12 px right and 8 px down inside the raster.
    const shifted = blankCanonical();
    const SX = 12;
    const SY = 8;
    for (let y = 0; y < CANONICAL_H; y++) {
      for (let x = 0; x < CANONICAL_W; x++) {
        const sx = x - SX;
        const sy = y - SY;
        if (sx < 0 || sy < 0 || sx >= CANONICAL_W || sy >= CANONICAL_H) continue;
        const di = (y * CANONICAL_W + x) * 4;
        const si = (sy * CANONICAL_W + sx) * 4;
        for (let c = 0; c < 4; c++) shifted.rgba[di + c] = a.rgba[si + c]!;
      }
    }
    const r = checkAlignment(a, shifted);
    assert.equal(r.dx, SX);
    assert.equal(r.dy, SY);
    assert.equal(r.aligned, false, 'a 12×8 px shift is well past the 4 px guard');
    assert.ok(r.residual < r.residualAtZero, 'the best shift must beat zero shift');
  });

  it('refuses a pair that is not the same raster', () => {
    assert.throws(
      () => diffPair(a, syntheticCard(300, 400)),
      /Both sides must be rectified to canonical space first/,
    );
  });
});

describe('three-way classifier', () => {
  const normal = syntheticCard(CANONICAL_W, CANONICAL_H);

  it('null — the same ink, only the foil assignment differs', () => {
    // Noise below the changed-pixel threshold: a re-scan, not a re-print.
    const reverse = jitter(normal, Math.floor(CHANGED_PIXEL_DELTA / 3));
    const d = diffPair(normal, reverse, { artWindow: WINDOW });
    const c = classifyDelta(d);
    console.log(
      `    null pair: overall changed ${(d.overall.changedFraction * 100).toFixed(4)}%, ` +
        `mean Δ ${d.overall.meanDelta.toFixed(2)}, max Δ ${d.overall.maxDelta}`,
    );
    assert.equal(c.deltaClass, 'null');
    assert.equal(c.trustworthy, true);
    assert.match(c.reason, /null ceiling/);
  });

  it('frame — a band of difference confined outside the art window', () => {
    // The keyline case: a strip across the lower tag block, plus a set stamp,
    // both entirely below the art window.
    let reverse = paint(normal, { x: 0.04, y: 0.78, w: 0.55, h: 0.06 }, [255, 255, 255]);
    reverse = paint(reverse, { x: 0.66, y: 0.55, w: 0.2, h: 0.14 }, [12, 200, 240]);
    const d = diffPair(normal, reverse, { artWindow: WINDOW });
    const c = classifyDelta(d);
    console.log(
      `    frame pair: window changed ${(d.inside!.changedFraction * 100).toFixed(4)}%, ` +
        `frame changed ${(d.outside!.changedFraction * 100).toFixed(4)}%`,
    );
    assert.equal(c.deltaClass, 'frame');
    assert.equal(c.trustworthy, true);
    assert.equal(d.inside!.changed, 0, 'nothing should have changed inside the window');
    assert.ok(d.outside!.changedFraction > 0.05);
  });

  it('full — the design crosses the art window', () => {
    // The EX-era case: a motif running across image and text alike.
    const reverse = paint(normal, { x: 0.2, y: 0.05, w: 0.6, h: 0.7 }, [250, 240, 120]);
    const d = diffPair(normal, reverse, { artWindow: WINDOW });
    const c = classifyDelta(d);
    console.log(
      `    full pair: window changed ${(d.inside!.changedFraction * 100).toFixed(4)}%, ` +
        `frame changed ${(d.outside!.changedFraction * 100).toFixed(4)}%`,
    );
    assert.equal(c.deltaClass, 'full');
    assert.ok(d.inside!.changedFraction > 0.5);
  });

  it('refuses to separate frame from full with no art window', () => {
    const reverse = paint(normal, { x: 0.04, y: 0.78, w: 0.55, h: 0.06 }, [255, 255, 255]);
    const d = diffPair(normal, reverse, { artWindow: null });
    assert.equal(d.inside, null);
    assert.equal(d.outside, null);
    const c = classifyDelta(d);
    assert.equal(c.deltaClass, 'full');
    assert.equal(c.trustworthy, false);
    assert.match(c.reason, /no art window was supplied/);
  });

  it('marks a misaligned pair untrustworthy rather than silently classifying it', () => {
    const shifted = blankCanonical();
    for (let y = 0; y < CANONICAL_H; y++) {
      for (let x = 16; x < CANONICAL_W; x++) {
        const di = (y * CANONICAL_W + x) * 4;
        const si = (y * CANONICAL_W + (x - 16)) * 4;
        for (let c = 0; c < 4; c++) shifted.rgba[di + c] = normal.rgba[si + c]!;
      }
    }
    const c = classifyDelta(diffPair(normal, shifted, { artWindow: WINDOW }));
    assert.equal(c.trustworthy, false);
  });

  it('exposes the thresholds it used, and lets a caller override them', () => {
    const reverse = jitter(normal, Math.floor(CHANGED_PIXEL_DELTA / 3));
    const d = diffPair(normal, reverse, { artWindow: WINDOW });
    assert.equal(classifyDelta(d).thresholds.changedPixelDelta, CHANGED_PIXEL_DELTA);
    // Drive the null ceiling to zero and the same pair stops being null.
    assert.notEqual(classifyDelta(d, { nullMaxChangedFraction: 0 }).deltaClass, 'null');
  });
});

describe('diff mechanics', () => {
  const normal = syntheticCard(CANONICAL_W, CANONICAL_H);

  it('emits a greyscale delta map at the canonical raster', () => {
    const reverse = paint(normal, { x: 0.1, y: 0.8, w: 0.3, h: 0.05 }, [255, 255, 255]);
    const d = diffPair(normal, reverse, { artWindow: WINDOW });
    assert.equal(d.delta.width, CANONICAL_W);
    assert.equal(d.delta.height, CANONICAL_H);
    assert.equal(d.delta.rgba.length, CANONICAL_W * CANONICAL_H * 4);
    for (let i = 0; i < d.delta.rgba.length; i += 4) {
      assert.equal(d.delta.rgba[i], d.delta.rgba[i + 1]);
      assert.equal(d.delta.rgba[i], d.delta.rgba[i + 2]);
      assert.equal(d.delta.rgba[i + 3], 255);
    }
  });

  it('excludes the edge margin from every statistic', () => {
    const withEdge = clone(normal);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < CANONICAL_W; x++) {
        const i = (y * CANONICAL_W + x) * 4;
        withEdge.rgba[i] = 255;
        withEdge.rgba[i + 1] = 0;
        withEdge.rgba[i + 2] = 255;
      }
    }
    const d = diffPair(normal, withEdge, { artWindow: WINDOW, edgeMarginPx: 4 });
    assert.equal(d.overall.changed, 0, 'a two-row edge artefact must not reach the statistics');
    // …but it is still visible in the evidence image.
    assert.ok(d.delta.rgba[0]! > CHANGED_PIXEL_DELTA);
  });

  it('splits inside and outside the window without dropping or double-counting a pixel', () => {
    const d = diffPair(normal, clone(normal), { artWindow: WINDOW, edgeMarginPx: 4 });
    assert.equal(d.inside!.pixels + d.outside!.pixels, d.overall.pixels);
    assert.equal(d.overall.pixels, (CANONICAL_W - 8) * (CANONICAL_H - 8));
  });

  it('is symmetric in its arguments', () => {
    const reverse = paint(normal, { x: 0.1, y: 0.8, w: 0.3, h: 0.05 }, [255, 255, 255]);
    const ab = diffPair(normal, reverse, { artWindow: WINDOW });
    const ba = diffPair(reverse, normal, { artWindow: WINDOW });
    assert.equal(ab.overall.changed, ba.overall.changed);
    assert.equal(ab.overall.maxDelta, ba.overall.maxDelta);
  });
});

describe('pair record', () => {
  it('carries the class, the evidence and the alignment together', () => {
    const normal = syntheticCard(CANONICAL_W, CANONICAL_H);
    const reverse = paint(normal, { x: 0.04, y: 0.78, w: 0.55, h: 0.06 }, [255, 255, 255]);
    const d = diffPair(normal, reverse, { artWindow: WINDOW });
    const rec = pairRecord(
      {
        cardId: 'synthetic-0',
        normalVariantId: 'normal',
        reverseVariantId: 'reverse',
        measuredOn: '2026-08-31',
      },
      d,
      classifyDelta(d),
      'evidence/synthetic-0.delta.png',
    );
    assert.equal(rec.deltaClass, 'frame');
    assert.equal(rec.deltaImagePath, 'evidence/synthetic-0.delta.png');
    assert.ok(rec.stats.inside && rec.stats.outside);
    assert.equal(rec.alignment.aligned, true);
    // The record has to survive the JSON it will be written as.
    assert.deepEqual(JSON.parse(JSON.stringify(rec)).deltaClass, 'frame');
  });
});

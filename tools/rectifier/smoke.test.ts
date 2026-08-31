// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The real-scan smoke test: everything above this file is synthetic, and a
// pipeline that only ever sees its own output is a pipeline that has never been
// tested.
//
// It runs against two catalog PNGs fetched by `fetch-smoke-scans.ts` into the
// gitignored `reference-media/` tree. When they are absent — a fresh clone, an
// offline machine, CI without network — every case SKIPS rather than fails.
// A skipped smoke test is honest; a vendored card scan is a licence problem.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CANONICAL_H, CANONICAL_W, CARD_ASPECT, canonicalCorners } from './constants.ts';
import { checkAlignment, diffPair, classifyDelta } from './diff.ts';
import { decodePng, encodePng } from './png.ts';
import { aspectError, rectify } from './rectify.ts';
import { SMOKE_SCANS, smokeScanDir, smokeScanPath } from './smoke-scans.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const present = SMOKE_SCANS.every((s) => existsSync(smokeScanPath(HERE, s.file)));
const skip = present
  ? false
  : `no scans in ${smokeScanDir(HERE)} — run: node tools/rectifier/fetch-smoke-scans.ts`;

describe('real catalog scans', { skip }, () => {
  for (const scan of SMOKE_SCANS) {
    it(`rectifies ${scan.file} (${scan.note})`, () => {
      const img = decodePng(readFileSync(smokeScanPath(HERE, scan.file)));
      assert.deepEqual(
        [img.width, img.height],
        scan.expectedRaster,
        'the published raster changed; re-measure before trusting the frame record',
      );
      assert.equal(img.rgba.length, img.width * img.height * 4);

      // A catalog scan is the whole card and nothing else, so the detected quad
      // is the raster's own corners — the identity-ish case the frame registry
      // records as a pure resample.
      const out = rectify(img, canonicalCorners(img.width, img.height));

      assert.equal(out.image.width, CANONICAL_W);
      assert.equal(out.image.height, CANONICAL_H);
      assert.equal(out.image.rgba.length, CANONICAL_W * CANONICAL_H * 4);
      assert.equal(out.image.width / out.image.height, CARD_ASPECT);
      assert.equal(out.orientation.steps, 0);
      assert.equal(out.orientation.reversed, false);

      // Every output pixel was written: a warp that missed one leaves alpha 0.
      let opaque = 0;
      for (let i = 3; i < out.image.rgba.length; i += 4) if (out.image.rgba[i] === 255) opaque++;
      assert.equal(opaque, CANONICAL_W * CANONICAL_H, 'every canonical pixel must be written');

      console.log(
        `    ${scan.file}: ${img.width}×${img.height} (aspect error ` +
          `${(aspectError(img.width, img.height) * 100).toFixed(3)}%) → ${CANONICAL_W}×${CANONICAL_H}`,
      );
    });
  }

  it('is deterministic — the same scan twice gives byte-identical output', () => {
    const img = decodePng(readFileSync(smokeScanPath(HERE, SMOKE_SCANS[0]!.file)));
    const a = rectify(img, canonicalCorners(img.width, img.height)).image;
    const b = rectify(img, canonicalCorners(img.width, img.height)).image;
    assert.deepEqual(a.rgba, b.rgba);
  });

  it('diffs two rectified scans without a size complaint', () => {
    // Two DIFFERENT cards, so this is not a delta measurement — it is proof the
    // diff harness accepts real rectified rasters and that two independent
    // rectifications land on the same grid. The class it reports is meaningless
    // and is not asserted.
    const [one, two] = SMOKE_SCANS;
    const a = decodePng(readFileSync(smokeScanPath(HERE, one!.file)));
    const b = decodePng(readFileSync(smokeScanPath(HERE, two!.file)));
    const ra = rectify(a, canonicalCorners(a.width, a.height)).image;
    const rb = rectify(b, canonicalCorners(b.width, b.height)).image;

    const align = checkAlignment(ra, rb);
    assert.equal(align.dx % 4, 0);
    const d = diffPair(ra, rb);
    assert.equal(d.width, CANONICAL_W);
    assert.equal(d.height, CANONICAL_H);
    assert.equal(d.delta.rgba.length, CANONICAL_W * CANONICAL_H * 4);
    const c = classifyDelta(d);
    console.log(
      `    cross-card diff (NOT a pair measurement): ${c.deltaClass} — ${c.reason}`,
    );
    assert.ok(['null', 'frame', 'full'].includes(c.deltaClass));
  });

  it('round-trips a real scan through the PNG codec unchanged', () => {
    // encodePng is how a delta image gets written as evidence, so it has to
    // survive a real catalog raster and not just a synthetic one.
    const img = decodePng(readFileSync(smokeScanPath(HERE, SMOKE_SCANS[0]!.file)));
    const round = decodePng(encodePng(img));
    assert.equal(round.width, img.width);
    assert.equal(round.height, img.height);
    assert.deepEqual(round.rgba, img.rgba);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// The frame registry, and the two claims it has to earn.
//
//  1. RESOLUTION IS DERIVED. A file's frame comes from its recorded provenance
//     plus its own raster, never from something a caller said; and when nothing
//     matches, the answer is `unknown` and authoring is BLOCKED rather than
//     guessed. A silently wrong-frame mask is a stencil cut for the wrong
//     picture that nothing downstream can tell apart from a good one.
//
//  2. CROSS-FRAME AGREEMENT. The whole reason to declare transforms is that one
//     mask, authored once in canonical space, should be the same mask over any
//     registered framing of that card. So: draw the same card-fraction shape in
//     two different framings, warp both to canonical through the registry, and
//     they must land on each other. With a NEGATIVE CONTROL — warp one through
//     the wrong transform and watch the same assertion fail — because a
//     tolerance test that cannot fail is not a test.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_H, CANONICAL_W } from '@foilkit/core';
import {
  applyHomography,
  assertAuthorable,
  AUTHORING_FRAME_ID,
  CANONICAL_FRAME_ID,
  frameById,
  invertHomography,
  loadFrames,
  resolveFrame,
  UNKNOWN_FRAME_ID,
  warpAlphaToCanonical,
  type FrameRecord,
} from '../frames.ts';

const reg = loadFrames();

// ── The registry itself ────────────────────────────────────────────────────

test('the registry was built against the current canonical space', () => {
  assert.equal(reg.canonical.width, CANONICAL_W);
  assert.equal(reg.canonical.height, CANONICAL_H);
});

test('every record carries n, a measurement date and a verdict', () => {
  for (const f of reg.frames) {
    assert.equal(typeof f.measuredOn, 'string', `${f.id} has no measuredOn`);
    assert.equal(typeof f.n, 'number', `${f.id} has no n`);
    assert.ok(f.verdict, `${f.id} has no verdict`);
    assert.equal(f.toCanonical.length, 3);
  }
});

test('every transform maps its own frame onto the canonical raster exactly', () => {
  for (const f of reg.frames) {
    const m = f.margins?.median ?? [0, 0, 0, 0];
    const [w, h] = f.raster;
    // The printed card occupies [l, w-r] x [t, h-b]; that box IS canonical space.
    const tl = applyHomography(f.toCanonical, m[0], m[1]);
    const br = applyHomography(f.toCanonical, w - m[2], h - m[3]);
    assert.ok(Math.abs(tl[0]) < 1e-6 && Math.abs(tl[1]) < 1e-6, `${f.id}: top-left maps to ${tl.join(',')}`);
    assert.ok(
      Math.abs(br[0] - CANONICAL_W) < 1e-6 && Math.abs(br[1] - CANONICAL_H) < 1e-6,
      `${f.id}: bottom-right maps to ${br.join(',')}`,
    );
  }
});

test('a per-card-variable record says so in a FIELD, not only in prose', () => {
  // 4a found groups that share a host and a raster and are genuinely two
  // framings. WOTC at 600x825 is the loud one: real per-card border variation.
  const wotc = frameById('assets.tcgdex.net-600x825-wotc', reg);
  assert.ok(wotc, 'the wotc record is missing');
  assert.equal(wotc!.perCardVariance, true);
  assert.ok(wotc!.margins, 'a median transform must publish the spread it is a median of');
  assert.ok(
    Math.max(...wotc!.margins!.sd) > 5,
    'the wotc spread is the reason this record exists — if it is small, re-measure',
  );

  // And nothing that folded in as a pure resample may claim to be measured
  // more finely than it is.
  for (const f of reg.frames) {
    if (f.verdict === 'pure-resample' || f.verdict === 'identity') {
      assert.notEqual(f.perCardVariance, true, `${f.id} is flagged variable but its verdict says otherwise`);
    } else {
      assert.equal(f.perCardVariance, true, `${f.id} has verdict ${f.verdict} but is not flagged variable`);
    }
  }
});

test('no record CLAIMS a printing — `shows` is derived, and nothing has derived it', () => {
  // 4a Part 3 swept haloDesat over all 3,493 assets and recorded `unknown` on
  // every one: the detector was never calibrated on flat catalog scans and its
  // own control was inconsistent, so it ABSTAINED. `normal` is a reasonable
  // expectation for a bulk catalog source and it is still not a measurement —
  // and a field that says `normal` off the back of an abstention is
  // indistinguishable, downstream, from one that was measured.
  //
  // This is the gate for that. Writing a printing in requires calibrating the
  // detector first (tag-block-cropped scans) and then coming here to say which
  // records the calibration covers.
  for (const f of reg.frames) {
    assert.equal(
      f.shows,
      'unknown',
      `${f.id} claims shows="${f.shows}". Nothing has measured the printing any source depicts — see 4a Part 3. ` +
        'A record may only claim one once a calibrated detector has said so, and this test is where that is recorded.',
    );
    assert.ok(f.showsBasis, `${f.id} has no showsBasis — an abstention has to say why it abstained`);
  }
});

test('`unknown` means NO CLAIM, and nothing in the frame layer reads it as one', () => {
  // The compositor rule: only a MEASURED `reverse` may suppress an overlay.
  // The defensive mistake to guard against is a consumer treating "not normal"
  // as "reverse". Nothing branches on `shows` today (it is recorded and never
  // gated on, by design), so the guard is that `unknown` is a value of its own
  // and never collapses into one of the printings.
  const printings: string[] = ['normal', 'reverse', 'holo'];
  for (const f of reg.frames) {
    assert.ok(!printings.includes(f.shows), `${f.id}: unknown must not be aliased to a printing`);
  }
});

test('a group whose samples span two store rasters does not fold into a pure record', () => {
  // images.pokemontcg.io promo-mc: 4a's verdict is `inconsistent` and the
  // cause is the RASTER, not the margins — 8 samples at 600x837 and 2 at
  // 600x825, with 0 px of margin and sd 0 on all four sides. Margin-only
  // reasoning calls that flat and tight and folds it into the unscoped
  // pure-resample record, which inflates that record's n with samples that are
  // not at its raster.
  const mixed = frameById('images.pokemontcg.io-600x837-promo-mc', reg);
  assert.ok(mixed, 'the raster-mixed promo-mc record is missing');
  assert.equal(mixed!.verdict, 'inconsistent');
  assert.equal(mixed!.perCardVariance, true);
  assert.deepEqual(mixed!.margins?.median, [0, 0, 0, 0], 'its margins really are flat — the raster is the finding');
  assert.ok(mixed!.mixedStoreRasters, 'the raster split must be a field, not only prose');
  assert.equal(
    mixed!.n,
    mixed!.mixedStoreRasters!.find((r) => r.raster[0] === 600 && r.raster[1] === 837)?.n,
    'n must count only the samples at THIS record\'s raster',
  );
  assert.ok(mixed!.mixedStoreRasters!.length > 1);

  // …and the unscoped record it used to inflate now counts only its own.
  const unscoped = frameById('images.pokemontcg.io-600x837', reg)!;
  assert.equal(unscoped.mixedStoreRasters, undefined);
  assert.equal(unscoped.n, 30, 'the pure 600x837 record must not carry the promo-mc samples');

  // Every record that reports a split must account for every sample in it.
  for (const f of reg.frames) {
    if (!f.mixedStoreRasters) continue;
    const own = f.mixedStoreRasters.find((r) => r.raster[0] === f.raster[0] && r.raster[1] === f.raster[1]);
    assert.ok(own, `${f.id} reports a raster split that does not include its own raster`);
    assert.equal(f.n, own!.n, `${f.id}: n must be the count at its own raster`);
  }
});

test('canonical is the identity, and it exists so a promotion is a data change', () => {
  const c = frameById(CANONICAL_FRAME_ID, reg)!;
  assert.deepEqual(c.raster, [CANONICAL_W, CANONICAL_H]);
  assert.deepEqual(c.toCanonical, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
});

// ── Resolution ─────────────────────────────────────────────────────────────

test('a mask raster resolves with no source URL at all — the raster IS the provenance', () => {
  assert.equal(resolveFrame({ width: CANONICAL_W, height: CANONICAL_H }).frameId, CANONICAL_FRAME_ID);
  assert.equal(resolveFrame({ width: 490, height: 674 }).frameId, AUTHORING_FRAME_ID);
});

test('an era-scoped record beats the unscoped one on the same host and raster', () => {
  const tcgdex = 'https://assets.tcgdex.net/en/base/base1/8/high.png';
  assert.equal(
    resolveFrame({ sourceUrl: tcgdex, width: 600, height: 825, eraId: 'wotc' }).frameId,
    'assets.tcgdex.net-600x825-wotc',
  );
  assert.equal(
    resolveFrame({ sourceUrl: tcgdex, width: 600, height: 825, eraId: 'modern-sv' }).frameId,
    'assets.tcgdex.net-600x825',
  );
  // Without the era it falls back to the unscoped record. That is the honest
  // answer, not a wrong one: the unscoped record is what the host does by
  // default and the era is what carves the exception out.
  assert.equal(resolveFrame({ sourceUrl: tcgdex, width: 600, height: 825 }).frameId, 'assets.tcgdex.net-600x825');
});

test('resolution surfaces per-card variance so a caller cannot trust it blindly', () => {
  const r = resolveFrame({
    sourceUrl: 'https://assets.tcgdex.net/en/base/base1/8/high.png',
    width: 600,
    height: 825,
    eraId: 'wotc',
  });
  assert.equal(r.perCardVariance, true);
  assert.equal(resolveFrame({ width: CANONICAL_W, height: CANONICAL_H }).perCardVariance, false);
});

test('an unregistered raster resolves to unknown and BLOCKS authoring', () => {
  const r = resolveFrame({ width: 1000, height: 1400 });
  assert.equal(r.frame, null);
  assert.equal(r.frameId, UNKNOWN_FRAME_ID);
  assert.match(r.basis, /1000x1400/);
  assert.throws(() => assertAuthorable(r), /mask authoring is blocked/);
});

test('an unknown host at a known raster does not borrow another host\'s transform', () => {
  const r = resolveFrame({ sourceUrl: 'https://example.invalid/x.png', width: 600, height: 837 });
  // The raster is registered (pokemontcg.io holds it) but the host is not. A
  // hostless record keyed on this raster does not exist, so: unknown.
  assert.equal(r.frameId, UNKNOWN_FRAME_ID);
});

test('a malformed source URL degrades to raster-only resolution, never to a throw', () => {
  assert.equal(resolveFrame({ sourceUrl: 'not a url', width: 490, height: 674 }).frameId, AUTHORING_FRAME_ID);
});

// ── Cross-frame agreement ──────────────────────────────────────────────────

/** Rasterize a rect given in CARD FRACTIONS into a frame's own raster. */
function drawFractionalRect(
  frame: FrameRecord,
  rect: [number, number, number, number],
): { alpha: Uint8Array; w: number; h: number } {
  const [w, h] = frame.raster;
  const m = frame.margins?.median ?? [0, 0, 0, 0];
  // The card occupies [l, w-r] x [t, h-b] of this frame; fractions are OF THE
  // CARD, so they are laid out inside that box and not inside the raster.
  const cardX = m[0];
  const cardY = m[1];
  const cardW = w - m[0] - m[2];
  const cardH = h - m[1] - m[3];
  const x0 = cardX + rect[0] * cardW;
  const y0 = cardY + rect[1] * cardH;
  const x1 = x0 + rect[2] * cardW;
  const y1 = y0 + rect[3] * cardH;
  const alpha = new Uint8Array(w * h);
  const ss = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (px >= x0 && px < x1 && py >= y0 && py < y1) hits++;
        }
      }
      alpha[y * w + x] = Math.round((hits / (ss * ss)) * 255);
    }
  }
  return { alpha, w, h };
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const A = a[i]! >= 128;
    const B = b[i]! >= 128;
    if (A && B) inter++;
    if (A || B) union++;
  }
  return union === 0 ? 1 : inter / union;
}

function toCanonicalAlpha(frame: FrameRecord, rect: [number, number, number, number], via = frame): Uint8Array {
  const { alpha, w, h } = drawFractionalRect(frame, rect);
  return warpAlphaToCanonical(alpha, w, h, via.toCanonical, CANONICAL_W, CANONICAL_H);
}

// The modern-sv art window — a real rect out of era-layouts.json, so this is
// measuring the shape masks are actually authored around.
const ART_WINDOW: [number, number, number, number] = [0.075, 0.0981, 0.85, 0.3749];

/**
 * TOLERANCE. Both framings resample the whole card, so the only disagreement is
 * resampling: two different source grids sampled onto one 504x704 grid, each
 * quantising the same continuous edge. The residual is confined to a
 * one-pixel-wide boundary band, which for this rect is roughly 0.4% of its
 * area — so 0.99 IoU is a real bar and not a rubber stamp. Stated as a
 * fraction of the shape, on purpose: an absolute pixel count would mean
 * different things at different rect sizes.
 */
const IOU_TOLERANCE = 0.99;

test('one mask over two registered framings of the same card lands within tolerance', () => {
  const tcgdex = frameById('assets.tcgdex.net-600x825', reg)!;
  const ptcg = frameById('images.pokemontcg.io-600x837', reg)!;
  // Different rasters, different aspects (825 vs 837 tall at 600 wide), both
  // pure resamples of the whole card.
  assert.notDeepEqual(tcgdex.raster, ptcg.raster);

  const a = toCanonicalAlpha(tcgdex, ART_WINDOW);
  const b = toCanonicalAlpha(ptcg, ART_WINDOW);
  const score = iou(a, b);
  assert.ok(score >= IOU_TOLERANCE, `IoU ${score.toFixed(5)} < ${IOU_TOLERANCE} across framings`);
});

test('the small-raster framings agree with the large ones too', () => {
  const big = frameById('assets.tcgdex.net-600x825', reg)!;
  const small = frameById('assets.tcgdex.net-245x337', reg)!;
  const score = iou(toCanonicalAlpha(big, ART_WINDOW), toCanonicalAlpha(small, ART_WINDOW));
  // The 245-wide source is upsampled 2.06x, so its edge band is coarser. Held
  // to the same bar because the bar is about the SHAPE agreeing, not the
  // sampling density.
  assert.ok(score >= IOU_TOLERANCE, `IoU ${score.toFixed(5)} < ${IOU_TOLERANCE} across rasters`);
});

/**
 * THE POSITIVE CASE THAT NEEDS THE MATRIX.
 *
 * Both tests above pair two ZERO-MARGIN framings, and a zero-margin transform
 * is a pure scale with no translation — so they agree even if the translation
 * terms are dropped on the floor, and a mutation that ignores half the matrix
 * survives them. (It did: 1.000000 between two of them.) The whole claim of the
 * registry is that a mask authored once lands on any REGISTERED framing, and
 * the framings that make that claim non-trivial are the ones that carry margin.
 *
 * So: a zero-margin source against an INSET one. `images.pokemontcg.io-245x342`
 * for the `ex` era is inset 0/3/0/2 px L/T/R/B — measured on 2 samples at sd 0,
 * i.e. an exact framing rather than a median over disagreement — and the card
 * therefore does NOT fill its raster. Agreement here is only reachable through
 * the translation, and the negative half below proves that by dropping it.
 */
const INSET_FRAME_ID = 'images.pokemontcg.io-245x342-ex';

test('a zero-margin framing and an INSET one land on each other — the transform is load-bearing', () => {
  const flat = frameById('assets.tcgdex.net-600x825', reg)!;
  const inset = frameById(INSET_FRAME_ID, reg)!;
  assert.deepEqual(flat.margins?.median ?? [0, 0, 0, 0], [0, 0, 0, 0], 'the flat side of the pair must be flat');
  assert.ok(
    (inset.margins?.median ?? [0, 0, 0, 0]).some((m) => m > 0),
    `${INSET_FRAME_ID} must carry margin or this pair proves nothing`,
  );

  const score = iou(toCanonicalAlpha(flat, ART_WINDOW), toCanonicalAlpha(inset, ART_WINDOW));
  assert.ok(score >= IOU_TOLERANCE, `IoU ${score.toFixed(6)} < ${IOU_TOLERANCE} across a flat/inset pair`);
});

test('MUTATION CONTROL: the same pair through a margin-ignoring transform FAILS', () => {
  // The mutation this catches is "resample the raster and forget the margin" —
  // i.e. use the pure scale the raster alone implies. That is a real bug shape
  // (it is what a consumer does if it reads `raster` and skips `toCanonical`),
  // and the test above must not survive it.
  const flat = frameById('assets.tcgdex.net-600x825', reg)!;
  const inset = frameById(INSET_FRAME_ID, reg)!;
  const rasterOnly: FrameRecord = {
    ...inset,
    toCanonical: [
      [CANONICAL_W / inset.raster[0], 0, 0],
      [0, CANONICAL_H / inset.raster[1], 0],
      [0, 0, 1],
    ],
  };
  const score = iou(toCanonicalAlpha(flat, ART_WINDOW), toCanonicalAlpha(inset, ART_WINDOW, rasterOnly));
  assert.ok(
    score < IOU_TOLERANCE,
    `ignoring ${INSET_FRAME_ID}'s 0/3/0/2 px inset still scored IoU ${score.toFixed(6)} — the positive case above ` +
      'does not actually depend on the transform',
  );
});

test('NEGATIVE CONTROL: the wrong transform fails the same assertion', () => {
  // A test that cannot fail proves nothing. Warp the WOTC framing — which
  // carries real margin — through the unscoped modern transform, i.e. exactly
  // the mistake the era-scoped record exists to prevent, and the agreement
  // must collapse through the tolerance.
  const wotc = frameById('assets.tcgdex.net-600x825-wotc', reg)!;
  const wrong = frameById('assets.tcgdex.net-600x825', reg)!;
  const right = toCanonicalAlpha(wotc, ART_WINDOW);
  const misregistered = toCanonicalAlpha(wotc, ART_WINDOW, wrong);
  const score = iou(right, misregistered);
  assert.ok(
    score < IOU_TOLERANCE,
    `misregistering WOTC through the modern transform scored IoU ${score.toFixed(5)}, which the tolerance ` +
      'would have accepted — the tolerance is too loose to catch a wrong frame',
  );
});

// ── Every era-scoped record, against its own measured floor ────────────────
//
// WHY 0.99 IS THE WRONG BAR HERE. The test above passes because WOTC's margins
// are large. Swept across all the era-scoped records, 6 of 14 misregistrations
// score AT OR ABOVE 0.99 and would have been accepted — four because the record
// carries no margin at all (its transform is literally the same matrix, so
// there is no misregistration to catch), and one real one:
// `assets.tcgdex.net-600x825-dp`, 5.5 px of bottom margin, IoU 0.9924. A single
// global tolerance cannot be both loose enough for resampling noise and tight
// enough for a 5.5 px misregistration.
//
// So each record is held to ITS OWN floor instead. Both shapes here are
// axis-aligned rects — an affine of a rect is a rect — so the IoU the two
// transforms PREDICT can be computed exactly from the four corners, with no
// rasterizing. The assertion is that the measured (rasterized) IoU matches that
// prediction to within the one-pixel sampling band.
//
// That is strictly stronger than "below 0.99" in both directions: a warp that
// ignored the matrix would measure 1.0 against a prediction of 0.93 and fail
// loudly, and a record whose transform is genuinely identical to the unscoped
// one predicts 1.0 and is asserted to be identical rather than pretending to be
// a control it is not.

/** Where a fractional rect lands in this frame's raster — the box, not the pixels. */
function frameRectPx(frame: FrameRecord, rect: [number, number, number, number]): [number, number, number, number] {
  const [w, h] = frame.raster;
  const m = frame.margins?.median ?? [0, 0, 0, 0];
  const cardW = w - m[0] - m[2];
  const cardH = h - m[1] - m[3];
  const x0 = m[0] + rect[0] * cardW;
  const y0 = m[1] + rect[1] * cardH;
  return [x0, y0, x0 + rect[2] * cardW, y0 + rect[3] * cardH];
}

/** IoU of two axis-aligned rects, exactly. */
function rectIou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

function canonicalRect(frame: FrameRecord, rect: [number, number, number, number], via = frame): [number, number, number, number] {
  const [x0, y0, x1, y1] = frameRectPx(frame, rect);
  const tl = applyHomography(via.toCanonical, x0, y0);
  const br = applyHomography(via.toCanonical, x1, y1);
  return [tl[0], tl[1], br[0], br[1]];
}

/**
 * Sampling band. Both sides rasterize the same continuous edge onto a 504x704
 * grid at 4x4 supersampling, so the measured IoU sits within a fraction of a
 * pixel of the analytic one. Measured spread over all 14 records on
 * 2026-09-01: max |measured - predicted| = 0.00367.
 */
const RASTER_BAND = 0.005;

for (const scoped of reg.frames.filter((f) => f.detect.eras)) {
  test(`era-scoped negative control: ${scoped.id} is held to its own measured floor`, () => {
    const unscoped = reg.frames.find(
      (f) =>
        !f.detect.eras &&
        f.detect.host === scoped.detect.host &&
        f.detect.raster[0] === scoped.detect.raster[0] &&
        f.detect.raster[1] === scoped.detect.raster[1],
    );
    assert.ok(unscoped, `${scoped.id} has no unscoped peer — it cannot be misregistered onto one`);

    const predicted = rectIou(canonicalRect(scoped, ART_WINDOW), canonicalRect(scoped, ART_WINDOW, unscoped!));
    const measured = iou(toCanonicalAlpha(scoped, ART_WINDOW), toCanonicalAlpha(scoped, ART_WINDOW, unscoped!));

    if (predicted >= 1) {
      // Not a negative control, and saying so is the point. These records exist
      // because 4a's samples DISAGREED (perCardVariance), not because their
      // median registration differs from the host default — it does not.
      assert.deepEqual(
        scoped.toCanonical,
        unscoped!.toCanonical,
        `${scoped.id} predicts perfect agreement with ${unscoped!.id} but carries a different matrix`,
      );
      assert.equal(measured, 1, `${scoped.id} has the same transform as ${unscoped!.id} but did not warp identically`);
      return;
    }

    assert.ok(
      Math.abs(measured - predicted) <= RASTER_BAND,
      `${scoped.id}: misregistering through ${unscoped!.id} measured IoU ${measured.toFixed(6)} but its margins ` +
        `${(scoped.margins?.median ?? []).join('/')} predict ${predicted.toFixed(6)}. A measurement ABOVE the ` +
        'prediction means the transform is not being applied; BELOW means the warp is losing more than the ' +
        'geometry accounts for.',
    );
    assert.ok(measured < 1, `${scoped.id}: a real misregistration must be detectable, but IoU came back 1.0`);
  });
}

test('warping canonical through the identity is a no-op', () => {
  const c = frameById(CANONICAL_FRAME_ID, reg)!;
  const { alpha } = drawFractionalRect(c, ART_WINDOW);
  const round = warpAlphaToCanonical(alpha, CANONICAL_W, CANONICAL_H, c.toCanonical, CANONICAL_W, CANONICAL_H);
  assert.deepEqual(Array.from(round), Array.from(alpha));
});

test('invertHomography actually inverts', () => {
  for (const f of reg.frames) {
    const inv = invertHomography(f.toCanonical);
    const [x, y] = applyHomography(inv, ...applyHomography(f.toCanonical, 123, 234));
    assert.ok(Math.abs(x - 123) < 1e-6 && Math.abs(y - 234) < 1e-6, `${f.id} round-trip gave ${x},${y}`);
  }
});

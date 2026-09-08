// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// Locks the claims this lane actually makes, in the order they matter:
//   1. the vector-ness measure points the right way, and is not measuring the tracer;
//   2. vector -> raster -> vector is faithful;
//   3. the optional element is DISCOVERED, not asserted;
//   4. the me05-014 sliver ruling — his correction, encoded;
//   5. anti-collapse: no unreviewed `ai` mask can ever reach the fitter.
//
// 4 and 5 read the real corpus. If the corpus moves, these should move with it — that is
// the point of a corpus test, and they fail loudly rather than silently drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../png.ts';
import { alphaOf, EXEMPLAR_WEIGHT } from '../provenance.ts';
import { readCorpus, selectExemplars } from '../mask-corpus.ts';
import {
  vectorizeLoop, vectorness, rasterizeTemplate, flattenPath, subpixelLoops,
  discoverOptionalElement, fitTemplate, probeOptional, toBin01, mapPathCoords,
  reversePath, serializeMaskVector, parseMaskVector, rasterizeMaskVector, BadMaskVector,
  MASK_VECTOR_VERSION, MASK_VECTOR_MAX_COORD_SPANS, PathTooComplex,
  DEFAULT_VECTOR_FIT_PARAMS, type VectorTemplate, type VPath, type MaskVector,
} from '../vector-template.ts';
import { traceLoops } from '../line-snap.ts';
import { iou } from '../region-learn.ts';
import { CANONICAL_H, CANONICAL_W } from '@foilkit/core';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const MASKS_DIR = join(ROOT, 'data/foil-masks');
const TEMPLATE_FILE = join(ROOT, 'data', 'vector-templates.json');
// Canonical space (4b): 504 x 704. Derived, not typed — the same expression the
// editor and the generators use, so this test cannot pass against a raster the
// corpus no longer lives in.
const W = CANONICAL_W;
const H = CANONICAL_H;

// ── helpers ────────────────────────────────────────────────────────────────

/** A filled rounded rectangle, antialiased by 4x4 supersampling — a clean vector shape. */
function roundedRect(w: number, h: number, x0: number, y0: number, x1: number, y1: number, r: number): Uint8Array {
  const a = new Uint8Array(w * h);
  const ss = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
        const cx = Math.min(Math.max(px, x0 + r), x1 - r);
        const cy = Math.min(Math.max(py, y0 + r), y1 - r);
        const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1 && Math.hypot(px - cx, py - cy) <= r + 1e-9;
        if (inside) hit++;
      }
      a[y * w + x] = Math.round((hit / (ss * ss)) * 255);
    }
  }
  return a;
}

/** The same shape with its boundary pushed around by a deterministic ±1px wobble. */
function wobbled(w: number, h: number, x0: number, y0: number, x1: number, y1: number, r: number): Uint8Array {
  const a = new Uint8Array(w * h);
  const jitter = (y: number): number => (Math.sin(y * 1.7) + Math.sin(y * 0.53)) * 0.9;
  for (let y = 0; y < h; y++) {
    const j = jitter(y);
    const base = roundedRect(w, 1, x0 + j, y0 - y, x1 + j, y1 - y, r);
    for (let x = 0; x < w; x++) a[y * w + x] = base[x]!;
  }
  return a;
}

const loadTemplate = (): VectorTemplate => JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8')).templates[0];

const shareIn = (a: Uint8Array, x0: number, y0: number, x1: number, y1: number): number => {
  let f = 0, t = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { t++; if (a[y * W + x]! >= 128) f++; }
  return f / t;
};

// ── 1. the measure points the right way, and measures the MASK ─────────────

test('vectorness: a clean vector shape needs far fewer primitives than a wobbly one', () => {
  const clean = roundedRect(200, 200, 20, 20, 180, 180, 18);
  const noisy = wobbled(200, 200, 20, 20, 180, 180, 18);
  const vc = vectorness(clean, 200, 200);
  const vn = vectorness(noisy, 200, 200);

  assert.ok(vc.primitivesPerKpx < vn.primitivesPerKpx,
    `clean ${vc.primitivesPerKpx} should need fewer primitives/kpx than wobbly ${vn.primitivesPerKpx}`);
  assert.ok(vc.explainedLong > vn.explainedLong,
    `clean ${vc.explainedLong} should carry more length in long primitives than wobbly ${vn.explainedLong}`);
  assert.ok(vc.residualPx < vn.residualPx,
    `clean ${vc.residualPx}px residual should be under wobbly ${vn.residualPx}px`);
});

test('vectorness measures the MASK, not the tracer: a diagonal is not "axis aligned"', () => {
  // THE TRAP THIS LOCKS: `traceLoops` is crack-following, so its contour is a rectilinear
  // staircase and EVERY run comes out exactly horizontal or vertical. Measured on that, a
  // 45-degree edge scores 100% axis-aligned and 0px residual — the measure would be
  // reporting the tracer. `vectorness` uses the sub-pixel half-level contour instead.
  const w = 160, h = 160;
  const diag = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = (x - y) / Math.SQRT2;               // signed distance to the 45-degree line
    diag[y * w + x] = Math.round(Math.min(1, Math.max(0, 0.5 - d)) * 255);
  }
  const v = vectorness(diag, w, h);
  assert.ok(v.axisAlignedFrac < 0.5,
    `a 45-degree boundary must not read as axis-aligned; got ${v.axisAlignedFrac}`);

  // And prove the staircase really would have lied, so this test cannot rot into a tautology.
  const staircase = traceLoops(toBin01(diag), w, h);
  assert.ok(staircase.length > 0, 'traceLoops should still find the shape');
  const steps = staircase[0]!;
  const axisOnly = steps.every((p, i) => {
    const q = steps[(i + 1) % steps.length]!;
    return p.x === q.x || p.y === q.y;
  });
  assert.ok(axisOnly, 'traceLoops is a rectilinear staircase — that is exactly why it must not be the measure');
});

// ── 2. round trip ──────────────────────────────────────────────────────────

test('vector -> raster round trip is faithful on a shape that IS lines and arcs', () => {
  const src = roundedRect(220, 180, 25, 22, 195, 158, 20);
  const loops = subpixelLoops(src, 220, 180);
  assert.equal(loops.length, 1, 'one closed boundary');
  const fit = vectorizeLoop(loops[0]!, DEFAULT_VECTOR_FIT_PARAMS);
  assert.ok(fit, 'the loop vectorises');
  assert.ok(fit!.arcs >= 4, `a rounded rect should fit at least 4 arcs, got ${fit!.arcs}`);
  assert.ok(fit!.primitives <= 24, `and stay economical, got ${fit!.primitives} primitives`);

  const tpl: VectorTemplate = {
    id: 't', version: 1, eraId: 'x', scope: 'sheet',
    space: { width: 220, height: 180 },
    // Through the shipped converter, not a hand-rolled ternary. The ternary this replaces
    // read "line or arc" and MEANT "line or not-a-line", so it silently mis-scaled the day
    // a third primitive existed; `mapPathCoords` switches exhaustively instead.
    outer: mapPathCoords(fit!.path, ([x, y]) => [x / 220, y / 180], (r) => r / 220),
    holes: [],
    provenance: {
      generator: { name: 'test', version: 1, modelId: null, runId: 'test' },
      exemplars: [], fittedAt: '', params: DEFAULT_VECTOR_FIT_PARAMS, statement: '',
    },
  };
  const back = rasterizeTemplate(tpl, 220, 180, { evolves: false });
  assert.ok(iou(back, src) >= 0.99, `round trip IoU ${iou(back, src)} should be >= 0.99`);
});

test('arc flattening honours its sagitta bound', () => {
  const path: VPath = { start: [0, 0], prims: [
    { k: 'arc', to: [100, 100], r: 100, sweep: 1 },
    { k: 'line', to: [0, 0] },
  ] };
  const coarse = flattenPath(path, 1.0);
  const fine = flattenPath(path, 0.02);
  assert.ok(fine.length > coarse.length, 'a tighter sagitta means more chords');

  // Every flattened vertex must lie on ONE common circle of radius 100. Deriving the centre
  // here with the same formula the implementation uses would only prove it agrees with
  // itself, so recover the centre from the flattened points instead (perpendicular
  // bisectors of two chords) and check the radius that falls out.
  const arcPts = fine.slice(0, -1);                       // drop the closing line's endpoint
  const [a, b, c] = [arcPts[0]!, arcPts[Math.floor(arcPts.length / 2)]!, arcPts[arcPts.length - 1]!];
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  assert.ok(Math.abs(Math.hypot(a.x - ux, a.y - uy) - 100) < 0.05, 'the recovered radius is the one asked for');
  for (const p of arcPts) {
    assert.ok(Math.abs(Math.hypot(p.x - ux, p.y - uy) - 100) < 0.05,
      `flattened point (${p.x.toFixed(2)},${p.y.toFixed(2)}) should lie on the arc`);
  }
});

// ── 3. the optional element is discovered, not asserted ────────────────────

test('discoverOptionalElement finds the one blob two groups differ by, and ignores edge noise', () => {
  const w = 120, h = 120;
  const make = (withBlob: boolean, seed: number): Uint8Array => {
    const a = new Uint8Array(w * h);
    for (let y = 12; y < 108; y++) for (let x = 12; x < 108; x++) a[y * w + x] = 255;
    // ±1px registration noise along the left edge — the thing that must NOT be found.
    const j = seed % 2;
    for (let y = 12; y < 108; y++) a[y * w + 12 + j] = 255;
    if (!withBlob) return a;
    for (let y = 20; y < 45; y++) for (let x = 20; x < 45; x++) a[y * w + x] = 0;
    return a;
  };
  const masks = [
    { cardId: 'a', alpha: make(false, 0) }, { cardId: 'b', alpha: make(false, 1) },
    { cardId: 'c', alpha: make(true, 0) }, { cardId: 'd', alpha: make(true, 1) },
  ];
  const opt = discoverOptionalElement(masks, w, h);
  assert.ok(opt, 'an optional element should be found');
  assert.ok(opt!.separation > 0.5, `the split should be decisive, got ${opt!.separation}`);
  assert.ok(opt!.px > 400 && opt!.px < 800, `the region should be the 25x25 blob, got ${opt!.px}px`);
  const has = opt!.shares.filter((s) => s.share < opt!.split).map((s) => s.cardId).sort();
  assert.deepEqual(has, ['c', 'd'], 'exactly the two masks with the blob');
});

test('a corpus with no optional element does not invent one', () => {
  const w = 90, h = 90;
  const plain = (j: number): Uint8Array => {
    const a = new Uint8Array(w * h);
    for (let y = 10; y < 80; y++) for (let x = 10 + (j % 2); x < 80; x++) a[y * w + x] = 255;
    return a;
  };
  const opt = discoverOptionalElement([0, 1, 2, 3].map((j) => ({ cardId: `m${j}`, alpha: plain(j) })), w, h);
  assert.equal(opt, null, 'boundary registration noise alone is not an optional element');
});

// ── 4. THE SLIVER RULING — his correction, encoded ─────────────────────────

test("the me05-014 sliver ruling: the colour trapped by the medallion IS foil", () => {
  // codified/modern-sv.md pass 1 flagged this as the open question: region-learn@1 dropped a
  // narrow coloured sliver pinched between the evolution medallion and the border ring
  // because it was "not part of the largest coloured component", and recorded that "Chey has
  // never ruled on that sliver". He has now — he added it back on every Stage-1 card he
  // corrected. This test is that ruling.
  if (!existsSync(TEMPLATE_FILE)) return;                      // template not fitted yet
  const box = { x0: 20, y0: 43, x1: 44, y1: 58 };
  const tpl = loadTemplate();

  const withEl = shareIn(rasterizeTemplate(tpl, W, H, { evolves: true }), box.x0, box.y0, box.x1, box.y1);
  const without = shareIn(rasterizeTemplate(tpl, W, H, { evolves: false }), box.x0, box.y0, box.x1, box.y1);

  // On a card with no medallion the whole box is coloured frame, so it is all foil.
  assert.ok(without > 0.95, `basic layout should be solid foil in this box, got ${without.toFixed(3)}`);

  // On a card WITH the medallion the box is part sliver, part medallion. Chey's four
  // corrected Stage-1 masks all sit at 35-40%; region-learn@1 sat at 0.0%. The template
  // must be with him, and must NOT be at zero.
  assert.ok(withEl > 0.20, `the sliver must survive the medallion cut-out — got ${withEl.toFixed(3)}, region-learn@1 scored 0.000 here`);
  assert.ok(withEl < 0.60, `but the medallion itself must still be cut — got ${withEl.toFixed(3)}`);

  for (const [card, vid] of [['me05-006', '37193'], ['me05-010', '37200'], ['me05-014', '37207'], ['me05-024', '37225']]) {
    const p = join(MASKS_DIR, card!, `${vid}.png`);
    if (!existsSync(p)) continue;
    const his = alphaOf(decodePng(readFileSync(p)));
    const hisShare = shareIn(his, box.x0, box.y0, box.x1, box.y1);
    assert.ok(Math.abs(hisShare - withEl) < 0.12,
      `${card}: template ${withEl.toFixed(3)} should track his ${hisShare.toFixed(3)} in the sliver box`);
  }
});

// ── 5. anti-collapse ───────────────────────────────────────────────────────

test('no unreviewed `ai` mask can reach the template fitter', async () => {
  const corpus = await readCorpus(MASKS_DIR);
  const sel = selectExemplars(corpus, { eraId: 'modern-sv', scope: 'sheet' });
  assert.ok(sel.chosen.length > 0, 'the modern-sv sheet corpus should not be empty');
  for (const e of sel.chosen) {
    assert.notEqual(e.sidecar.derivation_method, 'ai', `${e.cardId}/${e.variantId} is unreviewed machine output`);
    assert.ok(EXEMPLAR_WEIGHT[e.sidecar.derivation_method] > 0, 'every chosen exemplar has positive weight');
  }
  // And the rejection is reported, not silent.
  const aiInCorpus = corpus.filter((c) => c.sidecar.derivation_method === 'ai');
  for (const a of aiInCorpus) {
    assert.ok(sel.rejected.some((r) => r.cardId === a.cardId && r.variantId === a.variantId),
      `${a.cardId}/${a.variantId} is 'ai' and must appear in rejected[] with a reason`);
  }
});

test('fitTemplate refuses when no exemplar shows the base layout', () => {
  const w = 60, h = 60;
  const a = new Uint8Array(w * h).fill(255);
  assert.throws(
    () => fitTemplate({
      exemplars: [{ cardId: 'x', variantId: 1, method: 'hand', weight: 1, alpha: a, evolves: true }],
      width: w, height: h, eraId: 'e', scope: 'sheet', runId: 'r',
    }),
    /no non-evolving exemplar/,
    'a corpus that is all evolvers cannot define the unconditional layout',
  );
});

test('probeOptional reads the element off the artwork: colour = absent, silver = present', () => {
  const w = 40, h = 40;
  const region = new Uint8Array(w * h);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) region[y * w + x] = 255;
  const paint = (r: number, g: number, b: number): { width: number; height: number; rgba: Uint8Array } => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255; }
    return { width: w, height: h, rgba };
  };
  assert.equal(probeOptional(paint(220, 90, 40), region).hasElement, false, 'a coloured frame means no medallion');
  assert.equal(probeOptional(paint(180, 182, 181), region).hasElement, true, 'silver means the medallion is there');
});

// ══ The mask's own vector artifact — the readable half of a contribution ═════
//
// The whole reason this type exists is that `git diff` on a mask PNG says "Binary files
// differ", and a reviewer who cannot read the change cannot review it. So these tests are all,
// ultimately, about ONE property: the committed text moves when the geometry moves, and NOT
// OTHERWISE.

/** A small closed shape with one curve in it — enough to exercise every primitive kind. */
function sampleVector(handleDx = 0): MaskVector {
  return {
    version: MASK_VECTOR_VERSION,
    space: { width: 200, height: 160 },
    paths: [
      {
        start: [20, 20],
        startType: 'c',
        prims: [
          { k: 'line', to: [180, 20], t: 'c' },
          { k: 'cubic', c1: [180 + handleDx, 80], c2: [180, 120], to: [180, 140], t: 's' },
          { k: 'line', to: [20, 140], t: 'c' },
          { k: 'line', to: [20, 20], t: 'c' },
        ],
      },
      {
        // A hole, wound the other way — nonzero winding cuts it out.
        start: [60, 60],
        prims: [
          { k: 'line', to: [60, 100] },
          { k: 'line', to: [140, 100] },
          { k: 'line', to: [140, 60] },
          { k: 'line', to: [60, 60] },
        ],
      },
    ],
  };
}

test('a re-save of unchanged geometry is BYTE-IDENTICAL — the whole feature rests on this', () => {
  // A file that changes when nothing changed is a file reviewers learn to skip, and a path diff
  // nobody reads is worth exactly what the binary blob it replaced was worth. So: serialise,
  // parse it back the way the server will, serialise again, and compare BYTES, not values.
  const once = serializeMaskVector(sampleVector());
  const twice = serializeMaskVector(parseMaskVector(JSON.parse(once)));
  assert.equal(twice, once, 'a load-and-save round trip must produce no diff at all');

  // …and it survives the float noise a real coordinate transform introduces: 200 * (1/200) is
  // not 1 in binary floating point, and the rounding at the serialiser is what stops that from
  // surfacing as a spurious hunk in somebody's pull request.
  const wobbled = parseMaskVector(JSON.parse(once));
  wobbled.paths[0]!.start = [20 + 1e-12, 20 - 1e-12];
  assert.equal(serializeMaskVector(wobbled), once, 'sub-ulp noise must not reach the committed file');

  assert.ok(once.endsWith('\n'), 'newline-terminated, like every other artifact here');
});

test('the committed text puts ONE PRIMITIVE PER LINE, so moving an anchor is a one-line diff', () => {
  // THE PAYOFF, asserted rather than described. `JSON.stringify(v, null, 2)` breaks every array
  // onto its own lines, so one cubic becomes fourteen lines of single numbers and a two-number
  // edit reads as a fourteen-line hunk. The hand-written layout is what keeps a primitive atomic.
  const before = serializeMaskVector(sampleVector()).split('\n');
  const after = serializeMaskVector(sampleVector(30)).split('\n');

  assert.equal(before.length, after.length, 'moving a handle must not reflow the file');
  const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i): i is number => i !== null);
  assert.equal(changed.length, 1, `exactly one line should change, ${changed.length} did`);

  // And the whole cubic — two handles and an endpoint — really is on that one line, which is
  // the claim this module's own header makes about why cubics are storable at all.
  assert.equal(
    after[changed[0]!],
    '        { "k": "cubic", "c1": [210, 80], "c2": [180, 120], "to": [180, 140], "t": "s" },',
  );
  assert.match(before[changed[0]!]!, /"c1": \[180, 80\]/);
});

test('parseMaskVector refuses what it cannot vouch for, and names the primitive', () => {
  const good = JSON.parse(serializeMaskVector(sampleVector())) as Record<string, unknown>;
  assert.doesNotThrow(() => parseMaskVector(good));

  assert.throws(() => parseMaskVector({ ...good, version: 2 }), /version 2/);
  assert.throws(() => parseMaskVector({ ...good, space: { width: 0, height: 10 } }), /whole pixels/);
  assert.throws(() => parseMaskVector({ ...good, paths: [] }), /non-empty/);
  assert.throws(() => parseMaskVector({ ...good, paths: [{ start: [0, 0], prims: [] }] }), /non-empty/);
  assert.throws(
    () => parseMaskVector({ ...good, paths: [{ start: [0, Number.NaN], prims: [{ k: 'line', to: [1, 1] }] }] }),
    /finite/,
  );
  // A cubic missing a handle is the dangerous one: `undefined` flows into the flattener as NaN,
  // produces an empty polygon rather than an error, and the submission would then be refused
  // for "not describing the pixels" instead of for being broken.
  assert.throws(
    () => parseMaskVector({ ...good, paths: [{ start: [0, 0], prims: [{ k: 'cubic', c1: [1, 1], to: [2, 2] }] }] }),
    /both handles/,
  );
  assert.throws(
    () => parseMaskVector({ ...good, paths: [{ start: [0, 0], prims: [{ k: 'bezier', to: [1, 1] }] }] }),
    /unknown primitive kind/,
  );
  assert.throws(
    () => parseMaskVector({ ...good, paths: [{ start: [0, 0], prims: [{ k: 'line', to: [1, 1], t: 'smooth' }] }] }),
    /must be "s" or "c"/,
  );
  assert.throws(() => parseMaskVector(good, 2), BadMaskVector);
});

test('parseMaskVector refuses a coordinate that is not a point on a card', () => {
  // The cheapest half of the denial-of-service fix. `c1: [1e13, 0]` is finite, parses as a
  // pair, and describes a hull 1e13 across on a 200x160 raster — which the flattener then
  // subdivides to the depth cap. Refusing it at the parse means the expensive question is
  // never asked, and the message says what is wrong rather than reporting an IoU of 0.
  const good = JSON.parse(serializeMaskVector(sampleVector())) as Record<string, unknown>;
  const withPrim = (pr: unknown): unknown => ({ ...good, paths: [{ start: [20, 20], prims: [pr] }] });

  assert.throws(() => parseMaskVector(withPrim({ k: 'cubic', c1: [1e13, 0], c2: [0, 1e13], to: [100, 100] })), /not a point on a card/);
  assert.throws(() => parseMaskVector(withPrim({ k: 'line', to: [1e9, 20] })), /not a point on a card/);
  assert.throws(() => parseMaskVector({ ...good, paths: [{ start: [0, 1e9], prims: [{ k: 'line', to: [20, 20] }] }] }), /not a point on a card/);
  // A radius is a length and gets the same treatment: `acos(1 - sagitta/r)` at r = 1e13 asks
  // the arc flattener for ~5e7 points.
  assert.throws(() => parseMaskVector(withPrim({ k: 'arc', to: [100, 100], r: 1e13, sweep: 1 })), /an arc that flat is a line/);

  // …and a handle OUTSIDE the raster is still perfectly legal, because that is where handles
  // live: pull a direction point off the top edge to flatten a curve and the number is
  // negative. The ceiling is 16 rasters out, not one.
  const w = (good.space as { width: number }).width;
  assert.doesNotThrow(() => parseMaskVector(withPrim({ k: 'cubic', c1: [-w, -20], c2: [w * 2, 300], to: [100, 100] })));
  assert.throws(
    () => parseMaskVector(withPrim({ k: 'cubic', c1: [w * (MASK_VECTOR_MAX_COORD_SPANS + 1), 0], c2: [0, 0], to: [100, 100] })),
    /not a point on a card/,
  );
});

test('the flattener spends a BUDGET when it is given one, and is unbounded when it is not', () => {
  // The other half, and the one that catches ordinary numbers. `CUBIC_MAX_DEPTH` was commented
  // as unreachable; orthogonal handles reach it, and 20,000 legal cubics get there without any
  // exotic coordinate at all. The bound is on POINTS because that is what the work is
  // proportional to — `rasterizePolygons` is O(scanlines x edges).
  //
  // DEFAULT UNBOUNDED, on purpose: the template fitter and the editor's preview flatten
  // geometry this process authored, and a budget there could only turn a correct render into
  // an exception. The bound is for the caller with an adversary.
  const path: VPath = {
    start: [10, 10],
    prims: [{ k: 'cubic', c1: [3000, 0], c2: [0, 2400], to: [190, 150] }],
  };
  const free = flattenPath(path, 0.02);
  assert.ok(free.length > 500, `an unbudgeted flatten emits what it always did (${free.length} points)`);
  assert.throws(() => flattenPath(path, 0.02, 100), PathTooComplex);
  assert.doesNotThrow(() => flattenPath(path, 0.02, free.length + 1));

  // The same geometry through the same function with no budget is byte-identical to before,
  // which is the property the fitter depends on.
  assert.deepEqual(flattenPath(path, 0.02, Infinity), free);

  // An arc's step count is checked BEFORE the loop rather than after it, so the refusal costs
  // nothing. A single arc cannot run away — the flattener's `max(1e-4, …)` step floor caps one
  // at ~62,832 points whatever `r` is — but the primitive ceiling allows 20,000 arcs, and the
  // budget has to see them.
  const bigArc: VPath = { start: [0, 0], prims: [{ k: 'arc', to: [22528, 0], r: 11264, sweep: 1 }] };
  assert.equal(flattenPath(bigArc, 0.02).length, 835, 'measured, so a change to the arc stepper shows up here');
  const t0 = performance.now();
  assert.throws(() => flattenPath(bigArc, 0.02, 100), PathTooComplex);
  assert.ok(performance.now() - t0 < 500, 'and refusing it is instant');
});

test('rasterizeMaskVector spends the budget across ALL subpaths, not per subpath', () => {
  // A per-path budget times however many paths a body carries is not a bound at all: the
  // primitive ceiling allows 20,000 of them spread over as many subpaths as you like.
  const many: MaskVector = {
    version: MASK_VECTOR_VERSION,
    space: { width: 200, height: 160 },
    paths: Array.from({ length: 20 }, (_, k) => ({
      start: [10 + k, 10] as [number, number],
      prims: [
        { k: 'cubic' as const, c1: [600, 0] as [number, number], c2: [0, 500] as [number, number], to: [190, 150] as [number, number] },
        { k: 'line' as const, to: [10 + k, 10] as [number, number] },
      ],
    })),
  };
  const perPath = flattenPath(many.paths[0]!, DEFAULT_VECTOR_FIT_PARAMS.flattenSagittaPx).length;
  // Each path alone fits inside the budget; twenty of them do not.
  assert.doesNotThrow(() => rasterizeMaskVector(many, 200, 160, { maxPoints: perPath * 20 + 40 }));
  assert.throws(() => rasterizeMaskVector(many, 200, 160, { maxPoints: perPath * 3 }), PathTooComplex);
  // And with no budget it behaves exactly as it did.
  assert.doesNotThrow(() => rasterizeMaskVector(many, 200, 160));
});

test('rasterizeMaskVector fills through the SAME rasteriser the editor previews with', () => {
  // Not an implementation note: the server's "do these paths make these pixels" question is
  // only meaningful if both sides come off one rasteriser. The expected area is computed here
  // from the rectangle arithmetic, never by calling the function under test.
  const v = sampleVector();
  const a = rasterizeMaskVector(v, 200, 160);
  let foil = 0;
  for (const px of a) if (px >= 128) foil++;
  // Outer 160 x 120 = 19200, minus the 80 x 40 = 3200 hole; the one cubic edge bows the right
  // side in slightly, so this is a bound rather than an equality.
  assert.ok(foil > 15000 && foil < 16100, `expected ~16000 foil px, got ${foil}`);
  assert.equal(a[80 * 200 + 100], 0, 'the hole is cut, not filled');
  assert.ok(a[30 * 200 + 100]! >= 128, 'and the body around it is foil');

  // Scaled to another raster, the shape is the same shape.
  const big = rasterizeMaskVector(v, 400, 320);
  let bigFoil = 0;
  for (const px of big) if (px >= 128) bigFoil++;
  assert.ok(Math.abs(bigFoil / 4 - foil) / foil < 0.01, 'a 2x raster holds ~4x the pixels of the same region');
});

test('anchor types survive a coordinate transform, and MOVE ONE SLOT under a reversal', () => {
  const p: VPath = {
    start: [0, 0],
    startType: 'c',
    prims: [
      { k: 'line', to: [10, 0], t: 's' },
      { k: 'cubic', c1: [20, 0], c2: [30, 10], to: [30, 20], t: 'c' },
      { k: 'line', to: [0, 0], t: 's' },
    ],
  };

  // A change of units is not a change of shape: a corner does not become smooth because
  // somebody rescaled the card. This is the function the editor runs on every load and every
  // save, so a drop here would launder the stored flag straight back into an inference.
  const scaled = mapPathCoords(p, ([x, y]) => [x / 100, y / 100], (r) => r / 100);
  assert.equal(scaled.startType, 'c');
  assert.deepEqual(scaled.prims.map((q) => q.t), ['s', 'c', 's']);

  // Reversed, `t` names a DIFFERENT anchor. The anchors are A0=(0,0) 'c', A1=(10,0) 's',
  // A2=(30,20) 'c', A3=(0,0) 's'. Walking backwards the path starts on A3 and its primitives
  // land on A2, A1, A0 in that order — so the expected answer is read off that anchor list
  // here, not off the helper being tested.
  const back = reversePath(p);
  assert.equal(back.startType, 's', 'the reversed path starts on the old final anchor');
  assert.deepEqual(back.prims.map((q) => q.t), ['c', 's', 'c']);
  // Reversing twice is the identity, types included.
  assert.deepEqual(reversePath(back), p);
});

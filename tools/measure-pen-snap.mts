// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// WHAT THE PEN'S SNAPPER ACTUALLY DOES, ON HOW MANY QUERIES — F3/F5, as a program.
//
//   node --conditions source tools/measure-pen-snap.mts
//
// `pen-snap.ts` claims two things a reader cannot check by reading: that it lands on the printed
// edge, and that it declines rather than guesses when the scan gets soft. Both are measurable
// against synthetic cards whose edge coordinates are known EXACTLY, which is the whole reason the
// cards are synthetic — on a real scan the "true" edge position is itself an estimate, and a
// residual measured against an estimate is a comparison of two opinions.
//
// The blur sweep is a STAND-IN for scan quality, not a model of one. A vintage card photographed
// under a phone, or a modern one whose upstream image is 245px wide and arrives at 504 by
// resampling, both present the pen with an edge spread over several pixels; a Gaussian is the
// cheapest honest way to vary exactly that. It says nothing about halftone rosettes, JPEG ringing
// or a foil surface blowing out under a flash, and this file is not evidence about those.
//
// Reported per condition: how often a query PROPOSED something, how often it REFUSED with a
// reason, how often it returned nothing at all, and — for the proposals — the residual against
// the true edge. A condition where the hit rate collapses and the residual stays small is the
// good failure: the snapper went quiet instead of confidently moving anchors onto a blur.

import { preparePenSnap, penSnapAt } from '../packages/forge/src/pen-snap.ts';
import type { SnapContext } from '../packages/forge/src/pen-engine.ts';
import type { RgbaImage } from '../packages/forge/src/png.ts';

const W = 240;
const H = 300;
/** The printed rectangle, in mask-space coordinates: its edges are exactly these numbers. */
const X0 = 60;
const X1 = 180;
const Y0 = 70;
const Y1 = 230;

const ctx: SnapContext = { doc: { paths: [] }, zoom: 1, phase: 'place', activePathIndex: null, ref: null };

/** A grey card with one bright rectangle, optionally blurred and optionally noisy. */
function card(blurPx: number, noise: number, seed = 1): RgbaImage {
  const lum = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    lum[i] = x >= X0 && x < X1 && y >= Y0 && y < Y1 ? 225 : 45;
  }
  const blurred = blurPx > 0 ? gaussian(lum, blurPx) : lum;
  // A tiny deterministic LCG: a measurement that changes between runs is not a measurement.
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(255, Math.round(blurred[i]! + rnd() * noise)));
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

/** Separable box-thrice, which is a Gaussian to within a percent and needs no kernel table. */
function gaussian(src: Float64Array, sigma: number): Float64Array {
  const r = Math.max(1, Math.round(sigma));
  let cur = src;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float64Array(cur.length);
    const out = new Float64Array(cur.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let d = -r; d <= r; d++) {
          const q = Math.min(W - 1, Math.max(0, x + d));
          sum += cur[y * W + q]!;
          n++;
        }
        tmp[y * W + x] = sum / n;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let d = -r; d <= r; d++) {
          const q = Math.min(H - 1, Math.max(0, y + d));
          sum += tmp[q * W + x]!;
          n++;
        }
        out[y * W + x] = sum / n;
      }
    }
    cur = out;
  }
  return cur;
}

interface Row {
  label: string;
  queries: number;
  proposed: number;
  refused: number;
  silent: number;
  residuals: number[];
  kinds: Record<string, number>;
  /**
   * Residuals split by what was caught, because a corner query answered with `edge` is not a
   * miss — it is the snapper declining to claim a corner it could not see and landing on the
   * edge it could. Pooling the two measures neither.
   */
  byKind: Record<string, number[]>;
}

/**
 * Query points scattered along all four edges at sub-pixel offsets either side, plus the four
 * corners. The offsets are what a hand does: within a pixel or two of the edge, never on it.
 */
function queries(): { p: { x: number; y: number }; truth: (q: { x: number; y: number }) => number }[] {
  const out: { p: { x: number; y: number }; truth: (q: { x: number; y: number }) => number }[] = [];
  const offs = [-1.6, -1.1, -0.6, 0.4, 0.9, 1.4];
  for (let k = 0; k < 15; k++) {
    const t = 0.12 + (k / 15) * 0.76;
    const y = Y0 + (Y1 - Y0) * t;
    const x = X0 + (X1 - X0) * t;
    for (const o of offs) {
      out.push({ p: { x: X0 + o, y }, truth: (q) => Math.abs(q.x - X0) });
      out.push({ p: { x: X1 + o, y }, truth: (q) => Math.abs(q.x - X1) });
      out.push({ p: { x, y: Y0 + o }, truth: (q) => Math.abs(q.y - Y0) });
      out.push({ p: { x, y: Y1 + o }, truth: (q) => Math.abs(q.y - Y1) });
    }
  }
  return out;
}

function corners(): { p: { x: number; y: number }; truth: (q: { x: number; y: number }) => number }[] {
  const out: { p: { x: number; y: number }; truth: (q: { x: number; y: number }) => number }[] = [];
  for (const [cx, cy] of [[X0, Y0], [X1, Y0], [X0, Y1], [X1, Y1]] as const) {
    for (const dx of [-1.3, -0.7, 0.7, 1.3]) {
      for (const dy of [-1.3, -0.7, 0.7, 1.3]) {
        out.push({ p: { x: cx + dx, y: cy + dy }, truth: (q) => Math.hypot(q.x - cx, q.y - cy) });
      }
    }
  }
  return out;
}

function run(label: string, img: RgbaImage, qs: ReturnType<typeof queries>): Row {
  const src = preparePenSnap(img);
  const row: Row = { label, queries: qs.length, proposed: 0, refused: 0, silent: 0, residuals: [], kinds: {}, byKind: {} };
  for (const q of qs) {
    const r = penSnapAt(src, q.p, ctx);
    if (r === null) {
      row.silent++;
      continue;
    }
    if (r.point === undefined) {
      row.refused++;
      continue;
    }
    row.proposed++;
    row.kinds[r.kind] = (row.kinds[r.kind] ?? 0) + 1;
    const d = q.truth(r.point);
    row.residuals.push(d);
    (row.byKind[r.kind] ??= []).push(d);
  }
  return row;
}

const q = (xs: number[], f: number): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * f))]!;

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** `focus` narrows the residual columns to one kind — see `Row.byKind` for why that is not optional. */
function print(rows: Row[], focus?: string): void {
  const what = focus ? `${focus} resid` : 'resid';
  console.log(
    ['condition', 'n', 'proposed', 'refused', 'silent', `${what} n`, 'mean', 'p95', 'max', 'kinds'].join('\t'),
  );
  for (const r of rows) {
    const res = focus ? (r.byKind[focus] ?? []) : r.residuals;
    console.log(
      [
        r.label,
        r.queries,
        `${((100 * r.proposed) / r.queries).toFixed(0)}%`,
        `${((100 * r.refused) / r.queries).toFixed(0)}%`,
        `${((100 * r.silent) / r.queries).toFixed(0)}%`,
        res.length,
        mean(res).toFixed(3),
        q(res, 0.95).toFixed(3),
        (res.length ? Math.max(...res) : 0).toFixed(3),
        Object.entries(r.kinds).map(([k, n]) => `${k}:${n}`).join(' '),
      ].join('\t'),
    );
  }
}

const edgeQs = queries();
const cornerQs = corners();

console.log('\n── EDGES: a query 0.4-1.6px off a known printed edge ───────────────────');
print([
  run('crisp step', card(0, 0), edgeQs),
  run('crisp + noise 6', card(0, 6), edgeQs),
  run('blur 1px', card(1, 0), edgeQs),
  run('blur 2px', card(2, 0), edgeQs),
  run('blur 3px', card(3, 0), edgeQs),
  run('blur 4px', card(4, 0), edgeQs),
  run('blur 2px + noise 12', card(2, 12), edgeQs),
]);

console.log('\n── CORNERS: a query 0.7-1.3px diagonally off a known corner ────────────');
console.log('   (residual is over the CORNER answers only; an `edge` answer here is the snapper');
console.log('    declining to claim a corner it cannot see, and lands ~1px away by construction)');
print(
  [
    run('crisp step', card(0, 0), cornerQs),
    run('blur 1px', card(1, 0), cornerQs),
    run('blur 2px', card(2, 0), cornerQs),
    run('blur 3px', card(3, 0), cornerQs),
  ],
  'corner',
);

console.log('\n── A CARD WITH NO EDGES AT ALL ─────────────────────────────────────────');
const flat = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  flat[i * 4] = flat[i * 4 + 1] = flat[i * 4 + 2] = 120;
  flat[i * 4 + 3] = 255;
}
print([run('flat grey', { width: W, height: H, rgba: flat }, edgeQs)]);
const noisyFlat = new Uint8Array(W * H * 4);
let s = 7;
for (let i = 0; i < W * H; i++) {
  s = (s * 1664525 + 1013904223) >>> 0;
  const v = 120 + ((s / 4294967296) * 2 - 1) * 14;
  noisyFlat[i * 4] = noisyFlat[i * 4 + 1] = noisyFlat[i * 4 + 2] = Math.round(v);
  noisyFlat[i * 4 + 3] = 255;
}
print([run('flat grey + noise 14', { width: W, height: H, rgba: noisyFlat }, edgeQs)]);
console.log('');

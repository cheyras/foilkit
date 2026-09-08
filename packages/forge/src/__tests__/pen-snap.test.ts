// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// Pure tests for the pen's snap provider (forge/pen-snap.ts). No DB, no disk, no fixtures —
// synthetic "cards" whose printed edges are at coordinates we know exactly, built the way
// `line-snap.test.ts` and `edge-trace.test.ts` build theirs.
//
// What these lock down, in the order they matter:
//   1. THE GUARDRAIL. Two comparable edges either side of the query and the snapper REFUSES,
//      with a reason, leaving the point exactly where the hand put it. This is the same promise
//      `line-snap.test.ts:209` makes about a run, made one gesture earlier about an anchor, and
//      it is the most important test in the file: a snapper that guesses here moves someone's
//      geometry onto evidence that does not say what it claims.
//   2. A blank card snaps nothing. Not "snaps weakly" — nothing, and it invents no edge from
//      paper texture or from noise.
//   3. The feature: a point near a printed edge lands ON it, and a corner query lands on the
//      INTERSECTION rather than sliding along whichever edge it found first.
//   4. THE TWO LAYERS ARE INDEPENDENT. The provider's own refusal and the engine's
//      `maxSnapMovePx` are different defences: a real provider aimed at a real edge four pixels
//      away is still refused by the engine, because the engine measures the DISPLACEMENT and
//      never asks the provider whether it feels confident.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_PEN_SNAP_PARAMS,
  penSnapAt,
  penSnapProvider,
  preparePenSnap,
  type PenSnapSource,
} from '../pen-snap.ts';
import {
  DEFAULT_PEN_CONFIG,
  createPenState,
  reduce,
  type PenConfig,
  type PenInput,
  type PenState,
  type SnapContext,
} from '../pen-engine.ts';
import type { RgbaImage } from '../png.ts';

const W = 200;
const H = 250;

/** A grey card with one crisp bright rectangle — edges at exactly these coordinates. */
function printedCard(x0: number, x1: number, y0: number, y1: number): RgbaImage {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    const v = x >= x0 && x < x1 && y >= y0 && y < y1 ? 225 : 45;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

/** A card with a rounded corner of radius `r` at the top-left of the bright region. */
function roundedCard(x0: number, x1: number, y0: number, y1: number, r: number): RgbaImage {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = (i % W) + 0.5;
    const y = ((i / W) | 0) + 0.5;
    let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
    if (inside && x < x0 + r && y < y0 + r) inside = Math.hypot(x - (x0 + r), y - (y0 + r)) <= r;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = inside ? 225 : 45;
    rgba[i * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

function flatCard(noise = 0, seed = 3): RgbaImage {
  const rgba = new Uint8Array(W * H * 4);
  let s = seed >>> 0;
  for (let i = 0; i < W * H; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = Math.round(120 + ((s / 4294967296) * 2 - 1) * noise);
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

/**
 * Two comparable printed edges, `gap` apart, either side of x = 40. The band between them is a
 * mid grey so both steps are the same size: the scan genuinely cannot say which one was meant.
 */
function ambiguousCard(gap: number): RgbaImage {
  const rgba = new Uint8Array(W * H * 4);
  const lo = 40 - gap / 2;
  const hi = 40 + gap / 2;
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const v = x < lo ? 40 : x < hi ? 145 : 250;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

/** An empty document at zoom 1 — the context for a query that has no geometry to consider. */
const bare = (): SnapContext => ({
  doc: { paths: [] },
  zoom: 1,
  phase: 'place',
  activePathIndex: null,
  ref: null,
});

const ask = (src: PenSnapSource, x: number, y: number, ctx: SnapContext = bare()) => penSnapAt(src, { x, y }, ctx);

// ══ 1. THE GUARDRAIL ═════════════════════════════════════════════════════

test('an ambiguous band is REFUSED with a reason, and the point does not move', () => {
  // Two equally strong printed edges 3px either side of the query. The scan says "you are near
  // an edge", not "you meant THAT edge" — and the difference between those two sentences is the
  // difference between a tracing aid and a tool that quietly relocates a user's geometry.
  const src = preparePenSnap(ambiguousCard(6));
  const r = ask(src, 40, 120);
  assert.ok(r !== null, 'the snapper looked, and it has something to say');
  assert.equal(r.point, undefined, `an ambiguous band must not propose a point: ${JSON.stringify(r)}`);
  assert.match(r.refused, /comparable edges/, `and it must say why: ${r.refused}`);
  // Named offsets, so the sentence is auditable rather than atmospheric: the two ridges sit on
  // the pixel centres either side of the 3px step, 2.5px out from the query.
  assert.match(r.refused, /-2\.5\/2\.5|2\.5\/-2\.5/, `naming the rival offsets: ${r.refused}`);

  // And the engine, handed the same provider, leaves the anchor exactly where the click was.
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, snap: penSnapProvider(src) };
  const s = drive(createPenState(), [down(40, 120), up(40, 120)], cfg);
  assert.deepEqual(s.doc.paths[0].points[0].anchor, [40, 120], 'the anchor is where the hand put it');
  assert.equal(s.snapped, null, 'nothing was captured');
  assert.match(s.snapRefusal!, /comparable edges/, `and the refusal reached the state: ${s.snapRefusal}`);
});

test('one edge in the same band is NOT ambiguous — the refusal is about rival evidence, not about being near a step', () => {
  // The trap this guards: a refusal rule keyed on "is there more than one ridge pixel nearby"
  // refuses everywhere and looks admirably cautious while being useless.
  const src = preparePenSnap(printedCard(40, 160, 50, 200));
  const r = ask(src, 41.4, 120);
  assert.ok(r !== null && r.point !== undefined, `a lone printed edge is answerable: ${JSON.stringify(r)}`);
  assert.equal(r.kind, 'edge');
});

// ══ 2. A blank card invents nothing ══════════════════════════════════════

test('a blank card snaps nothing, and neither does a noisy one', () => {
  const flat = preparePenSnap(flatCard(0));
  assert.equal(flat.evidence.edgePixels, 0, 'a flat card has no edge in it at all');

  // MEASURED RATHER THAN WISHED FOR: +/-14 of noise does leave a couple of pixels that survive
  // NMS and hysteresis out of 50,000 — 2, in this seed. That is precisely why "is there a ridge
  // pixel here" is not the question the snapper asks; `minClusterPixels` is, and a speck is not a
  // cluster. The number that matters is the one below: zero proposals.
  const noisy = preparePenSnap(flatCard(14));
  assert.ok(noisy.evidence.edgeFraction < 0.0001, `noise leaves specks, not edges (${noisy.evidence.edgePixels})`);

  for (const [label, src] of [['flat', flat], ['noisy', noisy]] as const) {
    for (const [x, y] of [[40, 120], [100, 60], [160, 200], [12, 12]] as const) {
      assert.equal(ask(src, x, y), null, `${label}: nothing at ${x},${y} — and nothing is not a weak yes`);
    }
  }
});

// ══ 3. The feature ═══════════════════════════════════════════════════════

test('a point near a printed edge lands ON the edge, to a fraction of a pixel', () => {
  const src = preparePenSnap(printedCard(40, 160, 50, 200));
  // Four sides, from both directions, at offsets a hand actually produces.
  const cases: { at: [number, number]; want: number; axis: 'x' | 'y' }[] = [
    { at: [41.4, 120], want: 40, axis: 'x' },
    { at: [38.7, 130], want: 40, axis: 'x' },
    { at: [158.6, 140], want: 160, axis: 'x' },
    { at: [161.2, 150], want: 160, axis: 'x' },
    { at: [100, 51.3], want: 50, axis: 'y' },
    { at: [110, 48.8], want: 50, axis: 'y' },
    { at: [120, 198.9], want: 200, axis: 'y' },
    { at: [130, 201.1], want: 200, axis: 'y' },
  ];
  for (const c of cases) {
    const r = ask(src, c.at[0], c.at[1]);
    assert.ok(r !== null && r.point !== undefined, `${c.at}: expected a proposal, got ${JSON.stringify(r)}`);
    assert.equal(r.kind, 'edge');
    const got = c.axis === 'x' ? r.point.x : r.point.y;
    assert.ok(Math.abs(got - c.want) <= 0.25, `${c.at} → ${got}, wanted ${c.want} (±0.25)`);
    // The other coordinate does not slide: a snap to an edge moves ACROSS it, never along it.
    const other = c.axis === 'x' ? r.point.y : r.point.x;
    const kept = c.axis === 'x' ? c.at[1] : c.at[0];
    assert.ok(Math.abs(other - kept) < 1e-6, `${c.at}: the along-edge coordinate must not move`);
  }
});

test('a corner query lands on the INTERSECTION, not on whichever edge it found first', () => {
  const src = preparePenSnap(printedCard(40, 160, 50, 200));
  for (const [cx, cy] of [[40, 50], [160, 50], [40, 200], [160, 200]] as const) {
    for (const [dx, dy] of [[-1.1, -1.1], [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1]] as const) {
      const r = ask(src, cx + dx, cy + dy);
      assert.ok(r !== null && r.point !== undefined, `corner ${cx},${cy} off ${dx},${dy}: ${JSON.stringify(r)}`);
      assert.equal(r.kind, 'corner', `it must know it caught a corner: ${r.reason}`);
      const d = Math.hypot(r.point.x - cx, r.point.y - cy);
      assert.ok(d <= 1.2, `landed ${d.toFixed(2)}px from the corner ${cx},${cy}`);
      // Not merely on one of the two edges: BOTH coordinates moved to the corner's.
      assert.ok(Math.abs(r.point.x - cx) <= 1.2 && Math.abs(r.point.y - cy) <= 1.2, 'both axes were resolved');
    }
  }
});

test('a rounded corner is not forced into a sharp one — the fillet gets an edge snap on its tangent', () => {
  // The geometry the acceptance criterion is actually about is a rounded-rect window, and the
  // honest answer partway around a fillet is "here is the edge under you", not a corner
  // manufactured by extending two straight arms that do not meet there.
  const src = preparePenSnap(roundedCard(40, 160, 50, 200, 12));
  // 45 degrees around the fillet, whose centre is (52, 62) and radius 12.
  const k = 12 / Math.SQRT2;
  const on = { x: 52 - k, y: 62 - k };
  const r = ask(src, on.x + 0.8, on.y + 0.8);
  assert.ok(r !== null && r.point !== undefined, `expected a proposal on the fillet: ${JSON.stringify(r)}`);
  assert.equal(r.kind, 'edge', `a fillet is an edge, not a corner: ${r.reason}`);
  const radial = Math.hypot(r.point.x - 52, r.point.y - 62);
  assert.ok(Math.abs(radial - 12) <= 0.6, `it sits on the arc (radius ${radial.toFixed(2)}, wanted 12)`);
});

test('an existing anchor outranks the printed edge under it', () => {
  // Priority G.3/111: geometry a human already placed beats geometry measured off a scan. The
  // anchor here sits 1.5px off the printed edge, so the two targets disagree and the winner is
  // observable rather than a coincidence.
  const src = preparePenSnap(printedCard(40, 160, 50, 200));
  const ctx: SnapContext = {
    doc: { paths: [{ closed: false, points: [pt(41.5, 118)] }] },
    zoom: 1,
    phase: 'place',
    activePathIndex: 0,
    ref: null,
  };
  const r = ask(src, 41.2, 118.4, ctx);
  assert.ok(r !== null && r.point !== undefined);
  assert.equal(r.kind, 'anchor');
  assert.deepEqual([r.point.x, r.point.y], [41.5, 118]);

  // ...but not the anchor CURRENTLY IN THE HAND, or every drag would snap to where it started.
  const held = ask(src, 41.2, 118.4, { ...ctx, phase: 'move-anchor', ref: { path: 0, point: 0 } });
  assert.ok(held !== null && held.point !== undefined);
  assert.equal(held.kind, 'edge', `a point cannot snap to itself: ${JSON.stringify(held)}`);
});

test('what it caught is reported, and every answer carries its evidence', () => {
  const src = preparePenSnap(printedCard(40, 160, 50, 200));
  assert.ok(src.evidence.edgePixels > 500, `the card has edges in it (${src.evidence.edgePixels})`);
  const edge = ask(src, 41.4, 120);
  assert.ok(edge !== null && edge.point !== undefined);
  assert.match(edge.reason!, /printed edge runs .*px away/);
  const corner = ask(src, 41.1, 51.1);
  assert.ok(corner !== null && corner.point !== undefined);
  assert.match(corner.reason!, /two printed edges cross/);
});

// ══ 4. Two independent layers ════════════════════════════════════════════

test('the engine still bounds a REAL provider that has found a real edge too far away', () => {
  // No rogue callback here — this is the honest provider, aimed at an edge it genuinely detected
  // 3.5px from the click. The provider is right about the edge and the engine refuses anyway,
  // because the two defences answer different questions: "is this evidence?" and "is this a
  // nudge or a relocation?". A provider is never asked whether it feels confident.
  const src = preparePenSnap(printedCard(40, 160, 50, 200), { searchRadiusPx: 6 });
  const proposal = ask(src, 43.5, 120);
  assert.ok(proposal !== null && proposal.point !== undefined, 'the provider does propose the edge');
  assert.ok(Math.abs(proposal.point.x - 40) <= 0.3, 'and it is the right edge');

  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, snap: penSnapProvider(src) };
  const s = drive(createPenState(), [down(43.5, 120), up(43.5, 120)], cfg);
  assert.deepEqual(s.doc.paths[0].points[0].anchor, [43.5, 120], 'the anchor stayed where the hand put it');
  assert.equal(s.snapped, null);
  assert.match(s.snapRefusal!, /3\.5\d? screen px/, `stating the distance it refused: ${s.snapRefusal}`);
  assert.match(s.snapRefusal!, /never relocate/, s.snapRefusal!);

  // The SAME provider and the same click, with the budget widened, does capture — so the refusal
  // above is the engine's threshold and not the provider quietly failing.
  const loose = drive(createPenState(), [down(43.5, 120), up(43.5, 120)], { ...cfg, maxSnapMovePx: 4 });
  assert.ok(Math.abs(loose.doc.paths[0].points[0].anchor[0] - 40) <= 0.3, 'now it lands on the edge');
  assert.equal(loose.snapped!.kind, 'edge');
});

test('Ctrl+U switches the whole snapper off and on, and the same click then lands differently', () => {
  const src = preparePenSnap(printedCard(40, 160, 50, 200));
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, snap: penSnapProvider(src) };
  const on = drive(createPenState(), [down(41.4, 120), up(41.4, 120)], cfg);
  assert.ok(Math.abs(on.doc.paths[0].points[0].anchor[0] - 40) <= 0.25, 'snapping on: it catches the edge');

  const off = drive(createPenState(), [kd('u', { ctrl: true })], cfg);
  assert.equal(off.snapEnabled, false, 'Ctrl+U is Smart Guides, and it is a toggle');
  const placed = drive(off, [down(41.4, 120), up(41.4, 120)], cfg);
  assert.deepEqual(placed.doc.paths[0].points[0].anchor, [41.4, 120], 'snapping off: the hand is obeyed exactly');
  assert.equal(placed.snapped, null);
  assert.equal(placed.snapRefusal, null, 'and a switched-off snapper does not nag about what it would have done');

  assert.equal(drive(off, [kd('u', { ctrl: true })]).snapEnabled, true, 'and back on');
  assert.equal(createPenState().snapEnabled, true, 'edge snapping ships ON, which is the Illustrator default');
});

test('construction angles are OFF by default, and when switched on they capture only near a ray', () => {
  // I.104. The dead-config trap this closes: `constructionAngles` was declared, defaulted and
  // asserted, and no code read it — so the assertion below passed for the wrong reason.
  assert.deepEqual(DEFAULT_PEN_CONFIG.constructionAngles, [], 'factory default: no angular snapping');
  const plain = drive(createPenState(), [...click(0, 0), ...click(103, 7)]);
  assert.deepEqual(plain.doc.paths[0].points[1].anchor, [103, 7], 'an off-axis anchor is left off-axis');

  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, constructionAngles: [0, 45, 90, 135] };
  // 7px off horizontal at 103px out is inside the 6px tolerance measured perpendicular... it is
  // not: 7 > 6, so it stays. That boundary is the whole point of a tolerance.
  assert.deepEqual(drive(createPenState(), [...click(0, 0), ...click(103, 7)], cfg).doc.paths[0].points[1].anchor,
    [103, 7], 'beyond the tolerance, the guide does not reach');
  const near = drive(createPenState(), [...click(0, 0), ...click(103, 3)], cfg);
  const [nx, ny] = near.doc.paths[0].points[1].anchor;
  assert.equal(ny, 0, 'inside the tolerance, the point is captured onto the ray');
  // MAGNITUDE PRESERVED, exactly as `constrainToAngle` does it: the segment keeps the length the
  // hand gave it and slides around the circle, rather than being clamped onto the axis (103, 0).
  assert.ok(Math.abs(Math.hypot(nx, ny) - Math.hypot(103, 3)) < 1e-9, `slid around the circle, got ${nx}`);
  assert.equal(near.snapped!.kind, 'construction 0deg', 'and the capture is shown, not silent');

  // Ctrl+U governs these too: Smart Guides is one switch over every snap the engine performs.
  const off = drive(createPenState(), [kd('u', { ctrl: true }), ...click(0, 0), ...click(103, 3)], cfg);
  assert.deepEqual(off.doc.paths[0].points[1].anchor, [103, 3]);
});

// ── Driving the engine, same helpers the engine's own test file uses ───────

const M = (m: Partial<{ alt: boolean; ctrl: boolean; shift: boolean; space: boolean; capsLock: boolean }> = {}) => ({
  alt: false, ctrl: false, shift: false, space: false, capsLock: false, ...m,
});
const down = (x: number, y: number): PenInput => ({ type: 'pointerdown', point: { x, y }, button: 0, mods: M(), zoom: 1 });
const up = (x: number, y: number): PenInput => ({ type: 'pointerup', point: { x, y }, button: 0, mods: M(), zoom: 1 });
const click = (x: number, y: number): PenInput[] => [down(x, y), up(x, y)];
const kd = (key: string, m: Parameters<typeof M>[0] = {}): PenInput => ({ type: 'keydown', key, mods: M(m), zoom: 1 });
const drive = (s: PenState, inputs: PenInput[], cfg: PenConfig = DEFAULT_PEN_CONFIG): PenState =>
  inputs.reduce((acc, i) => reduce(acc, i, cfg), s);
const pt = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  leftDirection: [x, y] as [number, number],
  rightDirection: [x, y] as [number, number],
  pointType: 'corner' as const,
});

// A guard on the constants the tests above are written against: change one and the numbers in
// these assertions stop meaning what their names say.
test('the params these tests are written against', () => {
  assert.equal(DEFAULT_PEN_SNAP_PARAMS.ambiguityRatio, 0.85, "line-snap's ratio, and the same rule");
  assert.equal(DEFAULT_PEN_SNAP_PARAMS.searchRadiusPx, 4);
  assert.equal(DEFAULT_PEN_CONFIG.maxSnapMovePx, 2);
  assert.equal(DEFAULT_PEN_CONFIG.constructionSnapPx, 6);
});

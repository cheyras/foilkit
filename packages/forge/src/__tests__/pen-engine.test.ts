// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// The pen's BEHAVIOUR, driven by synthetic events — because "feels like Illustrator" is a claim
// about behaviour, and behaviour that can only be tested through a browser barely gets tested.
//
// Every test is named after the item(s) of the spec's 126-item conformance checklist it proves,
// so a mismatch found against real Illustrator is a one-line correction rather than an
// archaeology project. Items the spec marks `[U]` — unverified against a primary Adobe source —
// carry a comment saying so; they lock the behaviour we CHOSE, not a behaviour we measured.
//
// THE STANDARD THIS FILE IS HELD TO, from `vector-template.test.ts` case 4 and
// `pen-geometry.test.ts`: expected geometry is computed INDEPENDENTLY here, never by calling the
// helper under test. `bez` below is repeated linear interpolation; the engine's segments run
// through `cubicAt`'s Bernstein form. A test that called the shipped helper to check the shipped
// helper would prove only that it agrees with itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduce, createPenState, cursorFor, visibleHandles, resolvePenClick, hitTest,
  toVPath, fromVPath, arcToCubics, isPathSelected, lookupBinding, dragHandle,
  insertAnchor, reversePenPath, constrainToAngle, segmentCubic, segmentCount,
  toMaskVector, fromMaskVector,
  DEFAULT_PEN_CONFIG, PEN_KEY_BINDINGS, PEN_CLAIMED_HOST_KEYS, PEN_CONDITIONAL_HOST_KEYS,
  type PenState, type PenInput, type PenMods, type PenConfig, type PenDoc, type PenPath,
  type PathPoint, type SnapFn,
} from '../pen-engine.ts';
import { parseMaskVector, serializeMaskVector } from '../vector-template.ts';
import type { Prim, VPath } from '../vector-template.ts';
import type { Vec } from '../line-snap.ts';

// ── an independent cubic, and the input builders ───────────────────────────

/** de Casteljau by repeated lerp — deliberately not the Bernstein form the engine uses. */
function bez(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const L = (a: Vec, b: Vec): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return L(L(L(p0, p1), L(p1, p2)), L(L(p1, p2), L(p2, p3)));
}
const V = (x: number, y: number): Vec => ({ x, y });
const P = (p: [number, number]): Vec => ({ x: p[0], y: p[1] });
const D = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
const nearPt = (a: Vec, b: Vec, tol = 1e-9): boolean => D(a, b) <= tol;

const M = (o: Partial<PenMods> = {}): PenMods =>
  ({ alt: false, ctrl: false, shift: false, space: false, capsLock: false, ...o });

const down = (x: number, y: number, o: Partial<PenMods> = {}, zoom = 1): PenInput =>
  ({ type: 'pointerdown', point: { x, y }, button: 0, mods: M(o), zoom });
const move = (x: number, y: number, o: Partial<PenMods> = {}, zoom = 1): PenInput =>
  ({ type: 'pointermove', point: { x, y }, mods: M(o), zoom });
const up = (x: number, y: number, o: Partial<PenMods> = {}, zoom = 1): PenInput =>
  ({ type: 'pointerup', point: { x, y }, button: 0, mods: M(o), zoom });
const kd = (key: string, o: Partial<PenMods> = {}, zoom = 1): PenInput =>
  ({ type: 'keydown', key, mods: M(o), zoom });
const ku = (key: string, o: Partial<PenMods> = {}, zoom = 1): PenInput =>
  ({ type: 'keyup', key, mods: M(o), zoom });

const drive = (s: PenState, inputs: PenInput[], cfg: PenConfig = DEFAULT_PEN_CONFIG): PenState =>
  inputs.reduce((acc, i) => reduce(acc, i, cfg), s);

/** Click an anchor down at (x,y) and release without moving — the plain corner-placing click. */
const click = (x: number, y: number, o: Partial<PenMods> = {}, zoom = 1): PenInput[] =>
  [down(x, y, o, zoom), up(x, y, o, zoom)];

const activePath = (s: PenState): PenPath => s.doc.paths[s.activePathIndex!];
const pointAt = (s: PenState, path: number, i: number): PathPoint => s.doc.paths[path].points[i];

/** The segment `i -> i+1` as four independent points, read straight off the document model. */
function segPoints(path: PenPath, i: number): [Vec, Vec, Vec, Vec] {
  const a = path.points[i];
  const b = path.points[(i + 1) % path.points.length];
  return [P(a.anchor), P(a.rightDirection), P(b.leftDirection), P(b.anchor)];
}

// ══ Placement — spec A.1-A.4 ═══════════════════════════════════════════════

test('I.1 — `P` activates the Pen, and the binding table is where that fact lives', () => {
  const s = drive(createPenState(), [kd('v'), kd('p')]);
  assert.equal(s.activeTool, 'pen');
  assert.equal(lookupBinding('P', M())!.command, 'tool-pen');
  // Exact modifier match: `A` is Direct Selection, `Ctrl+A` is Select All. Match loosely and
  // every Ctrl shortcut also fires a tool switch behind it.
  assert.equal(lookupBinding('a', M())!.command, 'tool-direct-select');
  assert.equal(lookupBinding('a', M({ ctrl: true }))!.command, 'select-all');
  assert.equal(lookupBinding('c', M({ shift: true }))!.command, 'tool-anchor-point');
});

test('I.2 — with no active path the cursor shows the start-path badge', () => {
  const s = drive(createPenState(), [move(10, 10)]);
  assert.equal(s.activePathIndex, null);
  assert.equal(cursorFor(s), 'start');
});

test('I.3 — no rubber band is rendered before the first anchor exists', () => {
  const s = drive(createPenState(), [move(10, 10), move(80, 40)]);
  assert.equal(s.rubberBand, null, 'a preview of a segment with no start point is a preview of nothing');
});

test('I.4 — a click inside the 2px dead zone creates a CORNER with both handles retracted', () => {
  // 1.5 screen px of travel is a click, not a drag. Without the dead zone every click makes a
  // 1px handle and the tool feels broken (spec A.2).
  const s = drive(createPenState(), [down(40, 40), move(41, 41.1), up(41, 41.1)]);
  const pt = pointAt(s, 0, 0);
  assert.equal(pt.pointType, 'corner');
  assert.deepEqual(pt.leftDirection, pt.anchor);
  assert.deepEqual(pt.rightDirection, pt.anchor);
  assert.ok(nearPt(P(pt.anchor), V(40, 40)), 'the anchor stays where the button went down');
});

test('I.5, I.6 — during a placement drag rightDirection IS the cursor and leftDirection is 2Q - C', () => {
  const Q = V(100, 100);
  let s = drive(createPenState(), [down(Q.x, Q.y)]);
  for (const C of [V(140, 100), V(160, 60), V(70, 130)]) {
    s = reduce(s, move(C.x, C.y));
    const pt = pointAt(s, 0, 0);
    assert.equal(pt.pointType, 'smooth');
    assert.ok(nearPt(P(pt.rightDirection), C), `the OUTGOING handle follows the cursor; got ${JSON.stringify(pt.rightDirection)}`);
    // Computed here, not asked of the engine: the point reflection through Q.
    assert.ok(nearPt(P(pt.leftDirection), V(2 * Q.x - C.x, 2 * Q.y - C.y)),
      `leftDirection must be the point-reflection of the cursor; got ${JSON.stringify(pt.leftDirection)}`);
    // …and EQUAL length, which is what "mirrored at placement" means (spec 0.1).
    assert.ok(near(D(P(pt.leftDirection), Q), D(P(pt.rightDirection), Q), 1e-9));
  }
});

test('I.7 — the already-committed previous segment re-renders on every frame of the drag', () => {
  // THE INVERTED FEEL, and gotcha 3-4: the cursor holds the OUTGOING handle, so dragging
  // toward where you are going bulges the segment BEHIND you away from the drag.
  let s = drive(createPenState(), [...click(0, 0), down(100, 0)]);
  const sample = (st: PenState): Vec => {
    const [p0, p1, p2, p3] = segPoints(activePath(st), 0);
    return bez(p0, p1, p2, p3, 0.5);
  };
  s = reduce(s, move(140, 0));
  const straightish = sample(s);
  s = reduce(s, move(140, 80));
  const bulged = sample(s);
  assert.ok(D(straightish, bulged) > 5,
    `the committed segment must move while the handle drags: ${JSON.stringify(straightish)} vs ${JSON.stringify(bulged)}`);
  // And it bulges the OTHER way: drag the handle down (+y) and the midpoint of the segment
  // behind rises (-y), because that segment arrives through `leftDirection = 2Q - C`.
  assert.ok(bulged.y < straightish.y, `dragging down must lift the segment behind: ${bulged.y} vs ${straightish.y}`);
});

test('I.8 — mouseup commits the anchor and the incoming segment with the final handle values', () => {
  const s = drive(createPenState(), [...click(0, 0), down(100, 0), move(140, 60), up(140, 60)]);
  const pt = pointAt(s, 0, 1);
  assert.equal(s.drag, null);
  assert.equal(pt.pointType, 'smooth');
  assert.ok(nearPt(P(pt.rightDirection), V(140, 60)));
  assert.ok(nearPt(P(pt.leftDirection), V(60, -60)), 'the frozen mirror, 2Q - C, survives the release');
});

test('I.9 — a drag that returns to its origin is a click: CORNER, never a zero-length SMOOTH', () => {
  const s = drive(createPenState(), [down(50, 50), move(90, 90), move(50, 50), up(50, 50)]);
  const pt = pointAt(s, 0, 0);
  assert.equal(pt.pointType, 'corner');
  assert.deepEqual(pt.leftDirection, pt.anchor);
  assert.deepEqual(pt.rightDirection, pt.anchor);
});

test('I.10 — after a SMOOTH anchor the rubber band uses that anchor\'s real outgoing handle', () => {
  const s = drive(createPenState(), [
    ...click(0, 0),
    down(100, 0), move(140, 60), up(140, 60),
    move(200, 0),
  ]);
  const rb = s.rubberBand!;
  assert.ok(rb, 'a rubber band exists once an anchor does');
  assert.deepEqual(rb.from, [100, 0]);
  assert.deepEqual(rb.c1, [140, 60], 'P1 is the last anchor\'s REAL outgoing handle');
  assert.deepEqual(rb.c2, [200, 0], 'P2 is a RETRACTED incoming handle at the cursor');
  assert.deepEqual(rb.to, [200, 0]);
  // …and that makes the preview a genuine curve, not a straight line to the cursor (gotcha 2).
  const mid = bez(P(rb.from), P(rb.c1), P(rb.c2), P(rb.to), 0.5);
  const chordMid = V((rb.from[0] + rb.to[0]) / 2, (rb.from[1] + rb.to[1]) / 2);
  assert.ok(D(mid, chordMid) > 5, `the preview must bend out of the handle; got ${D(mid, chordMid)}`);
});

test('I.11 — after a CORNER with retracted handles the rubber band is a straight line', () => {
  const s = drive(createPenState(), [...click(0, 0), ...click(100, 0), move(180, 60)]);
  const rb = s.rubberBand!;
  assert.deepEqual(rb.c1, rb.from, 'a retracted outgoing handle sits on its anchor');
  assert.deepEqual(rb.c2, rb.to);
  for (const t of [0.25, 0.5, 0.75]) {
    const q = bez(P(rb.from), P(rb.c1), P(rb.c2), P(rb.to), t);
    // Straight means every sample is on the chord: the cross product vanishes.
    const cross = (rb.to[0] - rb.from[0]) * (q.y - rb.from[1]) - (rb.to[1] - rb.from[1]) * (q.x - rb.from[0]);
    assert.ok(near(cross, 0, 1e-9), `sample at t=${t} left the chord by ${cross}`);
  }
});

test('I.12 — disabling the rubber-band preference suppresses the preview but not placement', () => {
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, rubberBand: false };
  const s = drive(createPenState(), [...click(0, 0), move(90, 20), ...click(100, 0)], cfg);
  assert.equal(s.rubberBand, null);
  assert.equal(activePath(s).points.length, 2, 'placement is untouched by a preview preference');
});

// ══ Alt breaks the symmetry — spec A.5, items 16-22 ════════════════════════

test('I.16, I.17, I.18 — Alt mid-drag freezes leftDirection, frees rightDirection, and sets CORNER', () => {
  const Q = V(100, 100);
  let s = drive(createPenState(), [...click(0, 100), down(Q.x, Q.y), move(150, 100)]);
  const frozenExpected = V(2 * Q.x - 150, 2 * Q.y - 100);   // 2Q - C at the instant Alt lands
  s = reduce(s, kd('Alt', { alt: true }));
  assert.equal(pointAt(s, 0, 1).pointType, 'corner');

  for (const C of [V(180, 40), V(120, 200)]) {
    s = reduce(s, move(C.x, C.y, { alt: true }));
    const pt = pointAt(s, 0, 1);
    assert.ok(nearPt(P(pt.leftDirection), frozenExpected), `leftDirection must stay frozen; got ${JSON.stringify(pt.leftDirection)}`);
    assert.ok(nearPt(P(pt.rightDirection), C), 'rightDirection keeps tracking the cursor, independently');
    assert.equal(pt.pointType, 'corner');
  }
});

test('I.22 — releasing Alt restores the Pen without undoing the conversion', () => {
  let s = drive(createPenState(), [...click(0, 100), down(100, 100), move(150, 100), kd('Alt', { alt: true }), move(180, 40, { alt: true })]);
  const frozen = [...pointAt(s, 0, 1).leftDirection];
  s = drive(s, [ku('Alt'), move(190, 30), up(190, 30)]);
  assert.equal(s.activeTool, 'pen', 'the pen comes back');
  const pt = pointAt(s, 0, 1);
  assert.equal(pt.pointType, 'corner', 'the cusp was a real edit, not a preview');
  assert.deepEqual(pt.leftDirection, frozen, 'and the frozen handle stayed frozen for the rest of the drag');
});

test('I.19 — Alt-click a SMOOTH anchor retracts BOTH handles and sets CORNER', () => {
  // Spec A.5's "asymmetry to preserve": there is no gesture that retracts only the near handle,
  // and adding one because it seems nicer would be wrong.
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [70, -40], rightDirection: [130, 40], pointType: 'smooth' },
    { anchor: [200, 0], leftDirection: [200, 0], rightDirection: [200, 0], pointType: 'corner' },
  ] }] };
  assert.deepEqual(toVPath(doc.paths[0]).prims.map((p) => p.k), ['cubic', 'cubic'], 'both segments start curved');
  const s = drive(createPenState(doc), [kd('Alt', { alt: true }), down(100, 0, { alt: true }), up(100, 0, { alt: true })]);
  const pt = pointAt(s, 0, 1);
  assert.equal(pt.pointType, 'corner');
  assert.deepEqual(pt.leftDirection, [100, 0]);
  assert.deepEqual(pt.rightDirection, [100, 0]);
  // BOTH adjacent segments straighten, which is the visible consequence of retracting BOTH
  // handles rather than only the near one.
  assert.deepEqual(toVPath(s.doc.paths[0]).prims.map((p) => p.k), ['line', 'line']);
});

test('I.20 — Alt-click-drag a CORNER anchor pulls out two MIRRORED handles and sets SMOOTH', () => {
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [100, 0], rightDirection: [100, 0], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [200, 0], rightDirection: [200, 0], pointType: 'corner' },
  ] }] };
  const s = drive(createPenState(doc), [
    kd('Alt', { alt: true }), down(100, 0, { alt: true }), move(160, 40, { alt: true }), up(160, 40, { alt: true }),
  ]);
  const pt = pointAt(s, 0, 1);
  assert.equal(pt.pointType, 'smooth');
  assert.ok(nearPt(P(pt.rightDirection), V(160, 40)), 'the outgoing handle follows the cursor');
  assert.ok(nearPt(P(pt.leftDirection), V(40, -40)), 'and the incoming one mirrors it exactly');
  // It is the DRAG that restores handles, not the click (gotcha 6).
});

test('I.21 — Alt-drag ONE handle of a SMOOTH anchor moves it alone and sets CORNER', () => {
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [30, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [60, 0], rightDirection: [140, 0], pointType: 'smooth' },
    { anchor: [200, 0], leftDirection: [170, 0], rightDirection: [200, 0], pointType: 'corner' },
  ] }] };
  const s = drive(createPenState(doc), [
    kd('Alt', { alt: true }), down(140, 0, { alt: true }), move(150, 70, { alt: true }), up(150, 70, { alt: true }),
  ]);
  const pt = pointAt(s, 0, 1);
  assert.equal(pt.pointType, 'corner');
  assert.ok(nearPt(P(pt.rightDirection), V(150, 70)));
  assert.deepEqual(pt.leftDirection, [60, 0], 'the opposite handle is UNTOUCHED — not rotated, not rescaled');
});

// ══ The stored language, both directions — spec 0 ══════════════════════════

test('toVPath emits a `line` when both adjacent handles are retracted, and a cubic otherwise', () => {
  const path: PenPath = { closed: true, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [100, 0], rightDirection: [140, 40], pointType: 'corner' },
    { anchor: [100, 100], leftDirection: [140, 60], rightDirection: [100, 100], pointType: 'smooth' },
  ] };
  const vp = toVPath(path);
  assert.deepEqual(vp.start, [0, 0]);
  assert.deepEqual(vp.prims.map((p) => p.k), ['line', 'cubic', 'line'],
    'a straight card edge must stay two numbers in a committed diff, not six that look straight');
  assert.equal(vp.prims.length, 3, 'a closed path emits its closing primitive explicitly');
  assert.equal(toVPath({ ...path, closed: false }).prims.length, 2, 'an open path emits no closing primitive');
});

test('fromVPath reads closure off the geometry and infers pointType ONLY at import', () => {
  const stored: VPath = { start: [0, 0], prims: [
    { k: 'cubic', c1: [40, 0], c2: [60, -40], to: [100, -40] },
    { k: 'cubic', c1: [140, -40], c2: [180, 0], to: [180, 40] },
    { k: 'line', to: [0, 0] },
  ] };
  const pen = fromVPath(stored);
  assert.equal(pen.closed, true, 'the last primitive lands on `start`, so the path is closed');
  assert.equal(pen.points.length, 3, 'and the duplicate final anchor is dropped, not kept as a coincident point');
  // (100,-40) has handles (60,-40) and (140,-40): collinear AND opposed -> SMOOTH.
  assert.equal(pen.points[1].pointType, 'smooth');
  // (0,0) arrives through a `line` (retracted) so it cannot be smooth: collinearity is undefined.
  assert.equal(pen.points[0].pointType, 'corner');

  const open = fromVPath({ start: [0, 0], prims: [{ k: 'line', to: [50, 0] }, { k: 'line', to: [50, 50] }] });
  assert.equal(open.closed, false);
  assert.equal(open.points.length, 3);
});

test('toVPath(fromVPath(x)) is shape-stable — a stored mask survives a load-and-save round trip', () => {
  const stored: VPath = { start: [10, 10], prims: [
    { k: 'line', to: [110, 10] },
    { k: 'cubic', c1: [150, 10], c2: [170, 30], to: [170, 70] },
    { k: 'line', to: [10, 70] },
    { k: 'line', to: [10, 10] },
  ] };
  const back = toVPath(fromVPath(stored));
  assert.deepEqual(back.start, stored.start);
  // The GEOMETRY is what may not drift. Compared with `t` stripped, because a save now also
  // WRITES DOWN what the load inferred, and that is an addition rather than a drift.
  const geometry = (p: VPath): Prim[] => p.prims.map(({ t: _t, ...rest }) => rest as Prim);
  assert.deepEqual(geometry(back), stored.prims, 'nothing may drift, and no line may become a cubic');

  // The addition, stated: every anchor comes back with its type RECORDED, so the inference that
  // was legal once at import never has to run on this path again. That is the difference
  // between a format that keeps re-guessing and one that remembers.
  assert.deepEqual(back.prims.map((p) => p.t), ['c', 'c', 'c', 'c']);
  assert.equal(back.startType, 'c');

  // …and a second trip is a FIXED POINT, types included. If it were not, every open-and-save
  // would produce a diff, and a file that changes when nothing changed is a file reviewers stop
  // reading.
  assert.deepEqual(toVPath(fromVPath(back)), back);
});

test('a CORNER with collinear handles survives the round trip as a corner — the flag beats the geometry', () => {
  // THE CASE THE STORED FLAG EXISTS FOR, and the one inference cannot get right by construction.
  // (100,0) carries handles at (60,0) and (140,0): exactly collinear, exactly opposed. Every
  // measurement of that anchor says "smooth". It is a CORNER, because that is what the human
  // said — an Alt-drag broke the pair and then left the two halves in line — and Illustrator
  // keeps breaking them independently forever after.
  const corner: PenPath = { closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [20, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [60, 0], rightDirection: [140, 0], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [180, 0], rightDirection: [200, 0], pointType: 'smooth' },
  ] };

  const stored = toVPath(corner);
  assert.equal(stored.prims[0].t, 'c', 'the flag is written on the primitive that lands on the anchor');
  const back = fromVPath(stored);
  assert.equal(back.points[1].pointType, 'corner',
    'a collinear corner that loads as smooth is a cusp the artifact silently healed');
  assert.equal(back.points[2].pointType, 'smooth', 'and a smooth point is still smooth');
  assert.equal(back.points[0].pointType, 'corner');

  // Proof that it is the FLAG doing the work and not luck: strip the flags off the same
  // geometry and inference gets it wrong, which is what the corpus did before this field.
  const untyped: VPath = {
    start: stored.start,
    prims: stored.prims.map(({ t: _t, ...rest }) => rest as Prim),
  };
  assert.equal(fromVPath(untyped).points[1].pointType, 'smooth',
    'if inference already agreed, this field would be buying nothing');

  // And the whole document round-trips through the committed form the same way.
  const doc: PenDoc = { paths: [corner] };
  const v = toMaskVector(doc, { width: 504, height: 704 })!;
  assert.equal(fromMaskVector(v).paths[0].points[1].pointType, 'corner');
  assert.equal(fromMaskVector(parseMaskVector(JSON.parse(serializeMaskVector(v)))).paths[0].points[1].pointType, 'corner');
});

test('an UNTYPED path still infers — the fitter names no types, and its templates must keep loading', () => {
  // `data/vector-templates.json` is fitted geometry: `vectorizeLoop` emits lines and arcs and
  // no `t` anywhere. An absent flag is not a defect to repair, it is an author with no opinion,
  // and inference is the honest answer for one.
  const fitted: VPath = { start: [0, 0], prims: [
    { k: 'cubic', c1: [40, 0], c2: [60, -40], to: [100, -40] },
    { k: 'cubic', c1: [140, -40], c2: [180, 0], to: [180, 40] },
    { k: 'line', to: [0, 0] },
  ] };
  const pen = fromVPath(fitted);
  assert.equal(pen.points[1].pointType, 'smooth', 'collinear and opposed, with nothing stated: infer');
  assert.equal(pen.points[0].pointType, 'corner');

  // A PARTIALLY typed path — a fitted template after a human has edited one anchor with the pen
  // — takes the stated one and infers the rest.
  const partly: VPath = { ...fitted, prims: [{ ...fitted.prims[0], t: 'c' } as Prim, fitted.prims[1], fitted.prims[2]] };
  assert.equal(fromVPath(partly).points[1].pointType, 'corner', 'the stated anchor is stated');
  assert.equal(fromVPath(partly).points[2].pointType, fromVPath(fitted).points[2].pointType, 'the rest are unaffected');
});

test('fromVPath converts an ArcPrim to cubics accurate to the circle it rides', () => {
  // The fitter emits arcs; the pen has none. Accuracy is checked against the CIRCLE, whose two
  // possible centres are derived here from the arc's own chord and radius — geometry the
  // converter never hands us. Which of the two a given `sweep` selects is Adobe's convention
  // and `arcGeometry`'s business; what this test owns is that the cubics ride ONE of them to
  // sub-thousandth accuracy, and that the two sweeps choose DIFFERENT ones (opposite bulges).
  const chosen: Record<number, number> = {};
  for (const [r, sweep] of [[50, 1], [50, 0], [120, 1], [120, 0]] as const) {
    const from = V(0, 0);
    const to = V(r, r);                                   // chord r*sqrt(2), a quarter turn
    const cubics = arcToCubics(from, { k: 'arc', to: [to.x, to.y], r, sweep });

    const mid = V((from.x + to.x) / 2, (from.y + to.y) / 2);
    const d = D(from, to);
    const h = Math.sqrt(r * r - (d / 2) ** 2);
    const u = V((to.x - from.x) / d, (to.y - from.y) / d);
    const cands = [V(mid.x - u.y * h, mid.y + u.x * h), V(mid.x + u.y * h, mid.y - u.x * h)];

    const worstFor = (c: Vec): number => {
      let cur = from;
      let w = 0;
      for (const cu of cubics) {
        for (let i = 0; i <= 24; i++) w = Math.max(w, Math.abs(D(bez(cur, P(cu.c1), P(cu.c2), P(cu.to), i / 24), c) - r));
        cur = P(cu.to);
      }
      return w;
    };
    const errs = cands.map(worstFor);
    const pick = errs[0] <= errs[1] ? 0 : 1;
    assert.ok(errs[pick] < r * 3e-4,
      `r=${r} sweep=${sweep}: worst radial error ${errs[pick].toFixed(6)} on a radius of ${r}`);
    assert.ok(nearPt(P(cubics[cubics.length - 1].to), to, 1e-9),
      'and the last piece lands on the declared endpoint exactly, so a chain of arcs still closes');
    if (chosen[r] === undefined) chosen[r] = pick; else assert.notEqual(pick, chosen[r], 'the two sweeps must bulge opposite ways');
  }
});

test('an arc sweeping more than 90 degrees becomes more than one cubic', () => {
  // A single cubic cannot hold a half turn to any useful accuracy, so the cap is real.
  const half = arcToCubics(V(0, 0), { k: 'arc', to: [0, 100], r: 50, sweep: 1 });
  assert.ok(half.length >= 2, `a 180-degree sweep needs at least two cubics; got ${half.length}`);
  const quarter = arcToCubics(V(0, 0), { k: 'arc', to: [50, 50], r: 50, sweep: 1 });
  assert.equal(quarter.length, 1, 'and a quarter turn needs exactly one');
});

// ══ Retract, close, continue, join — spec A.6-A.8, items 23-36 ═════════════

/** Three corner anchors in a row, drawn with the pen, path still active at the last one. */
const threeInARow = (): PenState =>
  drive(createPenState(), [...click(0, 0), ...click(100, 0), ...click(100, 100)]);

test('I.23, I.24, I.25 — clicking the active endpoint retracts ONLY the outgoing handle', () => {
  // Draw a smooth last anchor so both handles are live, then click it.
  let s = drive(createPenState(), [...click(0, 0), down(100, 0), move(140, 40), up(140, 40)]);
  const before = pointAt(s, 0, 1);
  assert.equal(before.pointType, 'smooth');
  const leftBefore: [number, number] = [...before.leftDirection];

  assert.equal(cursorFor(drive(s, [move(100, 0)])), 'convert',
    'the active endpoint gets the caret badge, NOT the minus — it is not deletable (I.25)');

  s = drive(s, [...click(100, 0)]);
  const pt = pointAt(s, 0, 1);
  assert.deepEqual(pt.rightDirection, pt.anchor, 'I.23 — the outgoing handle retracts');
  assert.equal(pt.pointType, 'corner');
  assert.deepEqual(pt.leftDirection, leftBefore, 'I.24 — leftDirection is untouched, so the drawn segment keeps its shape');
  assert.equal(activePath(s).points.length, 2, 'I.25 — the anchor is NOT deleted');
  assert.equal(s.activePathIndex, 0, 'and the path stays active — the next segment just starts straight');
});

test('I.26 — clicking the active endpoint again is a no-op, and costs no undo step', () => {
  const s = drive(createPenState(), [...click(0, 0), down(100, 0), move(140, 40), up(140, 40), ...click(100, 0)]);
  const depth = s.undo.length;
  const again = drive(s, [...click(100, 0)]);
  assert.deepEqual(again.doc, s.doc);
  assert.equal(again.undo.length, depth, 'a no-op must not become an undo step users have to press through');
});

test('I.27, I.28 — hovering the first anchor shows the close badge; clicking it closes and ends drawing', () => {
  let s = threeInARow();
  s = reduce(s, move(0, 0));
  assert.equal(cursorFor(s), 'close');
  assert.equal(resolvePenClick(s, V(0, 0), M(), DEFAULT_PEN_CONFIG, 1).kind, 'close');

  s = drive(s, [...click(0, 0)]);
  assert.equal(s.doc.paths[0].closed, true);
  assert.equal(s.activePathIndex, null, 'drawing ends');
  assert.deepEqual(s.selection.paths, [0], 'the path is committed and stays selected');
  assert.deepEqual(s.doc.paths[0].points[0].leftDirection, s.doc.paths[0].points[0].anchor, 'the closing segment arrives retracted');
  assert.equal(segmentCount(s.doc.paths[0]), 3, 'a closed path has as many segments as points');
});

test('I.29 — click-dragging the first anchor closes AND reshapes the first segment [U]', () => {
  // [U] — the exact geometry of click-drag-to-close is not documented by Adobe. This locks the
  // spec's best model: mirrored handles pulled from the first anchor, so the close reshapes the
  // FIRST segment as well as the closing one.
  const s = drive(threeInARow(), [down(0, 0), move(40, -30), up(40, -30)]);
  const pt = s.doc.paths[0].points[0];
  assert.equal(s.doc.paths[0].closed, true);
  assert.equal(pt.pointType, 'smooth');
  assert.ok(nearPt(P(pt.rightDirection), V(40, -30)), 'the outgoing handle follows the cursor');
  assert.ok(nearPt(P(pt.leftDirection), V(-40, 30)), 'and the incoming one mirrors it through the anchor');
});

test('I.30 — Alt-click-dragging the first anchor closes and sets ONLY the incoming handle [U]', () => {
  // [U] — the professional close-without-wrecking-the-start move, per the spec's model.
  const before = threeInARow();
  const rightBefore = [...before.doc.paths[0].points[0].rightDirection];
  const s = drive(before, [down(0, 0), kd('Alt', { alt: true }), move(40, -30, { alt: true }), up(40, -30, { alt: true })]);
  const pt = s.doc.paths[0].points[0];
  assert.equal(s.doc.paths[0].closed, true);
  assert.ok(nearPt(P(pt.leftDirection), V(40, -30)), 'the closing segment gets a handle');
  assert.deepEqual(pt.rightDirection, rightBefore, 'and the first segment is left alone');
  assert.equal(pt.pointType, 'corner');
});

test('I.31, I.32, I.33 — the continue badge appears on an OPEN path\'s endpoint and never on a closed one', () => {
  const openPath: PenPath = { closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [100, 0], rightDirection: [100, 0], pointType: 'corner' },
  ] };
  let s = drive(createPenState({ paths: [openPath] }), [move(100, 0)]);
  assert.equal(cursorFor(s), 'continue', 'I.31');

  s = drive(s, [...click(100, 0), ...click(200, 0)]);
  assert.equal(s.activePathIndex, 0, 'I.32 — that path is now the active one');
  assert.deepEqual(s.doc.paths[0].points.map((p) => p.anchor), [[0, 0], [100, 0], [200, 0]],
    'and drawing resumed OUTWARD from the endpoint that was clicked');

  // I.33: a closed path never offers to continue. Gotcha 22 — it cannot be resumed at all.
  const closed = drive(createPenState({ paths: [{ ...openPath, closed: true }] }), [move(100, 0)]);
  assert.notEqual(cursorFor(closed), 'continue');
  assert.equal(resolvePenClick(closed, V(100, 0), M(), DEFAULT_PEN_CONFIG, 1).kind, 'new-anchor');
});

test('I.32b — resuming from the FIRST endpoint draws backwards, and the close target follows', () => {
  const openPath: PenPath = { closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [100, 0], rightDirection: [100, 0], pointType: 'corner' },
    { anchor: [100, 80], leftDirection: [100, 80], rightDirection: [100, 80], pointType: 'corner' },
  ] };
  const s = drive(createPenState({ paths: [openPath] }), [...click(0, 0), ...click(-60, 0)]);
  assert.equal(s.activeEndpoint, 'first');
  assert.deepEqual(s.doc.paths[0].points[0].anchor, [-60, 0], 'the new anchor is prepended');
  // The close target is the endpoint that is NOT being drawn from — here `points[n-1]`, not
  // `points[0]`. The spec writes `pathPoints[0]` because it assumes forward drawing.
  const hovered = drive(s, [move(100, 80)]);
  assert.equal(cursorFor(hovered), 'close');
});

test('I.34, I.35 — with a path active, an unselected endpoint of a DIFFERENT open path merges', () => {
  const other: PenPath = { closed: false, points: [
    { anchor: [300, 0], leftDirection: [300, 0], rightDirection: [300, 0], pointType: 'corner' },
    { anchor: [400, 0], leftDirection: [400, 0], rightDirection: [400, 0], pointType: 'corner' },
  ] };
  let s = createPenState({ paths: [other] });
  s = drive(s, [...click(0, 0), ...click(100, 0)]);          // a new active path alongside it
  assert.equal(s.doc.paths.length, 2);

  s = reduce(s, move(400, 0));
  assert.equal(cursorFor(s), 'merge', 'I.34');

  s = drive(s, [...click(400, 0)]);
  assert.equal(s.doc.paths.length, 1, 'I.35 — two Paths became one');
  assert.deepEqual(s.doc.paths[0].points.map((p) => p.anchor), [[0, 0], [100, 0], [400, 0], [300, 0]],
    'appended REVERSED, because the clicked endpoint was that path\'s last point');
  assert.equal(s.activePathIndex, 0);
  assert.deepEqual(s.doc.paths[0].points[3].anchor, [300, 0]);
});

test('I.36 — the click precedence of A.8 holds end to end, and a higher rung SHADOWS a lower one', () => {
  const cfg = DEFAULT_PEN_CONFIG;
  // Build the ambiguity deliberately: an active 3-point path whose first anchor is both the
  // close target (rung 2) AND an anchor on a selected path (rung 5, auto-delete).
  const s = threeInARow();
  assert.ok(isPathSelected(s, 0), 'the active path IS selected, so auto add/delete is in scope');
  assert.equal(resolvePenClick(s, V(0, 0), M(), cfg, 1).kind, 'close', 'rung 2 shadows rung 5');
  assert.equal(resolvePenClick(s, V(100, 100), M(), cfg, 1).kind, 'retract-outgoing', 'rung 1 shadows rung 5');
  // Rung 5 is reachable — just not for those two points.
  assert.equal(resolvePenClick(s, V(100, 0), M(), cfg, 1).kind, 'delete-anchor', 'an interior anchor IS rung 5');
  // Rung 6: a point on a segment, away from every anchor.
  assert.equal(resolvePenClick(s, V(50, 0), M(), cfg, 1).kind, 'add-anchor', 'the segment is rung 6');
  // Rung 7: nothing near.
  assert.equal(resolvePenClick(s, V(400, 400), M(), cfg, 1).kind, 'new-anchor');

  // Rung 3 shadows rung 5 too: another path's endpoint wins over this path's auto-delete even
  // when the two are at the same place.
  const overlap = createPenState({ paths: [
    s.doc.paths[0],
    { closed: false, points: [
      { anchor: [100, 0], leftDirection: [100, 0], rightDirection: [100, 0], pointType: 'corner' },
      { anchor: [200, 200], leftDirection: [200, 200], rightDirection: [200, 200], pointType: 'corner' },
    ] },
  ] });
  const withActive: PenState = { ...overlap, activePathIndex: 0, activeEndpoint: 'last', selection: { ...overlap.selection, paths: [0] } };
  assert.equal(resolvePenClick(withActive, V(100, 0), M(), cfg, 1).kind, 'join',
    'rung 3 (join) beats rung 5 (delete) at the same coordinate');
});

// ══ Auto add / delete — spec A.9, items 37-44 ══════════════════════════════

test('I.37, I.38 — clicking a segment of a SELECTED path inserts an anchor and the shape is IDENTICAL', () => {
  // A curved segment with real handles, so the split is a genuine de Casteljau split.
  const curve: PenPath = { closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [30, -90], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [170, 90], rightDirection: [200, 0], pointType: 'corner' },
  ] };
  const base = createPenState({ paths: [curve] });
  const selected: PenState = { ...base, selection: { ...base.selection, paths: [0] } };

  const hovered = drive(selected, [move(100, 0)]);
  assert.equal(cursorFor(hovered), 'add', 'I.37');

  const before = segPoints(selected.doc.paths[0], 0);
  const action = resolvePenClick(selected, V(100, 0), M(), DEFAULT_PEN_CONFIG, 1);
  assert.equal(action.kind, 'add-anchor');
  const t = action.kind === 'add-anchor' ? action.t : 0;

  const s = drive(selected, [down(100, 0), up(100, 0)]);
  assert.equal(s.doc.paths[0].points.length, 3);

  // I.38, numerically: the two halves must retrace the original curve exactly. de Casteljau
  // reparametrises, so the original at u corresponds to half 1 at u/t and half 2 at (u-t)/(1-t).
  const h1 = segPoints(s.doc.paths[0], 0);
  const h2 = segPoints(s.doc.paths[0], 1);
  let worst = 0;
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const orig = bez(before[0], before[1], before[2], before[3], u);
    const split = u <= t
      ? bez(h1[0], h1[1], h1[2], h1[3], t > 0 ? u / t : 0)
      : bez(h2[0], h2[1], h2[2], h2[3], t < 1 ? (u - t) / (1 - t) : 1);
    worst = Math.max(worst, D(orig, split));
  }
  assert.ok(worst < 1e-9, `inserting an anchor must not move the curve at all; worst deviation ${worst}`);
  assert.equal(s.doc.paths[0].points[1].pointType, 'smooth', 'de Casteljau leaves the new point genuinely smooth');
});

test('I.38b — splitting a STRAIGHT segment leaves a retracted corner, so the diff stays a `line`', () => {
  const line: PenPath = { closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [200, 0], rightDirection: [200, 0], pointType: 'corner' },
  ] };
  const out = insertAnchor(line, 0, 0.5, DEFAULT_PEN_CONFIG);
  assert.equal(out.points[1].pointType, 'corner');
  assert.deepEqual(out.points[1].anchor, [100, 0]);
  assert.deepEqual(toVPath(out).prims.map((p) => p.k), ['line', 'line'],
    'a straight card edge must not become two cubics that merely look straight');
});

test('I.39, I.40 — clicking an interior anchor of a SELECTED path removes it and keeps ONE path', () => {
  const s0 = threeInARow();
  const closed = drive(s0, [...click(0, 0)]);               // close it, so topology is testable
  assert.equal(closed.doc.paths[0].closed, true);
  const selected: PenState = { ...closed, selection: { ...closed.selection, paths: [0] } };

  const hovered = drive(selected, [move(100, 0)]);
  assert.equal(cursorFor(hovered), 'delete', 'I.39');

  const s = drive(selected, [...click(100, 0)]);
  assert.equal(s.doc.paths.length, 1, 'I.40 — still ONE path');
  assert.equal(s.doc.paths[0].closed, true, 'and still closed: this preserves CONTINUITY');
  assert.equal(s.doc.paths[0].points.length, 2);
  assert.deepEqual(s.doc.paths[0].points.map((p) => p.anchor), [[0, 0], [100, 100]]);
});

test('I.41 — hovering an UNSELECTED path shows neither badge, so the tool does not feel possessed', () => {
  const curve: PenPath = { closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [30, -90], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [170, 90], rightDirection: [200, 0], pointType: 'corner' },
  ] };
  const s = createPenState({ paths: [curve] });
  assert.equal(isPathSelected(s, 0), false);
  // Away from the endpoints, so the continue rung cannot answer for us.
  const onSegment = drive(s, [move(100, 0)]);
  assert.equal(cursorFor(onSegment), 'start');
  assert.equal(resolvePenClick(s, V(100, 0), M(), DEFAULT_PEN_CONFIG, 1).kind, 'new-anchor');
});

test('I.42 — the disable preference suppresses both badges and both behaviours', () => {
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, autoAddDelete: false };
  const s = threeInARow();
  assert.equal(resolvePenClick(s, V(50, 0), M(), cfg, 1).kind, 'new-anchor');
  assert.equal(resolvePenClick(s, V(100, 0), M(), cfg, 1).kind, 'new-anchor');
  const hovered = drive(s, [move(50, 0)], cfg);
  assert.equal(cursorFor(hovered), 'drawing');
});

test('I.43, I.44 — Shift suppresses add/delete, and releasing it before mouseup applies no constraint', () => {
  const s = threeInARow();
  // I.43: the badge and the action both stand down while Shift is held.
  assert.equal(resolvePenClick(s, V(50, 0), M({ shift: true }), DEFAULT_PEN_CONFIG, 1).kind, 'new-anchor');
  assert.equal(cursorFor(drive(s, [move(50, 0, { shift: true })])), 'drawing');

  // I.44: Shift is doubly loaded, and Adobe's instruction is to release it BEFORE the mouse
  // button. Down WITH Shift (add/delete suppressed, rung 7 taken), up WITHOUT it: the anchor
  // lands exactly where the cursor was, with no 45-degree constraint applied.
  const released = drive(s, [down(50, 0, { shift: true }), up(50, 0, { shift: false })]);
  assert.equal(activePath(released).points.length, 4, 'a new anchor, not an inserted one');
  assert.deepEqual(activePath(released).points[3].anchor, [50, 0], 'unconstrained: exactly where the cursor was');

  // …and holding Shift all the way through DOES constrain, relative to the previous anchor at
  // (100,100): the ray through (50,0) is nearest the 135-degree one, magnitude preserved.
  const held = drive(s, [down(50, 0, { shift: true }), up(50, 0, { shift: true })]);
  const at = P(activePath(held).points[3].anchor);
  const prev = V(100, 100);
  assert.ok(near(D(at, prev), D(V(50, 0), prev), 1e-9), 'magnitude preserved');
  const ang = Math.atan2(at.y - prev.y, at.x - prev.x) * 180 / Math.PI;
  assert.ok(near(Math.abs(((ang % 45) + 45) % 45), 0, 1e-9) || near(Math.abs(((ang % 45) + 45) % 45), 45, 1e-9),
    `constrained onto a 45-multiple ray; got ${ang} degrees`);
});

// ══ Shift constraint — spec A.10, items 45-48 ══════════════════════════════

test('I.45, I.47 — Shift+click projects the anchor onto the nearest 45-multiple ray, magnitude kept', () => {
  const s = drive(createPenState(), [...click(100, 100)]);
  // Cursor 20 degrees off the +x axis from the previous anchor, at a radius of 100.
  const th = 20 * Math.PI / 180;
  const C = V(100 + 100 * Math.cos(th), 100 + 100 * Math.sin(th));
  const out = drive(s, [down(C.x, C.y, { shift: true }), up(C.x, C.y, { shift: true })]);
  const placed = P(activePath(out).points[1].anchor);
  // Independent expectation: the 0-degree ray, radius preserved at exactly 100.
  assert.ok(nearPt(placed, V(200, 100), 1e-9), `projected onto the wrong ray: ${JSON.stringify(placed)}`);
  assert.ok(near(D(placed, V(100, 100)), 100, 1e-9), 'PROJECT, do not clamp — the magnitude survives');
});

test('I.46 — Shift+drag constrains the handle DIRECTION to a 45 multiple and leaves its length free', () => {
  const Q = V(100, 100);
  const th = 30 * Math.PI / 180;                            // nearest 45-multiple is 45
  const C = V(Q.x + 200 * Math.cos(th), Q.y + 200 * Math.sin(th));
  const s = drive(createPenState(), [...click(0, 100), down(Q.x, Q.y), move(C.x, C.y, { shift: true })]);
  const pt = pointAt(s, 0, 1);
  const h = P(pt.rightDirection);
  const ang = Math.atan2(h.y - Q.y, h.x - Q.x) * 180 / Math.PI;
  assert.ok(near(ang, 45, 1e-9), `handle direction should be 45 degrees, got ${ang}`);
  assert.ok(near(D(h, Q), 200, 1e-9), 'length is free — the constraint is angular only');
  assert.ok(nearPt(P(pt.leftDirection), V(2 * Q.x - h.x, 2 * Q.y - h.y), 1e-9), 'and the mirrored handle follows');
});

test('I.48 — a non-zero Constrain Angle rotates both constraints by exactly that amount', () => {
  // Gotcha 9: Shift constrains relative to the Constrain Angle preference, not true horizontal.
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, constrainAngle: 15 };
  const s = drive(createPenState(), [...click(100, 100)], cfg);
  const th = 20 * Math.PI / 180;
  const C = V(100 + 100 * Math.cos(th), 100 + 100 * Math.sin(th));
  const out = drive(s, [down(C.x, C.y, { shift: true }), up(C.x, C.y, { shift: true })], cfg);
  const placed = P(out.doc.paths[0].points[1].anchor);
  const expected = V(100 + 100 * Math.cos(15 * Math.PI / 180), 100 + 100 * Math.sin(15 * Math.PI / 180));
  assert.ok(nearPt(placed, expected, 1e-9), `with a 15-degree constrain angle the rays are 15/60/105; got ${JSON.stringify(placed)}`);
  // And the helper itself: 15 + 45 = 60, not 45.
  const at50 = constrainToAngle(V(0, 0), V(Math.cos(50 * Math.PI / 180), Math.sin(50 * Math.PI / 180)), 15);
  assert.ok(near(Math.atan2(at50.y, at50.x) * 180 / Math.PI, 60, 1e-9));
});

// ══ Termination — spec A.11, items 49-55 ══════════════════════════════════

test('I.49 — Escape during a handle drag aborts that anchor without committing it', () => {
  const before = drive(createPenState(), [...click(0, 0)]);
  const s = drive(before, [down(100, 0), move(140, 60), kd('Escape')]);
  assert.equal(s.drag, null);
  assert.equal(s.doc.paths[0].points.length, 1, 'the anchor being dragged is gone, not committed half-made');
  assert.deepEqual(s.doc, before.doc);
});

test('I.50 — Escape with a path active ends it, leaves it OPEN, and returns to start-new-path', () => {
  const s = drive(threeInARow(), [kd('Escape')]);
  assert.equal(s.activePathIndex, null);
  assert.equal(s.doc.paths[0].closed, false);
  assert.equal(s.doc.paths[0].points.length, 3);
  // Start-path MODE, read where nothing is under the cursor. Parked on the endpoint it just
  // left, the badge is correctly `continue` — the path is now a non-active open path, and
  // offering to resume it is the whole of I.31.
  assert.equal(cursorFor(drive(s, [move(900, 900)])), 'start');
  assert.equal(cursorFor(drive(s, [move(100, 100)])), 'continue');
  // Adobe distinguishes Escape from the other routes: it does NOT leave the path selected.
  assert.deepEqual(s.selection.paths, []);
  assert.equal(s.activeTool, 'pen', 'and it does not change tools');
});

test('I.51 — Enter ends the path and leaves it open, still selected [U]', () => {
  // [U] — whether Enter keeps the selection where Escape drops it is the spec\'s
  // highest-value manual check against real Illustrator. One line to correct if it is not.
  const s = drive(threeInARow(), [kd('Enter')]);
  assert.equal(s.activePathIndex, null);
  assert.equal(s.doc.paths[0].closed, false);
  assert.deepEqual(s.selection.paths, [0]);
});

test('I.52 — Ctrl+click on empty canvas deselects, and deselecting is what ends the path', () => {
  // Gotcha 15: this is not a special "finish path" command. It is literally the selection tool
  // clicking nothing.
  let s = threeInARow();
  s = reduce(s, kd('Control', { ctrl: true }));
  assert.equal(s.activeTool, 'direct-select', 'Ctrl handed us the last-used selection tool');
  assert.equal(s.activePathIndex, 0, 'and the switch alone did NOT end the path');
  s = drive(s, [down(900, 900, { ctrl: true }), up(900, 900, { ctrl: true })]);
  assert.equal(s.activePathIndex, null, 'clicking nothing deselected, which ended the path');
  s = reduce(s, ku('Control'));
  assert.equal(s.activeTool, 'pen');
  assert.equal(cursorFor(s), 'start', 'so releasing Ctrl leaves the Pen in start-new-path state');
});

test('I.53 — Ctrl+Shift+A ends the path and deselects WITHOUT leaving the Pen tool', () => {
  const s = drive(threeInARow(), [kd('a', { ctrl: true, shift: true })]);
  assert.equal(s.activePathIndex, null);
  assert.deepEqual(s.selection.anchors, []);
  assert.deepEqual(s.selection.paths, []);
  assert.equal(s.activeTool, 'pen');
});

test('I.54, I.55 — no termination route closes the path, deletes an anchor, or moves geometry', () => {
  const start = threeInARow();
  const routes: Record<string, PenInput[]> = {
    escape: [kd('Escape')],
    enter: [kd('Enter')],
    'ctrl+shift+A': [kd('a', { ctrl: true, shift: true })],
    'switch tools': [kd('v')],
  };
  for (const [name, inputs] of Object.entries(routes)) {
    const s = drive(start, inputs);
    assert.equal(s.activePathIndex, null, `${name}: the drawing session ends`);
    assert.equal(s.doc.paths[0].closed, false, `${name}: it must NOT close the path`);
    assert.deepEqual(s.doc.paths[0].points, start.doc.paths[0].points, `${name}: geometry is untouched`);
  }
  assert.deepEqual(drive(start, routes['switch tools']).selection.paths, [0],
    'switching tools leaves the path selected, unlike Escape');
});

// ══ Modifier tool-switching — spec B, items 56-64 ═════════════════════════

test('I.56 — Ctrl gives whichever of Selection / Direct Selection was used LAST', () => {
  // Gotcha 14: a user who last pressed V gets the black arrow and is briefly confused.
  // Faithful clones reproduce the confusion.
  const afterV = drive(createPenState(), [kd('v'), kd('p'), kd('Control', { ctrl: true })]);
  assert.equal(afterV.activeTool, 'select');
  const afterA = drive(createPenState(), [kd('a'), kd('p'), kd('Control', { ctrl: true })]);
  assert.equal(afterA.activeTool, 'direct-select');
  assert.equal(createPenState().lastSelectionTool, 'direct-select', 'and the cold-start default');
});

test('I.57, I.58, I.59 — Ctrl does not terminate; release restores the path, endpoint and preview', () => {
  let s = drive(createPenState(), [...click(0, 0), down(100, 0), move(140, 60), up(140, 60), move(200, 0)]);
  const rbBefore = s.rubberBand!;
  assert.deepEqual(rbBefore.c1, [140, 60]);

  s = reduce(s, kd('Control', { ctrl: true }));
  assert.equal(s.activePathIndex, 0, 'I.57 — still active');
  assert.equal(s.activeEndpoint, 'last');

  // Move the anchor's handle while the selection tool is borrowed.
  s = drive(s, [down(140, 60, { ctrl: true }), move(140, 20, { ctrl: true }), up(140, 20, { ctrl: true })]);
  assert.deepEqual(pointAt(s, 0, 1).rightDirection, [140, 20]);

  s = reduce(s, ku('Control'));
  assert.equal(s.activeTool, 'pen', 'I.58 — the pen comes back');
  assert.equal(s.activePathIndex, 0);
  assert.equal(s.activeEndpoint, 'last');
  assert.deepEqual(s.rubberBand!.c1, [140, 20], 'I.59 — and the rubber band recomputed from the moved geometry');
});

test('I.61 — Alt makes the Pen behave as the Anchor Point tool for the duration', () => {
  let s = drive(createPenState(), [...click(0, 0), ...click(100, 0)]);
  s = reduce(s, kd('Alt', { alt: true }));
  assert.equal(s.activeTool, 'anchor-point');
  assert.equal(s.toolBeforeModifier, 'pen');
  s = reduce(s, ku('Alt'));
  assert.equal(s.activeTool, 'pen');
  assert.equal(s.toolBeforeModifier, null);
  assert.equal(s.activePathIndex, 0, 'the momentary switch never touched the active path');
});

test('I.61b — Ctrl and Alt held together restore the Pen only when BOTH are up', () => {
  // Spec B.2 notes Alt and spacebar do not compose and users release Alt first. Whatever the
  // order, dropping the pen back in while another modifier is still down would leave the tool
  // fighting the user\'s hand.
  let s = drive(createPenState(), [...click(0, 0)]);
  s = reduce(s, kd('Control', { ctrl: true }));
  s = reduce(s, kd('Alt', { ctrl: true, alt: true }));
  s = reduce(s, ku('Control', { alt: true }));
  assert.notEqual(s.activeTool, 'pen', 'one modifier is still down');
  s = reduce(s, ku('Alt'));
  assert.equal(s.activeTool, 'pen');
});

test('I.62, I.63 — spacebar with the mouse DOWN translates the anchor and both handles rigidly', () => {
  const Q = V(100, 100);
  let s = drive(createPenState(), [...click(0, 100), down(Q.x, Q.y), move(160, 100)]);
  const before = pointAt(s, 0, 1);
  const shape: [Vec, Vec] = [
    { x: before.leftDirection[0] - before.anchor[0], y: before.leftDirection[1] - before.anchor[1] },
    { x: before.rightDirection[0] - before.anchor[0], y: before.rightDirection[1] - before.anchor[1] },
  ];

  s = reduce(s, kd(' ', { space: true }));
  s = reduce(s, move(200, 130, { space: true }));
  const moved = pointAt(s, 0, 1);
  const d = V(40, 30);
  assert.ok(nearPt(P(moved.anchor), V(Q.x + d.x, Q.y + d.y)), 'the anchor took the cursor\'s delta');
  for (const [i, side] of ([moved.leftDirection, moved.rightDirection] as const).entries()) {
    assert.ok(nearPt(
      { x: side[0] - moved.anchor[0], y: side[1] - moved.anchor[1] },
      shape[i],
    ), 'and each handle kept its offset exactly — the shape translates, it does not deform');
  }
  assert.equal(s.intent, null, 'with the button down, space is NOT a pan');

  // I.63: because the anchor and handles took exactly the cursor's delta, `rightDirection` is
  // still the cursor — so resuming the handle drag cannot jump.
  assert.ok(nearPt(P(moved.rightDirection), V(200, 130)), 'the outgoing handle is still under the cursor');
  s = reduce(s, ku(' '));
  s = reduce(s, move(210, 130));
  const after = pointAt(s, 0, 1);
  assert.ok(nearPt(P(after.rightDirection), V(210, 130)), 'and the drag resumes from there');
  assert.ok(nearPt(P(after.anchor), V(140, 130)), 'without dragging the anchor along');
});

test('I.64 — spacebar with the mouse UP is a pan REQUEST; the engine does not pan', () => {
  // Gotcha 11: the same key means two different things depending on button state. The engine
  // owns neither the viewport nor the scroll position, so it says what should happen and stops.
  const s = drive(createPenState(), [...click(0, 0), move(50, 50), kd(' ', { space: true })]);
  assert.deepEqual(s.intent, { kind: 'pan' });
  assert.deepEqual(s.doc.paths[0].points[0].anchor, [0, 0], 'and nothing in the document moved');
  // The intent belongs to the input that raised it and is cleared on the next one, so a UI
  // reading it once per reduce can never act on a stale request.
  assert.equal(reduce(s, move(60, 60)).intent, null);
});

test('the keyboard table names which host bindings the pen claims, and when', () => {
  // The host editor binds bare 0/+/-/Space for zoom and pan (ViewTransform). `+` and `-` are
  // Illustrator's anchor-tool keys, so the pen claims them outright; Space is claimed only
  // while a button is down, which is why it cannot simply be moved.
  for (const k of PEN_CLAIMED_HOST_KEYS) {
    const b = PEN_KEY_BINDINGS.find((x) => x.key === k);
    assert.ok(b, `${k} must appear in the table`);
    assert.equal(b!.claimsFromHost, true, `${k} must be flagged as claimed from the host`);
  }
  assert.ok(PEN_CONDITIONAL_HOST_KEYS.includes(' '), 'Space is conditional, not claimed');
  assert.equal(PEN_KEY_BINDINGS.some((b) => b.key === ' '), false,
    'and it is therefore NOT a plain binding — it is resolved against pointer-button state');
  // Every binding is reachable through the one lookup the logic uses.
  for (const b of PEN_KEY_BINDINGS) {
    assert.ok(lookupBinding(b.key, { ...b.mods }), `${b.label} is unreachable`);
  }
});

test('I.93, I.94 — Caps Lock outranks every badge, and "cannot draw here" is its own symbol', () => {
  const s = threeInARow();
  assert.equal(cursorFor(drive(s, [move(0, 0)])), 'close');
  assert.equal(cursorFor(drive(s, [move(0, 0, { capsLock: true })])), 'crosshair',
    'the #1 cause of "my pen cursor turned into an X"');
  const locked: PenState = { ...drive(s, [move(100, 0)]), locked: true };
  assert.equal(cursorFor(locked), 'blocked');
  assert.notEqual(cursorFor(locked), 'continue', 'the slashed circle is NOT the continue slash');
});

// ══ Direct Selection — spec C, items 66-85 ════════════════════════════════

/** Four anchors, the middle one smooth with DELIBERATELY UNEQUAL handle lengths. */
const asymmetric = (): PenDoc => ({ paths: [{ closed: false, points: [
  { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [20, 0], pointType: 'corner' },
  { anchor: [100, 0], leftDirection: [60, 0], rightDirection: [180, 0], pointType: 'smooth' },
  { anchor: [200, 0], leftDirection: [190, 0], rightDirection: [220, 0], pointType: 'corner' },
  { anchor: [300, 0], leftDirection: [280, 0], rightDirection: [300, 0], pointType: 'corner' },
] }] });

const directSelect = (doc: PenDoc): PenState => drive(createPenState(doc), [kd('a')]);

test('I.66, I.67 — `A` activates Direct Selection and clicking an anchor selects it ALONE', () => {
  const s = drive(directSelect(asymmetric()), [down(200, 0), up(200, 0)]);
  assert.equal(s.activeTool, 'direct-select');
  assert.deepEqual(s.selection.anchors, [{ path: 0, point: 2 }]);
});

test('I.68, I.69 — a marquee selects every anchor inside, testing POSITIONS only', () => {
  // A curve whose bulge passes through the band while its anchors stay outside: it must NOT be
  // selected. Rank on segment bounds instead and marqueeing stops being predictable.
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 400], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [200, 400], rightDirection: [200, 0], pointType: 'corner' },
  ] }] };
  const mid = bez(V(0, 0), V(0, 400), V(200, 400), V(200, 0), 0.5);
  assert.ok(mid.y > 250, `the curve really does pass through the band (y=${mid.y})`);
  const s = drive(directSelect(doc), [down(-50, 200), move(250, 320), up(250, 320)]);
  assert.deepEqual(s.selection.anchors, [], 'I.69 — the marquee tests anchors, not the ink');

  const both = drive(directSelect(doc), [down(-50, -50), move(250, 50), up(250, 50)]);
  assert.deepEqual(both.selection.anchors, [{ path: 0, point: 0 }, { path: 0, point: 1 }], 'I.68');
});

test('I.70, I.71 — Shift+click TOGGLES an anchor, and Shift+marquee adds rather than replaces', () => {
  let s = drive(directSelect(asymmetric()), [down(0, 0), up(0, 0)]);
  s = drive(s, [down(200, 0, { shift: true }), up(200, 0, { shift: true })]);
  assert.deepEqual(s.selection.anchors.map((a) => a.point), [0, 2], 'Shift+click adds');
  s = drive(s, [down(200, 0, { shift: true }), up(200, 0, { shift: true })]);
  assert.deepEqual(s.selection.anchors.map((a) => a.point), [0], 'Shift+click on a SELECTED anchor removes it');

  s = drive(s, [down(280, -30, { shift: true }), move(320, 30, { shift: true }), up(320, 30, { shift: true })]);
  assert.deepEqual(s.selection.anchors.map((a) => a.point), [0, 3], 'I.71 — Shift+marquee extends');
});

test('I.72 — dragging a selected anchor translates it and BOTH handles rigidly', () => {
  const before = asymmetric().paths[0].points[1];
  const s = drive(directSelect(asymmetric()), [down(100, 0), move(130, 40), up(130, 40)]);
  const pt = pointAt(s, 0, 1);
  const d = V(30, 40);
  assert.deepEqual(pt.anchor, [130, 40]);
  assert.deepEqual(pt.leftDirection, [before.leftDirection[0] + d.x, before.leftDirection[1] + d.y]);
  assert.deepEqual(pt.rightDirection, [before.rightDirection[0] + d.x, before.rightDirection[1] + d.y]);
  assert.equal(pt.pointType, 'smooth', 'a rigid move is not a type change');
});

test('I.73 — dragging one handle of a SMOOTH point rotates the opposite COLLINEAR, keeping ITS OWN length', () => {
  // Spec 0.1 — the single most-missed detail. Created mirrored, EDITED collinear-keeping-length.
  // Clone only the mirrored rule and every asymmetric curve snaps back symmetric on every tug.
  const doc = asymmetric();
  const anchor = V(100, 0);
  const leftLenBefore = D(P(doc.paths[0].points[1].leftDirection), anchor);
  assert.ok(near(leftLenBefore, 40) , 'the fixture is deliberately asymmetric: 40 one side, 80 the other');
  assert.ok(near(D(P(doc.paths[0].points[1].rightDirection), anchor), 80));

  const s = drive(directSelect(doc), [down(180, 0), move(140, 60), up(140, 60)]);
  const pt = pointAt(s, 0, 1);
  const right = P(pt.rightDirection);
  const left = P(pt.leftDirection);
  assert.ok(nearPt(right, V(140, 60)), 'the dragged handle goes where the cursor went');
  assert.ok(near(D(left, anchor), leftLenBefore, 1e-9),
    `the opposite handle must KEEP ITS OWN LENGTH: was ${leftLenBefore}, now ${D(left, anchor)}`);
  // Collinear and OPPOSED, computed here from the two vectors rather than asked of the engine.
  const u = { x: (right.x - anchor.x) / D(right, anchor), y: (right.y - anchor.y) / D(right, anchor) };
  const w = { x: (left.x - anchor.x) / D(left, anchor), y: (left.y - anchor.y) / D(left, anchor) };
  assert.ok(near(u.x * w.y - u.y * w.x, 0, 1e-12), 'collinear');
  assert.ok(u.x * w.x + u.y * w.y < -0.999999, 'and on the far side, not folded back');
  assert.equal(pt.pointType, 'smooth');
});

test('I.73b — the two smooth rules are genuinely different: placement mirrors, editing does not', () => {
  // Same point type, two different times. Placed here with a 60-unit drag, then edited with a
  // 200-unit one: mirroring would make the far side 200 too.
  let s = drive(createPenState(), [...click(0, 0), down(100, 0), move(100, 60), up(100, 60)]);
  const placed = pointAt(s, 0, 1);
  assert.ok(near(D(P(placed.leftDirection), V(100, 0)), 60), 'created MIRRORED — equal lengths');

  s = drive(s, [kd('a'), down(100, 60), move(300, 0), up(300, 0)]);
  const edited = pointAt(s, 0, 1);
  assert.ok(near(D(P(edited.rightDirection), V(100, 0)), 200, 1e-9), 'the dragged side is now 200 long');
  assert.ok(near(D(P(edited.leftDirection), V(100, 0)), 60, 1e-9),
    'and the opposite side is STILL 60 — it rotated, it did not re-mirror');
});

test('I.74 — Alt+dragging one handle of a SMOOTH anchor breaks the pair and sets CORNER', () => {
  const doc = asymmetric();
  const leftBefore = [...doc.paths[0].points[1].leftDirection];
  const s = drive(directSelect(doc), [down(180, 0, { alt: true }), move(140, 60, { alt: true }), up(140, 60, { alt: true })]);
  const pt = pointAt(s, 0, 1);
  assert.equal(pt.pointType, 'corner');
  assert.deepEqual(pt.leftDirection, leftBefore, 'the opposite handle is untouched');
  assert.deepEqual(pt.rightDirection, [140, 60]);
});

test('I.74b — dragging a handle back INTO its anchor gives a one-handle CORNER, not a smooth point', () => {
  // Spec C.3: a smooth point cannot have a retracted side, because collinearity is undefined.
  const pt = asymmetric().paths[0].points[1];
  const out = dragHandle(pt, 'right', V(100, 0), false, DEFAULT_PEN_CONFIG);
  assert.equal(out.pointType, 'corner');
  assert.deepEqual(out.rightDirection, [100, 0]);
  assert.deepEqual(out.leftDirection, pt.leftDirection, 'and the other side survives — it is a ONE-handle point');
});

test('I.75 — dragging a curved segment reshapes it without selecting its anchors first', () => {
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [40, -60], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [160, -60], rightDirection: [200, 0], pointType: 'corner' },
  ] }] };
  const s0 = directSelect(doc);
  assert.deepEqual(s0.selection.anchors, [], 'nothing is selected to begin with');

  const before = segPoints(doc.paths[0], 0);
  const grab = bez(before[0], before[1], before[2], before[3], 0.5);
  const target = V(grab.x + 10, grab.y - 50);
  const s = drive(s0, [down(grab.x, grab.y), move(target.x, target.y), up(target.x, target.y)]);

  assert.deepEqual(s.doc.paths[0].points[0].anchor, [0, 0], 'the endpoints do not move');
  assert.deepEqual(s.doc.paths[0].points[1].anchor, [200, 0]);
  const after = segPoints(s.doc.paths[0], 0);
  const t = 0.5;
  assert.ok(D(bez(after[0], after[1], after[2], after[3], t), target) < 1e-9,
    'the curve now passes through the cursor AT THE GRABBED PARAMETER');
});

test('I.76 — with Constrain Path Dragging on, a segment drag holds the endpoint handle ANGLES', () => {
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, constrainSegmentReshape: true };
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [40, -60], pointType: 'corner' },
    { anchor: [200, 0], leftDirection: [160, -60], rightDirection: [200, 0], pointType: 'corner' },
  ] }] };
  const ang = (h: [number, number], a: [number, number]): number => Math.atan2(h[1] - a[1], h[0] - a[0]);
  const a0 = ang(doc.paths[0].points[0].rightDirection, doc.paths[0].points[0].anchor);
  const a1 = ang(doc.paths[0].points[1].leftDirection, doc.paths[0].points[1].anchor);

  const before = segPoints(doc.paths[0], 0);
  const grab = bez(before[0], before[1], before[2], before[3], 0.5);
  const s = drive(directSelect(doc), [down(grab.x, grab.y), move(grab.x + 5, grab.y - 40), up(grab.x + 5, grab.y - 40)], cfg);
  const p = s.doc.paths[0].points;
  assert.ok(near(ang(p[0].rightDirection, p[0].anchor), a0, 1e-9), 'the first handle only changed LENGTH');
  assert.ok(near(ang(p[1].leftDirection, p[1].anchor), a1, 1e-9), 'and so did the second');
  assert.notDeepEqual(p[0].rightDirection, doc.paths[0].points[0].rightDirection, 'but it did change');
});

test('I.77, I.78 — arrow keys nudge every selected anchor by the increment; Shift is exactly 10x', () => {
  const base = drive(directSelect(asymmetric()), [down(-20, -20), move(120, 20), up(120, 20)]);
  assert.equal(base.selection.anchors.length, 2);

  const one = drive(base, [kd('ArrowRight')]);
  assert.deepEqual(one.doc.paths[0].points[0].anchor, [1, 0]);
  assert.deepEqual(one.doc.paths[0].points[1].anchor, [101, 0]);
  assert.deepEqual(one.doc.paths[0].points[1].leftDirection, [61, 0], 'handles ride along');
  assert.deepEqual(one.doc.paths[0].points[2].anchor, [200, 0], 'unselected anchors do not move');

  const ten = drive(base, [kd('ArrowRight', { shift: true })]);
  assert.deepEqual(ten.doc.paths[0].points[0].anchor, [10, 0], 'exactly 10x, hardcoded, not a second preference');

  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, keyboardIncrement: 4 };
  assert.deepEqual(drive(base, [kd('ArrowDown')], cfg).doc.paths[0].points[0].anchor, [0, 4]);
  assert.deepEqual(drive(base, [kd('ArrowDown', { shift: true })], cfg).doc.paths[0].points[0].anchor, [0, 40]);
});

test('I.79 — the nudge axes rotate with the Constrain Angle [U]', () => {
  // [U] — reported but never documented by Adobe. With the default angle of 0 this is the
  // identity, so the unverified part only bites a user who changed the preference.
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, constrainAngle: 90 };
  const base = drive(directSelect(asymmetric()), [down(0, 0), up(0, 0)]);
  assert.ok(nearPt(P(drive(base, [kd('ArrowRight')], cfg).doc.paths[0].points[0].anchor), V(0, 1), 1e-12),
    '"right" along a 90-degree constrain angle is +y');
  assert.deepEqual(drive(base, [kd('ArrowRight')]).doc.paths[0].points[0].anchor, [1, 0],
    'and at the default 0 it is plain +x');
});

test('I.19-quirk — an arrow key does NOT break the Pen\'s connection to the active path, by decision', () => {
  // Illustrator loses the active path after a nudge; LucasFonts calls it a probable bug and the
  // spec says decide deliberately rather than inherit it. We keep drawing — and the flag exists
  // so the choice is visible and reversible in one line.
  const kept = drive({ ...threeInARow(), selection: { anchors: [{ path: 0, point: 1 }], handles: [], segments: [], paths: [] } }, [kd('ArrowRight')]);
  assert.equal(kept.activePathIndex, 0, 'our default keeps the pen attached');
  const inherited = drive(
    { ...threeInARow(), selection: { anchors: [{ path: 0, point: 1 }], handles: [], segments: [], paths: [] } },
    [kd('ArrowRight')],
    { ...DEFAULT_PEN_CONFIG, arrowKeyBreaksActivePath: true },
  );
  assert.equal(inherited.activePathIndex, null, 'and the flag reproduces Illustrator faithfully');
});

test('I.80, I.82 — Delete on an interior anchor of an OPEN path SPLITS it into two open paths', () => {
  const five: PenDoc = { paths: [{ closed: false, points: [0, 1, 2, 3, 4].map((i) => ({
    anchor: [i * 50, 0] as [number, number], leftDirection: [i * 50, 0] as [number, number],
    rightDirection: [i * 50, 0] as [number, number], pointType: 'corner' as const,
  })) }] };
  const before = segmentCount(five.paths[0]);
  assert.equal(before, 4);

  const sel = { anchors: [{ path: 0, point: 2 }], handles: [], segments: [], paths: [] };
  const s = drive({ ...directSelect(five), selection: sel }, [kd('Delete')]);
  assert.equal(s.doc.paths.length, 2, 'I.80 — two open paths');
  assert.equal(s.doc.paths[0].closed, false);
  assert.deepEqual(s.doc.paths[0].points.map((p) => p.anchor), [[0, 0], [50, 0]]);
  assert.deepEqual(s.doc.paths[1].points.map((p) => p.anchor), [[150, 0], [200, 0]]);
  const after = segmentCount(s.doc.paths[0]) + segmentCount(s.doc.paths[1]);
  assert.equal(after, 2, `I.82 — BOTH adjoining segments went, not just the anchor: ${before} -> ${after}`);
});

test('I.81, I.83 — Delete on a closed path OPENS it, and a second Delete removes what is left', () => {
  const closed = drive(threeInARow(), [...click(0, 0)]);
  assert.equal(closed.doc.paths[0].closed, true);
  const sel = { anchors: [{ path: 0, point: 1 }], handles: [], segments: [], paths: [] };
  const first = drive({ ...closed, selection: sel }, [kd('Delete')]);
  assert.equal(first.doc.paths.length, 1);
  assert.equal(first.doc.paths[0].closed, false, 'I.81 — the path opened');
  assert.deepEqual(first.doc.paths[0].points.map((p) => p.anchor), [[100, 100], [0, 0]]);
  assert.deepEqual(first.selection.paths, [0], 'the remaining object is selected');
  assert.deepEqual(first.selection.anchors, [], 'and no anchor is');

  const second = drive(first, [kd('Delete')]);
  assert.equal(second.doc.paths.length, 0, 'I.83 — the second Delete removes the object');
});

test('I.84, I.85 — the Delete Anchor Point path keeps ONE closed path and does NOT preserve shape', () => {
  // Gotcha 18: it maintains CONTINUITY, not shape, and the Shift-click-to-preserve-curve trick
  // was removed from current Illustrator. Promising shape preservation would be a promise the
  // tool cannot keep.
  const doc: PenDoc = { paths: [{ closed: true, points: [
    { anchor: [0, 0], leftDirection: [-40, -40], rightDirection: [40, -40], pointType: 'smooth' },
    { anchor: [200, 0], leftDirection: [160, -40], rightDirection: [240, 40], pointType: 'smooth' },
    { anchor: [200, 200], leftDirection: [240, 160], rightDirection: [160, 240], pointType: 'smooth' },
    { anchor: [0, 200], leftDirection: [40, 240], rightDirection: [-40, 160], pointType: 'smooth' },
  ] }] };
  const sel = { anchors: [{ path: 0, point: 1 }], handles: [], segments: [], paths: [] };
  const s = drive({ ...directSelect(doc), selection: sel }, [kd('-')]);
  assert.equal(s.doc.paths.length, 1, 'I.84 — ONE path');
  assert.equal(s.doc.paths[0].closed, true, 'and still closed');
  assert.equal(s.doc.paths[0].points.length, 3);
  // The neighbours kept their OWN handles, so the merged segment is a different curve.
  const seg = segPoints(s.doc.paths[0], 0);
  const mid = bez(seg[0], seg[1], seg[2], seg[3], 0.5);
  const origA = segPoints(doc.paths[0], 0);
  const origB = segPoints(doc.paths[0], 1);
  const nearestOriginal = Math.min(
    ...Array.from({ length: 101 }, (_, i) => Math.min(
      D(mid, bez(origA[0], origA[1], origA[2], origA[3], i / 100)),
      D(mid, bez(origB[0], origB[1], origB[2], origB[3], i / 100)),
    )),
  );
  assert.ok(nearestOriginal > 1, `I.85 — the curve visibly changed (nearest original point ${nearestOriginal.toFixed(2)}px)`);
});

// ══ Anchor Point tool — spec D, items 86-90 ═══════════════════════════════

test('I.86, I.87, I.88, I.89, I.90 — Shift+C is the SAME ENGINE as Alt-with-the-Pen', () => {
  // "Implement once, expose twice." A second copy of these rules under the pen is how the two
  // drift apart, so the test asserts the two routes produce IDENTICAL documents.
  const doc = (): PenDoc => ({ paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [60, 0], rightDirection: [140, 0], pointType: 'smooth' },
    { anchor: [200, 0], leftDirection: [200, 0], rightDirection: [200, 0], pointType: 'corner' },
  ] }] });

  const viaTool = (inputs: PenInput[]): PenState => drive(createPenState(doc()), [kd('c', { shift: true }), ...inputs]);
  const viaAlt = (inputs: PenInput[]): PenState =>
    drive(createPenState(doc()), [kd('Alt', { alt: true }), ...inputs.map((i) => ({ ...i, mods: { ...i.mods, alt: true } }))]);

  assert.equal(viaTool([]).activeTool, 'anchor-point', 'I.86');

  const gestures: Record<string, PenInput[]> = {
    'I.87 click a smooth anchor -> corner, both retract': [down(100, 0), up(100, 0)],
    'I.88 drag a corner anchor -> smooth, mirrored': [down(200, 0), move(260, 40), up(260, 40)],
    'I.89 drag one handle -> break the pair, corner': [down(140, 0), move(150, 70), up(150, 70)],
  };
  for (const [name, inputs] of Object.entries(gestures)) {
    const a = viaTool(inputs);
    const b = viaAlt(inputs);
    assert.deepEqual(a.doc, b.doc, `I.90 — ${name}: the two routes must agree exactly`);
  }

  const clicked = viaTool(gestures['I.87 click a smooth anchor -> corner, both retract']);
  assert.equal(pointAt(clicked, 0, 1).pointType, 'corner');
  assert.deepEqual(pointAt(clicked, 0, 1).leftDirection, [100, 0]);
  assert.deepEqual(pointAt(clicked, 0, 1).rightDirection, [100, 0]);

  const dragged = viaTool(gestures['I.88 drag a corner anchor -> smooth, mirrored']);
  assert.equal(pointAt(dragged, 0, 2).pointType, 'smooth');
  assert.deepEqual(pointAt(dragged, 0, 2).rightDirection, [260, 40]);
  assert.deepEqual(pointAt(dragged, 0, 2).leftDirection, [140, -40], 'mirrored exactly');

  const broken = viaTool(gestures['I.89 drag one handle -> break the pair, corner']);
  assert.equal(pointAt(broken, 0, 1).pointType, 'corner');
  assert.deepEqual(pointAt(broken, 0, 1).leftDirection, [60, 0], 'the opposite handle untouched');
});

// ══ Display and zoom — items 99, 100 ═════════════════════════════════════

test('I.99 — selecting exactly ONE anchor shows FOUR handle stubs, not two', () => {
  // Gotcha 23, and a big part of the feel: the two own handles PLUS the one facing handle on
  // each neighbour — the handles that actually control the two touching segments.
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [-20, 0], rightDirection: [20, 0], pointType: 'smooth' },
    { anchor: [100, 0], leftDirection: [80, 0], rightDirection: [120, 0], pointType: 'smooth' },
    { anchor: [200, 0], leftDirection: [180, 0], rightDirection: [220, 0], pointType: 'smooth' },
  ] }] };
  const s = drive(directSelect(doc), [down(100, 0), up(100, 0)]);
  const stubs = visibleHandles(s);
  assert.equal(stubs.length, 4, `four stubs, got ${JSON.stringify(stubs)}`);
  assert.deepEqual(stubs.map((h) => `${h.point}${h.side[0]}`).sort(), ['0r', '1l', '1r', '2l'],
    'own left+right, plus the previous point\'s OUTGOING and the next point\'s INCOMING');

  // Two selected: no neighbour stubs, and the multi-select preference governs the rest.
  const two = drive(s, [down(200, 0, { shift: true }), up(200, 0, { shift: true })]);
  assert.equal(visibleHandles(two).length, 4, 'both selected anchors\' own handles');
  assert.equal(visibleHandles(two, { ...DEFAULT_PEN_CONFIG, showHandlesWhenMultipleSelected: false }).length, 0,
    'and the F.4 preference turns them off when more than one is selected');
  // A retracted handle is not drawn: there is nothing there to draw.
  const flat = drive(directSelect({ paths: [{ closed: false, points: [
    { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
    { anchor: [100, 0], leftDirection: [100, 0], rightDirection: [100, 0], pointType: 'corner' },
  ] }] }), [down(0, 0), up(0, 0)]);
  assert.deepEqual(visibleHandles(flat), []);
});

test('I.100 — hit radii are SCREEN pixels and stay constant under zoom', () => {
  const doc: PenDoc = { paths: [{ closed: false, points: [
    { anchor: [100, 100], leftDirection: [100, 100], rightDirection: [100, 100], pointType: 'corner' },
    { anchor: [300, 100], leftDirection: [300, 100], rightDirection: [300, 100], pointType: 'corner' },
  ] }] };
  const cfg = DEFAULT_PEN_CONFIG;                              // anchorHitRadiusPx = 6

  // Five SCREEN px from the anchor must hit at every zoom — which means a different document
  // distance at every zoom.
  for (const zoom of [0.25, 1, 4]) {
    const at = V(100, 100 + 5 / zoom);        // perpendicular, so only the anchor tier can answer
    const hit = hitTest(doc, at, cfg, zoom);
    assert.deepEqual(hit, { kind: 'anchor', path: 0, point: 0 }, `5 screen px must hit at zoom ${zoom}`);
  }
  // And a fixed DOCUMENT distance must stop hitting as you zoom in: 5 document units is 5
  // screen px at 1x (a hit) and 20 at 4x (a miss).
  assert.equal(hitTest(doc, V(100, 105), cfg, 1)!.kind, 'anchor');
  assert.equal(hitTest(doc, V(100, 105), cfg, 4), null, 'store a screen radius in document units and this passes');
});

// ══ Undo — items 123, 124 ════════════════════════════════════════════════

test('I.123 — one anchor placement is exactly ONE undo step, however many frames it took', () => {
  const s = drive(createPenState(), [
    ...click(0, 0),
    down(100, 0), move(110, 10), move(130, 40), kd('Alt', { alt: true }), move(150, 60, { alt: true }), up(150, 60, { alt: true }),
  ]);
  assert.equal(s.undo.length, 2, `two placements, two steps; got ${s.undo.length}`);
  const back = drive(s, [kd('z', { ctrl: true })]);
  assert.equal(back.doc.paths[0].points.length, 1, 'one Ctrl+Z removes the whole second placement');
  assert.equal(drive(back, [kd('z', { ctrl: true, shift: true })]).doc.paths[0].points.length, 2, 'and redo puts it back');
});

test('I.124 — undo during an active path restores the previous anchor AND the drawing state', () => {
  // The constraint that dictates the snapshot shape: restore the document alone and the pen has
  // nothing to continue from, which is the version every editor ships first.
  let s = drive(createPenState(), [...click(0, 0), ...click(100, 0), ...click(100, 100)]);
  s = drive(s, [kd('z', { ctrl: true })]);
  assert.equal(s.doc.paths[0].points.length, 2);
  assert.equal(s.activePathIndex, 0, 'still drawing');
  assert.equal(s.activeEndpoint, 'last');
  assert.deepEqual(drive(s, [move(200, 0)]).rubberBand!.from, [100, 0], 'and the preview hangs off the restored anchor');

  s = drive(s, [...click(200, 0)]);
  assert.deepEqual(s.doc.paths[0].points.map((p) => p.anchor), [[0, 0], [100, 0], [200, 0]], 'drawing simply continues');
});

test('I.125 — Ctrl+J joins two selected endpoints with a straight segment, no dialog', () => {
  const two: PenDoc = { paths: [
    { closed: false, points: [
      { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [0, 0], pointType: 'corner' },
      { anchor: [100, 0], leftDirection: [60, -40], rightDirection: [140, 40], pointType: 'smooth' },
    ] },
    { closed: false, points: [
      { anchor: [300, 0], leftDirection: [260, 40], rightDirection: [340, -40], pointType: 'smooth' },
      { anchor: [400, 0], leftDirection: [400, 0], rightDirection: [400, 0], pointType: 'corner' },
    ] },
  ] };
  const sel = { anchors: [{ path: 0, point: 1 }, { path: 1, point: 0 }], handles: [], segments: [], paths: [] };
  const s = drive({ ...directSelect(two), selection: sel }, [kd('j', { ctrl: true })]);
  assert.equal(s.doc.paths.length, 1);
  assert.deepEqual(s.doc.paths[0].points.map((p) => p.anchor), [[0, 0], [100, 0], [300, 0], [400, 0]]);
  // The two original segments keep their curves — a join must not straighten geometry the user
  // already made. Only the NEW segment, index 1, is a line.
  assert.deepEqual(toVPath(s.doc.paths[0]).prims.map((p) => p.k), ['cubic', 'line', 'cubic'],
    'the joining segment is STRAIGHT, which means both facing handles retracted — and only those two');

  // Two endpoints of ONE open path close it instead.
  const one = { ...directSelect({ paths: [two.paths[0]] }), selection: { anchors: [{ path: 0, point: 0 }, { path: 0, point: 1 }], handles: [], segments: [], paths: [] } };
  const closed = drive(one, [kd('j', { ctrl: true })]);
  assert.equal(closed.doc.paths[0].closed, true);
  assert.equal(closed.doc.paths[0].points.length, 2, 'and closes it without adding an anchor');
});

// ══ Snapping — injected, and bounded by the engine ═══════════════════════

test('a rogue snap function proposing a 40px move is REFUSED and the anchor lands where the hand put it', () => {
  // THE GUARDRAIL, and it is not advisory. `line-snap` may nudge a hand line by ~2px and its
  // tests assert the result stays within 1.5px of where the hand put it; edge-trace enforces a
  // hard 5px corridor. A pen that obeyed an unbounded snap callback would be the hole in that.
  const rogue: SnapFn = () => ({ point: { x: 340, y: 300 }, kind: 'confident-edge' });
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, snap: rogue };
  const s = drive(createPenState(), [down(300, 300), up(300, 300)], cfg);
  assert.deepEqual(s.doc.paths[0].points[0].anchor, [300, 300], 'the anchor is exactly where the user put it');
  assert.equal(s.snapped, null);
  assert.match(s.snapRefusal!, /refused/, 'and the refusal is recorded, not silent');
  assert.match(s.snapRefusal!, /40\.00 screen px/, 'stating how far it wanted to move');
});

test('a snap inside the limit is APPLIED, and the limit is measured in SCREEN pixels', () => {
  const nudge: SnapFn = (p) => ({ point: { x: p.x + 1.5, y: p.y }, kind: 'anchor' });
  const cfg: PenConfig = { ...DEFAULT_PEN_CONFIG, snap: nudge };     // maxSnapMovePx = 2
  const applied = drive(createPenState(), [down(300, 300), up(300, 300)], cfg);
  assert.deepEqual(applied.doc.paths[0].points[0].anchor, [301.5, 300]);
  assert.deepEqual(applied.snapped, { point: [301.5, 300], kind: 'anchor' });

  // The SAME 1.5 document units is 6 screen px at 4x — over the limit, so now it is refused.
  const zoomed = drive(createPenState(), [down(300, 300, {}, 4), up(300, 300, {}, 4)], cfg);
  assert.deepEqual(zoomed.doc.paths[0].points[0].anchor, [300, 300]);
  assert.match(zoomed.snapRefusal!, /6\.00 screen px/);
});

test('angular construction snapping ships OFF — the Pen does no angular snapping by default', () => {
  // I.104: Illustrator's factory default has Construction Guides OFF, so out of the box the Pen
  // performs no angular construction snapping at all. Shipping them on feels "grabby".
  assert.deepEqual(DEFAULT_PEN_CONFIG.constructionAngles, []);
  assert.equal(DEFAULT_PEN_CONFIG.snap, null, 'and no snap provider is wired in by default');
  const s = drive(createPenState(), [...click(0, 0), ...click(103, 7)]);
  assert.deepEqual(s.doc.paths[0].points[1].anchor, [103, 7], 'an off-axis anchor is left off-axis');
});

test('reduce is pure: the input state is never mutated, and PenState stays plain data', () => {
  const before = drive(createPenState(), [...click(0, 0), ...click(100, 0)]);
  const frozen = JSON.stringify(before);
  drive(before, [down(100, 100), move(150, 150), up(150, 150), kd('Delete'), kd('z', { ctrl: true })]);
  assert.equal(JSON.stringify(before), frozen, 'a reducer that mutates its input cannot be snapshotted for undo');
  // Plain data: it survives a JSON round trip unchanged, which is what makes undo cheap and a
  // bug report reproducible from a log line.
  const s = drive(before, [down(100, 100), move(150, 150)]);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('reversePenPath swaps every point\'s handles, not just the order', () => {
  // Reverse the array alone and every curve reflects across its own chord: it still closes,
  // still rasterises, and is the wrong shape.
  const path = asymmetric().paths[0];
  const r = reversePenPath(path);
  assert.deepEqual(r.points.map((p) => p.anchor), path.points.map((p) => p.anchor).reverse());
  assert.deepEqual(r.points[2].leftDirection, path.points[1].rightDirection);
  assert.deepEqual(r.points[2].rightDirection, path.points[1].leftDirection);
  // And the shape is genuinely unchanged: sample the reversed path backwards.
  const f = segmentCubic(path, 1);
  const b = segmentCubic(r, 1);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    assert.ok(D(
      bez(f.from, P(f.prim.c1), P(f.prim.c2), P(f.prim.to), t),
      bez(b.from, P(b.prim.c1), P(b.prim.c2), P(b.prim.to), 1 - t),
    ) < 1e-9, `the reversed curve diverged at t=${t}`);
  }
});

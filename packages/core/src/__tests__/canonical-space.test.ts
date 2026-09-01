// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Canonical space is DERIVED, or it is not canonical.
//
// The point of 4b is that the space is the physical card and not a raster, and
// the only thing that keeps that true over time is that nothing types a raster
// number in. So this file does two jobs:
//
//   1. recompute every derived value from the millimetre constants and assert
//      the modules agree;
//   2. read the SOURCES BACK and fail if a derived value was ever typed in as
//      a literal. A test that only checks CANONICAL_W === 504 passes just as
//      happily against `export const CANONICAL_W = 504`, which is exactly the
//      drift it is supposed to catch.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CANONICAL_CORNER_RADIUS_PX,
  CANONICAL_H,
  CANONICAL_PX_PER_MM,
  CANONICAL_W,
  CARD_ASPECT_HW,
  CARD_ASPECT_WH,
  CARD_CORNER_RADIUS_FRACTION,
  CARD_CORNER_RADIUS_MM,
  CARD_HEIGHT_MM,
  CARD_WIDTH_MM,
  canonicalCorners,
  canonicalPxToMm,
  mmToCanonicalPx,
} from '../canonical-space.ts';
import datum from '../card-space.json' with { type: 'json' };

// packages/core/src/__tests__ -> the repository root.
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CORE = join(ROOT, 'packages/core/src');
const THREE_REACT = join(ROOT, 'packages/three/src/react');
const FORGE = join(ROOT, 'packages/forge/src');
const RESOLVER = join(ROOT, 'packages/resolver/src');

test('the datum is the four millimetre constants, read from one file', () => {
  assert.equal(CARD_WIDTH_MM, datum.widthMm);
  assert.equal(CARD_HEIGHT_MM, datum.heightMm);
  assert.equal(CARD_CORNER_RADIUS_MM, datum.cornerRadiusMm);
  assert.equal(CANONICAL_PX_PER_MM, datum.pxPerMm);
});

test('the canonical raster and the corner are recomputed from millimetres', () => {
  assert.equal(CANONICAL_W, CARD_WIDTH_MM * CANONICAL_PX_PER_MM);
  assert.equal(CANONICAL_H, CARD_HEIGHT_MM * CANONICAL_PX_PER_MM);
  assert.equal(CANONICAL_CORNER_RADIUS_PX, CARD_CORNER_RADIUS_MM * CANONICAL_PX_PER_MM);
  assert.equal(CARD_CORNER_RADIUS_FRACTION, CARD_CORNER_RADIUS_MM / CARD_WIDTH_MM);
  assert.equal(CARD_ASPECT_WH, CARD_WIDTH_MM / CARD_HEIGHT_MM);
  assert.equal(CARD_ASPECT_HW, CARD_HEIGHT_MM / CARD_WIDTH_MM);
  assert.equal(CARD_ASPECT_WH * CARD_ASPECT_HW, 1);
});

test('the raster is integral in both axes — a half pixel would shift every mask', () => {
  assert.ok(Number.isInteger(CANONICAL_W), `${CANONICAL_W} is not an integer`);
  assert.ok(Number.isInteger(CANONICAL_H), `${CANONICAL_H} is not an integer`);
});

test('the raster is exactly 63:88 with no rounding — that is the whole point', () => {
  assert.equal(CANONICAL_W * CARD_HEIGHT_MM, CANONICAL_H * CARD_WIDTH_MM);
  // And the framing it replaces was not. 490x674 is 245:337, 1.55% short.
  assert.notEqual(490 * CARD_HEIGHT_MM, 674 * CARD_WIDTH_MM);
});

test('conversions round-trip', () => {
  assert.equal(canonicalPxToMm(mmToCanonicalPx(CARD_WIDTH_MM)), CARD_WIDTH_MM);
  assert.equal(mmToCanonicalPx(CARD_WIDTH_MM), CANONICAL_W);
});

test('canonicalCorners is clockwise from the top-left with y down', () => {
  assert.deepEqual(canonicalCorners(), [
    [0, 0],
    [CANONICAL_W, 0],
    [CANONICAL_W, CANONICAL_H],
    [0, CANONICAL_H],
  ]);
});

// ── The one that actually holds the line ───────────────────────────────────

/**
 * Strip comments and doc strings before looking for literals: the provenance
 * notes name 504, 704, 490 and 245:337 on purpose, and they should. It is the
 * EXECUTABLE text that must not contain them.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN: { value: string; why: string }[] = [
  { value: '504', why: 'the canonical width' },
  { value: '704', why: 'the canonical height' },
  { value: '490', why: 'the pre-4b authoring width' },
  { value: '674', why: 'the pre-4b authoring height' },
];

// DeckPal had TWO canonical-space modules — one per app, because apps/api
// could not import apps/web. The extraction collapsed them into one, so there
// is one to guard here instead of two.
for (const file of [
  join(CORE, 'canonical-space.ts'),
  join(THREE_REACT, 'MaskEditor.tsx'),
  // The forge's mask raster is the same number seen from the authoring side.
  // It was NOT guarded in DeckPal; guarding it here is what keeps the count at
  // three after the two canonical-space modules collapsed into one.
  join(FORGE, 'generate-masks.ts'),
]) {
  test(`no derived raster number is typed into ${file.slice(ROOT.length + 1)}`, () => {
    const src = code(file);
    for (const { value, why } of FORBIDDEN) {
      const hit = new RegExp(`(?<![\\w.])${value}(?![\\w.])`).exec(src);
      assert.equal(
        hit,
        null,
        `${value} (${why}) appears in executable code. Derive it from the millimetre constants instead — ` +
          'a file that restates its own arithmetic can disagree with itself.',
      );
    }
  });
}

test('era-layouts.json records the DERIVED aspect and corner, not typed-in ones', () => {
  const layouts = JSON.parse(readFileSync(join(RESOLVER, 'era-layouts.json'), 'utf8')) as {
    measuredIn: string;
    cardAspect: [number, number];
    cornerRadius: number;
  };
  assert.equal(layouts.measuredIn, 'canonical');
  assert.deepEqual(
    layouts.cardAspect,
    [CARD_WIDTH_MM, CARD_HEIGHT_MM],
    'cardAspect is the shader\'s isotropy denominator; it must be the physical card, not a raster',
  );
  assert.equal(
    layouts.cornerRadius,
    CARD_CORNER_RADIUS_FRACTION,
    'cornerRadius must equal 3/63 exactly — the old value 0.047 was that expression, rounded',
  );
});

// ── The contract-drift signal ──────────────────────────────────────────────
//
// A canon file carries two numbers: `contract` (the law it is read under) and
// `tunedUnderContract` (the law its numbers were chosen under). When they
// differ, the file has NOT been rechecked since the ground moved, and the pair
// is the retune queue.
//
// This used to assert `tunedUnderContract <= contract` — which cannot fire.
// Nothing in the repo ever writes a tunedUnderContract above the current
// contract, so the check passed in every reachable state including every state
// it was supposed to warn about. A drift signal that cannot fire is not a
// signal.
//
// So the datum below is the EXPECTED STATE, listed out: which canons exist,
// and what pair each one carries. It is not derived from the files, because a
// check derived from the thing it checks is the same non-signal in a different
// shape. Two things now surface, both loudly:
//
//   * A CONTRACT BUMP. Contract 3 lands, the 32 files get restamped
//     `contract: 3`, and every row here disagrees. Whoever bumps must come
//     here and say so — which is the moment to also decide what the retune
//     queue looks like under the new law.
//   * A SILENT RETUNE. Someone edits a canon's uniforms and moves its
//     `tunedUnderContract` to 2 (or moves it WITHOUT retuning, which is worse).
//     One row disagrees and names the file.
//
// Today all 32 are `{ contract: 2, tunedUnderContract: 1 }`: 4b moved
// CARD_ASPECT and nothing has been retuned. That is the queue — see
// docs/CANON-ASPECT-RECHECK.md for the per-canon delta and the order
// to work it in.
const TUNED_UNDER_CONTRACT_1 = [
  'big-glitter', 'confetti', 'cosmos', 'cosmos-ii-pixel', 'cosmos-iii-smooth', 'cracked-ice',
  'detective-pikachu', 'diagonal-sheen-left', 'diagonal-sheen-right', 'ex-emerald', 'fireworks',
  'gold-secret', 'horizontal-sheen', 'mirror', 'pinwheel', 'pokeball-hologram', 'radiant',
  'radiant-collection-dots', 'rainbow-glitter', 'rainbow-glitter-sheen', 'reverse-sheet', 'sequin',
  'shiny-vault', 'starlight', 'starlight-ii', 'striped-vertical-sheen', 'tinsel', 'tinsel-ii',
  'vertical-sheen', 'vertical-sheen-rainbow', 'vstar-pearl', 'water-web',
] as const;

/** canon slug -> the (contract, tunedUnderContract) pair it is expected to carry. */
const EXPECTED_TUNING: Record<string, { contract: number; tunedUnderContract: number }> = Object.fromEntries(
  TUNED_UNDER_CONTRACT_1.map((slug) => [slug, { contract: 2, tunedUnderContract: 1 }]),
);

test('every canon file stamps the composite contract it is read under', () => {
  const contract = (
    JSON.parse(readFileSync(join(CORE, 'composite-contract.json'), 'utf8')) as { contract: number }
  ).contract;
  const dir = join(ROOT, 'data/foil-canon');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 32, `expected the 32 canon files, found ${files.length}`);
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
      contract?: number;
      tunedUnderContract?: number;
    };
    assert.equal(j.contract, contract, `${f} is stamped for a different contract than the current law`);
    assert.equal(typeof j.tunedUnderContract, 'number', `${f} does not say which contract it was tuned under`);
  }
});

test('the canon corpus is in the tuning state this file says it is in', () => {
  const dir = join(ROOT, 'data/foil-canon');
  const slugs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

  assert.deepEqual(
    slugs,
    Object.keys(EXPECTED_TUNING).sort(),
    'the set of canon files changed. A new canon must be listed in EXPECTED_TUNING with the pair it ships ' +
      'with; a deleted one must be removed from it.',
  );

  for (const slug of slugs) {
    const j = JSON.parse(readFileSync(join(dir, `${slug}.json`), 'utf8')) as {
      contract?: number;
      tunedUnderContract?: number;
    };
    assert.deepEqual(
      { contract: j.contract, tunedUnderContract: j.tunedUnderContract },
      EXPECTED_TUNING[slug],
      `${slug}.json is (contract ${String(j.contract)}, tunedUnderContract ${String(j.tunedUnderContract)}), which ` +
        'is not the state this test records. Either the composite contract was bumped (update every row and ' +
        'restate the retune queue) or this canon was retuned (update its row, and say so in ' +
        'docs/CANON-ASPECT-RECHECK.md).',
    );
  }
});

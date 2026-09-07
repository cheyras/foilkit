#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/build-ink-index.mjs — derive the resolver's ink-design index.
//
//   data/ink-designs.json                 (canonical, cited, hand-reviewed)
//     └─► packages/resolver/src/ink-index.json   (trimmed, bundle-friendly)
//
// Same split as tools/build-assignments-index.mjs: the registry carries the
// prose, the measurement provenance and the ownership reasoning; the shipped
// index carries only what resolveInk actually reads. Regenerate after ANY
// change to the registry:
//
//   node tools/build-ink-index.mjs            write
//   node tools/build-ink-index.mjs --check    build in memory, diff, exit 1
//
// The validation here is the point of the file existing at all. A row that
// names a tile with no SVG on disk, or a queued mark with no `queued` entry,
// would render as "no design" at runtime and look exactly like a row nobody had
// written yet — a silent hole in a corpus whose whole claim is that nothing is
// ever blank. It fails the build instead.
//
// THREE MORE CHECKS, each of which exists because the thing it checks shipped:
//
//   * TILE <-> ROW, BOTH DIRECTIONS. A row naming a tile that does not exist
//     was already fatal; a TILE that no row can reach was not, and two of the
//     four shipped that way. Unreachable is a legitimate state — a drawn asset
//     waiting for the evidence that says where it belongs — but it has to be
//     DECLARED in `unkeyedTiles` with its reason, and the declaration is
//     checked against the rows in both directions so it cannot rot either way.
//
//   * THE SEAM. A tile is one lattice cell and the shader repeats it, so its
//     edges have to meet their own opposites. `pinstripe-diagonal.svg` shipped
//     with its corner-wrap triangles at half the size the geometry needs and
//     measured 66/255 across its own wrap — a grid line down every card it was
//     used on, in a file that read as perfectly reasonable and said "tiles
//     seamlessly" in its own `desc`. Every tile is measured now
//     (tools/ink-tile-seam.mjs) and only 0 passes.
//
//   * A NULL TILE MEANS EXACTLY ONE THING. `tile: null` is either a QUEUED
//     trademark or a recorded `noInk` decision — never both, never neither.
//     Otherwise a row somebody left half-written reads at runtime as a decision
//     somebody made.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seamError } from './ink-tile-seam.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'data', 'ink-designs.json');
const OUT = join(root, 'packages', 'resolver', 'src', 'ink-index.json');
const CHECK = process.argv.includes('--check');

const src = JSON.parse(readFileSync(SRC, 'utf8'));

const SCOPE_KINDS = new Set(['card', 'subset', 'set', 'era']);
const CONF = new Set(['high', 'medium', 'low']);
const DELTA = new Set(['null', 'frame', 'full']);
const PLACEMENT_KEYS = ['across', 'phaseX', 'phaseY', 'turns', 'jitter', 'stagger', 'strength', 'tone'];

const fail = (msg) => {
  console.error(`build-ink-index: ${msg}`);
  process.exit(1);
};

// ── Tiles ──────────────────────────────────────────────────────────────────
const tiles = {};
for (const [id, t] of Object.entries(src.tiles)) {
  if (!t.file.startsWith('data/ink-tiles/')) fail(`tile ${id}: file must live in data/ink-tiles/`);
  if (!existsSync(join(root, t.file))) fail(`tile ${id}: ${t.file} does not exist`);
  // AGENTS.md F5 — a measurement carries its n, and a refusal to measure says
  // so out loud rather than shipping a number with no provenance.
  if (typeof t.period?.across !== 'number') fail(`tile ${id}: period.across must be a number`);
  if (typeof t.period.n !== 'number') fail(`tile ${id}: period.n is required, 0 included`);
  if (t.period.n > 0 && !t.period.measuredOn) fail(`tile ${id}: n > 0 but nothing is cited as measured`);
  if (t.period.n === 0 && t.period.confidence !== null)
    fail(`tile ${id}: n = 0 must carry confidence null, not "${t.period.confidence}"`);
  // THE SEAM, measured on the real geometry. A tile that does not meet its own
  // opposite edge draws a grid line across every card it is used on, and it is
  // invisible in the file, in a diff and in a code review.
  let seam;
  try {
    seam = seamError(readFileSync(join(root, t.file), 'utf8'), { label: `tile ${id}` });
  } catch (err) {
    fail(`tile ${id}: ${err.message}`);
  }
  if (seam !== 0)
    fail(
      `tile ${id}: does not tile seamlessly — mean |Δcoverage| ${seam}/255 across its own wrap. Whatever leaves one ` +
        'edge must arrive at the opposite edge at the same offset; see tools/ink-tile-seam.mjs.',
    );
  tiles[id] = {
    file: t.file,
    across: t.period.across,
    n: t.period.n,
    conf: t.period.confidence ?? null,
    seam,
  };
}

const queued = new Set(src.queued.map((q) => q.tileId));

const unkeyed = Object.fromEntries(Object.entries(src.unkeyedTiles ?? {}).filter(([k]) => k !== '$doc'));
for (const [id, why] of Object.entries(unkeyed)) {
  if (!tiles[id]) fail(`unkeyedTiles names "${id}", which is not a tile — a note about an asset that does not exist`);
  if (typeof why !== 'string' || why.length < 40)
    fail(`unkeyedTiles["${id}"]: an unkeyed tile carries the REASON it is unkeyed, not a placeholder`);
}

// ── Rows ───────────────────────────────────────────────────────────────────
const rows = src.rows.map((r, i) => {
  const at = `rows[${i}] (${r.scope})`;
  if (!SCOPE_KINDS.has(r.scopeKind)) fail(`${at}: bad scopeKind ${r.scopeKind}`);
  if (!r.scope) fail(`${at}: empty scope`);
  if (!CONF.has(r.conf)) fail(`${at}: bad conf ${r.conf}`);
  if (!DELTA.has(r.delta)) fail(`${at}: bad delta class ${r.delta} — 3b's three are null|frame|full`);
  if (r.tile !== null && !tiles[r.tile]) fail(`${at}: names tile "${r.tile}", which is not in tiles{}`);
  if (r.tile === null && r.queued && !queued.has(r.queued))
    fail(`${at}: queued "${r.queued}" has no entry in queued[] — a queued slot with no laundry-list row is a gap nobody can see`);
  // A NULL TILE MEANS EXACTLY ONE THING. Either a trademark we may not trace
  // (`queued`) or a decision that this printing needs none (`noInk`) — and the
  // resolver answers a different state for each, because "somebody is expected
  // to draw this" and "this was considered and needs nothing" are not the same
  // report. Neither would mean a half-written row read at runtime as a
  // decision; both would mean the registry contradicts itself.
  const noInk = r.noInk === true;
  if (r.tile === null && noInk && r.queued)
    fail(`${at}: is both queued ("${r.queued}") and noInk — a null tile has exactly one meaning`);
  if (r.tile === null && !noInk && !r.queued)
    fail(
      `${at}: has no tile, no queued mark and no noInk decision. Say which: a trademarked slot left empty carries ` +
        '`queued`, a printing that needs no tile carries `noInk: true` and a note saying why.',
    );
  if (r.tile !== null && noInk) fail(`${at}: names a tile AND declares noInk`);
  // The rarity gate matches a WHOLE rarity, so the entries have to BE whole
  // rarities: already lowercased and single-spaced, or the row silently gates
  // on a string no catalog value can ever equal.
  for (const x of r.rarities ?? [])
    if (x !== x.toLowerCase().replace(/\s+/g, ' ').trim())
      fail(`${at}: rarity "${x}" is not normalised — the gate is an exact match, so write it lowercase and trimmed`);
  for (const k of PLACEMENT_KEYS)
    if (typeof r.placement[k] !== 'number') fail(`${at}: placement.${k} must be a number`);
  if (r.scopeKind === 'subset' && (!Array.isArray(r.cards) || r.cards.length === 0))
    fail(`${at}: a subset scope is defined by its cards — the catalog has no subset field`);
  return {
    scope: r.scope,
    kind: r.scopeKind,
    types: r.types?.map((t) => t.toLowerCase()) ?? null,
    kinds: r.kinds ?? null,
    rar: r.rarities?.map((x) => x.toLowerCase()) ?? null,
    cards: r.cards ?? null,
    tile: r.tile ?? null,
    queued: r.queued ?? null,
    noInk,
    pl: PLACEMENT_KEYS.map((k) => r.placement[k]),
    delta: r.delta,
    conf: r.conf,
    src: r.src,
  };
});

// ── TILE <-> ROW, both directions ──────────────────────────────────────────
//
// A tile no row can reach renders nowhere, and nothing else in this repository
// would ever say so. It is allowed — geometry can legitimately arrive before
// the evidence that keys it — but only DECLARED, with the reason, so the next
// person finds a note instead of a mystery and does not key it to an era on the
// strength of it merely existing.
const usedTiles = new Set(rows.map((r) => r.tile).filter((t) => t !== null));
for (const id of Object.keys(tiles)) {
  if (usedTiles.has(id) && unkeyed[id])
    fail(
      `tile ${id}: is listed in unkeyedTiles but rows now use it — delete the entry, the note has outlived the gap`,
    );
  if (!usedTiles.has(id) && !unkeyed[id])
    fail(
      `tile ${id}: exists but NO ROW can reach it, and it is not declared in unkeyedTiles. Key it to a row the ` +
        'evidence supports, or record why it is not keyed yet — an unreachable tile that nothing explains gets ' +
        'deleted as dead weight or keyed on a hunch, and both are worse than the note.',
    );
}

const out = {
  $doc: [
    'DERIVED FILE - do not hand-edit. Generated by tools/build-ink-index.mjs',
    `from data/ink-designs.json (${rows.length} rows, ${Object.keys(tiles).length} tiles, ${queued.size} queued).`,
    'Trimmed for the SPA bundle: notes, measurement prose and ownership reasoning stripped.',
    'The registry is the source of record; regenerate after changing it.',
    '`pl` is the placement vector, in this order: ' + PLACEMENT_KEYS.join(', '),
  ],
  generatedFrom: 'data/ink-designs.json',
  version: src.version,
  placementKeys: PLACEMENT_KEYS,
  rowCount: rows.length,
  tiles,
  // Shipped, drawn, and reachable from no row yet — with the reason, so the
  // next person finds a note instead of a mystery.
  unkeyedTiles: unkeyed,
  queued: src.queued.map((q) => ({ tileId: q.tileId, mark: q.mark, usedBy: q.usedBy, why: q.why })),
  // The `shows` override map, minus its $doc. Empty today and that is the
  // honest state — see the registry.
  frameShows: Object.fromEntries(Object.entries(src.frameShows).filter(([k]) => k !== '$doc')),
  rows,
};

const text = JSON.stringify(out, null, 1) + '\n';

if (CHECK) {
  const on = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (on !== text) {
    console.error('build-ink-index: packages/resolver/src/ink-index.json is stale — run tools/build-ink-index.mjs');
    process.exit(1);
  }
  console.log(
    `build-ink-index: up to date (${rows.length} rows, ${Object.keys(tiles).length} tiles, all seamless, ` +
      `${Object.keys(unkeyed).length} unkeyed and declared)`,
  );
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(
    `wrote ${OUT} (${rows.length} rows, ${Object.keys(tiles).length} tiles, all seamless, ${queued.size} queued, ` +
      `${Object.keys(unkeyed).length} unkeyed and declared)`,
  );
}

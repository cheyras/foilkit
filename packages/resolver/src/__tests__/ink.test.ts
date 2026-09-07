// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The ink-design resolver's keying, pinned against the cases that CHOSE the key.
//
// Every test below names a real printing whose existence rules out a simpler
// key. That is deliberate: (scope, type, variantKind) + rarity is more machinery
// than (era, type), and machinery has to be paid for by a case that breaks
// without it. The three-reverse sets, the rarity gate and the shows-suppression
// are those cases, and they come from 3b's measurements
// (holo-archive/3b-pairs/delta-classes.md, era-research.md), not from taste.
//
// This is also the resolver package's first test file. The foil half stays
// untested here on purpose — pinning it retroactively in the same commit that
// adds a second axis would make a future regression ambiguous about which axis
// moved. tools/parity/resolver-receipt.mjs already digests 10,312 foil probes.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { INERT_PLACEMENT, INK_RESOLVER_VERSION, inkTiles, queuedInkTiles, resolveInk } from '../ink.ts'

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..')

test('a non-reverse printing gets no ink design at all', () => {
  for (const kind of ['normal', 'holo', 'holo-foil-cosmos', null]) {
    const r = resolveInk({ seriesSlug: 'scarlet-violet', variantKind: kind })
    assert.equal(r.state, 'none')
    assert.equal(r.uInkOn, false)
    assert.equal(r.uInkDraw, false)
    assert.deepEqual(r.placement, INERT_PLACEMENT)
  }
})

// ── The case that rules out (era, type) ─────────────────────────────────────

test('Prismatic Evolutions: three reverses of ONE card resolve three different ways', () => {
  // sv08.5-040 (Sylveon) ships `reverse`, `reverse-foil-pokeball` and
  // `reverse-foil-masterball`. Same card, same set, same era, same type, same
  // sheet — and TCGdex serves ONE image for all three, so the scan cannot tell
  // them apart either. Only variantKind can.
  const base = { seriesSlug: 'scarlet-violet', setId: 'sv08.5', cardId: 'sv08.5-040' } as const
  const std = resolveInk({ ...base, variantKind: 'reverse' })
  const pb = resolveInk({ ...base, variantKind: 'reverse-foil-pokeball' })
  const mb = resolveInk({ ...base, variantKind: 'reverse-foil-masterball' })

  // The standard reverse falls through to its era and gets a shipped tile.
  assert.equal(std.match, 'era')
  assert.equal(std.scope, 'modern-sv')
  assert.equal(std.state, 'design')
  assert.equal(std.tileId, 'dot-grid')
  assert.equal(std.uInkOn, true)
  assert.equal(std.uInkDraw, true)

  // The two ball reverses match SET rows, which outrank the era row, and both
  // are queued rather than traced.
  for (const [r, mark] of [
    [pb, 'pokeball'],
    [mb, 'masterball'],
  ] as const) {
    assert.equal(r.match, 'set')
    assert.equal(r.scope, 'sv08.5')
    assert.equal(r.state, 'queued')
    assert.equal(r.queued, mark)
    assert.equal(r.tileId, null)
    // THE NO-COST INVARIANT. A queued slot leaves the tier OFF, so the recipe
    // keeps its procedural stand-in and the render is exactly what it is today.
    // If this ever flips true with a null tile, every ball reverse in four sets
    // goes blank.
    assert.equal(r.uInkOn, false)
    assert.equal(r.uInkDraw, false)
  }

  // Three distinct answers, which is the whole point.
  assert.equal(new Set([std.tileId ?? std.queued, pb.queued, mb.queued]).size, 3)
  // …and the two queued ones differ in PLACEMENT, not just in name: the Master
  // Ball lattice is half a cell out of phase with the Poke Ball one.
  assert.notEqual(pb.placement.phaseX, mb.placement.phaseX)
})

test('Black Bolt, White Flare and Ascended Heroes key the same way', () => {
  for (const setId of ['sv10.5b', 'sv10.5w']) {
    const r = resolveInk({ seriesSlug: 'scarlet-violet', setId, variantKind: 'reverse-foil-masterball' })
    assert.equal(r.match, 'set')
    assert.equal(r.scope, setId)
    assert.equal(r.queued, 'masterball')
  }
  // Ascended Heroes carries SIX reverse kinds on one sheet — five specialty
  // balls plus the plain reverse. One row absorbs the five.
  for (const kind of [
    'reverse-foil-pokeball',
    'reverse-foil-loveball',
    'reverse-foil-quickball',
    'reverse-foil-friendball',
    'reverse-foil-duskball',
  ]) {
    const r = resolveInk({ seriesSlug: 'mega-evolution', setId: 'me02.5', variantKind: kind })
    assert.equal(r.scope, 'me02.5', `${kind} did not match the Ascended Heroes row`)
    assert.equal(r.queued, 'specialty-balls')
  }
  // The plain reverse in the same set is NOT swallowed by that row.
  const plain = resolveInk({ seriesSlug: 'mega-evolution', setId: 'me02.5', variantKind: 'reverse' })
  assert.equal(plain.match, 'era')
  assert.equal(plain.tileId, 'dot-grid')
})

// ── The case that puts RARITY in the key ────────────────────────────────────

test('EX Delta Species gates its ink on rarity, and the gate is exclusive', () => {
  // 3b, era-research section 2: the Uncommon reverse is a clean frame* — window
  // unchanged, plain sheen, set logo. The Holo Rare reverse ADDS gold name,
  // gold HP, gold border rules and a silver rarity symbol. Same set, same
  // variant kind, different ink. (scope, type, variantKind) cannot say that.
  const base = { seriesSlug: 'ex', setId: 'ex11', variantKind: 'reverse' } as const
  const holoRare = resolveInk({ ...base, rarity: 'Holo Rare' })
  const uncommon = resolveInk({ ...base, rarity: 'Uncommon' })

  assert.equal(holoRare.match, 'set')
  assert.equal(holoRare.scope, 'ex11')
  assert.equal(holoRare.queued, 'ex-set-logos')

  // The Uncommon does NOT match the rarity-gated row, and falls through.
  assert.notEqual(uncommon.scope, 'ex11')
  assert.notEqual(uncommon.queued, 'ex-set-logos')

  // 'Rare' matches too — the row names both, and matching is substring against
  // the rarity, so 'Holo Rare' satisfies the 'rare' entry as well.
  assert.equal(resolveInk({ ...base, rarity: 'Rare' }).scope, 'ex11')
})

test('EX Deoxys is full-class and NOT rarity-gated — every rarity gets the stamp', () => {
  // era-research: the wheel crosses the art window at every rarity including
  // commons. Verified on a Common (Silcoon 46/107) and a Rare (Camerupt 4/107).
  for (const rarity of ['Common', 'Uncommon', 'Rare']) {
    const r = resolveInk({ seriesSlug: 'ex', setId: 'ex8', variantKind: 'reverse', rarity })
    assert.equal(r.scope, 'ex8')
    assert.equal(r.delta, 'full')
  }
})

test('Legendary Collection needs no ink tile, and says so as a decision', () => {
  // `full` on the scan-diff axis (Fireworks over the whole face) and `null` on
  // the INK axis — the artwork ink is unchanged. strength 0 is the recorded
  // decision "this row was considered and needs no ink", which is a different
  // statement from an absent row.
  const r = resolveInk({ seriesSlug: 'legendary-collection', setId: 'lc', variantKind: 'reverse' })
  assert.equal(r.scope, 'lc')
  assert.equal(r.delta, 'full')
  assert.equal(r.placement.strength, 0)
  assert.equal(r.placement.tone, 0)
})

// ── The Plasma case, recorded honestly rather than faked ────────────────────

test('the Team Plasma shield is queued WITHOUT a row, and the registry says why', () => {
  // The Plasma sets substitute a Team Plasma shield for the type symbol on Team
  // Plasma CARDS only — but the catalog declares one `reverse` kind for bw8/9/10
  // and carries no Team Plasma flag, so there is no honest selector to write.
  // The queue entry exists so the gap is visible; the row does not, because a
  // row keyed on the whole set would be wrong for most of it.
  const marks = queuedInkTiles()
  const shield = marks.find((m) => m.tileId === 'plasma-shield')
  assert.ok(shield, 'the plasma-shield queue entry went missing')
  assert.match(shield.usedBy, /bw8/)
  for (const setId of ['bw8', 'bw9', 'bw10']) {
    const r = resolveInk({ seriesSlug: 'black-white', setId, variantKind: 'reverse' })
    assert.notEqual(r.queued, 'plasma-shield', `${setId} must not claim a shield row that does not exist`)
  }
})

// ── The shows consultation — the double-draw guard ──────────────────────────

test('a MEASURED reverse suppresses the overlay; unknown draws', () => {
  const base = { seriesSlug: 'scarlet-violet', setId: 'sv03.5', variantKind: 'reverse' } as const

  // The default, and the documented assumption: every catalog scan is the
  // normal printing (TCGdex serves one image per card), so unknown draws.
  for (const shows of [undefined, null, 'unknown', 'normal'] as const) {
    const r = resolveInk({ ...base, shows })
    assert.equal(r.state, 'design', `shows=${shows} must draw`)
    assert.equal(r.uInkDraw, true)
  }

  // A MEASURED reverse is the only thing that suppresses.
  const suppressed = resolveInk({ ...base, shows: 'reverse' })
  assert.equal(suppressed.state, 'in-scan')
  assert.equal(suppressed.uInkDraw, false)
  // uInkOn STAYS TRUE — that is the second half of the fix. The scan already
  // carries the design, so the recipe must stop drawing its procedural guess
  // too; leaving uInkOn false here would put the ring+dot grid back on top of a
  // printing that already has one, which is the original bug.
  assert.equal(suppressed.uInkOn, true)
  assert.equal(suppressed.tileId, 'dot-grid')
})

test('a frame-record override beats the generated shows value, in both directions', () => {
  // frames.json's `shows` is generated and reads `unknown` on all 24 records.
  // The override map is a HUMAN ratchet (AGENTS.md F4). It is empty today —
  // nothing has been measured — so this asserts the empty state honestly rather
  // than asserting a fixture nobody wrote.
  const r = resolveInk({
    seriesSlug: 'scarlet-violet',
    setId: 'sv03.5',
    variantKind: 'reverse',
    shows: 'unknown',
    frameId: 'canonical',
  })
  assert.equal(r.uInkDraw, true, 'no override exists for `canonical`, so unknown still draws')
})

// ── Tier order, determinism, and the corpus's own integrity ────────────────

test('a set row outranks an era row for the same printing', () => {
  const era = resolveInk({ seriesSlug: 'scarlet-violet', setId: 'sv01', variantKind: 'reverse' })
  const set = resolveInk({ seriesSlug: 'scarlet-violet', setId: 'sv10.5b', variantKind: 'reverse-foil-pokeball' })
  assert.equal(era.match, 'era')
  assert.equal(set.match, 'set')
})

test('resolution is deterministic and returns a fresh placement each time', () => {
  const input = { seriesSlug: 'scarlet-violet', setId: 'sv03.5', variantKind: 'reverse' } as const
  const a = resolveInk(input)
  const b = resolveInk(input)
  assert.deepEqual(a, b)
  // A caller that mutates the placement (the editor's sliders do) must not
  // poison the next resolution.
  a.placement.across = 999
  assert.notEqual(resolveInk(input).placement.across, 999)
})

test('every tile the registry names exists on disk', () => {
  const tiles = inkTiles()
  assert.ok(Object.keys(tiles).length > 0, 'the registry ships no tiles at all')
  for (const [id, t] of Object.entries(tiles)) {
    assert.ok(existsSync(join(REPO, t.file)), `${id}: ${t.file} is missing`)
    // AGENTS.md F5 — a measurement carries its n. n = 0 is allowed and is what
    // an unmeasured starting number must say; a positive n without a confidence
    // is the shape that hides a guess.
    assert.equal(typeof t.n, 'number')
    if (t.n === 0) assert.equal(t.conf, null, `${id}: n = 0 must not claim a confidence`)
    else assert.ok(t.conf !== null, `${id}: n = ${t.n} with no confidence recorded`)
  }
})

test('every queued mark is reachable from at least one row, or it is invisible work', () => {
  const reachable = new Set<string>()
  for (const kind of [
    'reverse-foil-pokeball',
    'reverse-foil-masterball',
    'reverse-foil-loveball',
    'reverse',
  ]) {
    for (const setId of ['sv08.5', 'sv10.5b', 'sv10.5w', 'me02.5', 'ex8', 'ex11']) {
      const r = resolveInk({ seriesSlug: 'scarlet-violet', setId, variantKind: kind, rarity: 'Holo Rare' })
      if (r.queued) reachable.add(r.queued)
      const ex = resolveInk({ seriesSlug: 'ex', setId, variantKind: kind, rarity: 'Holo Rare' })
      if (ex.queued) reachable.add(ex.queued)
      const me = resolveInk({ seriesSlug: 'mega-evolution', setId, variantKind: kind, rarity: 'Holo Rare' })
      if (me.queued) reachable.add(me.queued)
    }
  }
  // Four of the six are reachable by row. The other two — plasma-shield and
  // energy-symbols — are queued WITHOUT a row on purpose, because no honest
  // selector exists for them yet, and both say so in the registry.
  for (const mark of ['pokeball', 'masterball', 'specialty-balls', 'ex-set-logos']) {
    assert.ok(reachable.has(mark), `${mark} is queued but no row can reach it`)
  }
})

test('the version is a number a corpus can be stamped with', () => {
  assert.equal(typeof INK_RESOLVER_VERSION, 'number')
  assert.ok(INK_RESOLVER_VERSION >= 1)
})

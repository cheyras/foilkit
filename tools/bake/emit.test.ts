// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake/emit.test.ts — the rules docs/HOSTED-EDITOR.md §1 and §2 state
// in prose, stated again as assertions.
//
// The three worth naming, because each of them is a silent-wrong-answer bug
// rather than a crash:
//
//  * The search round-trip. §2 omits `number` when the reader can recover it
//    from the cardId. Get that condition backwards and search shows the wrong
//    card number for a set with dashed ids, forever, with no error anywhere.
//  * The paging boundary. A set of exactly PAGE_SIZE must be ONE page. Off by
//    one and every 250-card set silently loses its last card or grows an
//    empty second shard.
//  * §6. A user-scoped field in a public CDN file is not a bug you fix in the
//    next deploy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PAGE_SIZE,
  bucketFor,
  emitCatalog,
  numberFromCardId,
  setIdFromCardId,
  variantDisplayName,
  variantTier,
  type BakeCard,
  type BakeSeries,
  type CatalogModel,
} from './emit.ts'
import { assertNoUserScopedFields } from './guards.ts'

// ── helpers ────────────────────────────────────────────────────────────────

let vid = 1
function card(setId: string, number: string, name: string): BakeCard {
  return {
    cardId: `${setId}-${number}`,
    number,
    name,
    rarity: 'Fixture Common',
    images: { low: 'https://fixture.invalid/low.webp', high: 'https://fixture.invalid/high.webp' },
    variants: [{ variantId: vid++, kind: 'normal', displayName: 'Normal', tier: 'standard' }],
  }
}

function model(series: BakeSeries[]): CatalogModel {
  return { generatedAt: '2026-09-01T00:00:00.000Z', source: 'fixture:test', resolverVersion: 5, series }
}

function oneSet(setId: string, cards: BakeCard[]): BakeSeries[] {
  return [
    {
      slug: 'fixture-series',
      name: 'Fixture Series',
      tcgdexId: 'fx',
      sets: [{ setId, name: 'Fixture Set', releasedOn: '2026-01-01', cardCountTotal: cards.length, cards }],
    },
  ]
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'foilkit-emit-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── §2 the search-row round-trip ───────────────────────────────────────────

test('search rows: setId and number are recovered by splitting on the LAST dash', () => {
  assert.equal(setIdFromCardId('sv01-26'), 'sv01')
  assert.equal(numberFromCardId('sv01-26'), '26')
  // A '.' in the set id is legal (§1) and does not disturb the split.
  assert.equal(setIdFromCardId('sv03.5-1'), 'sv03.5')
  assert.equal(numberFromCardId('sv03.5-1'), '1')
  // No dash at all: nothing to recover, and the caller must not pretend.
  assert.equal(setIdFromCardId('promo'), null)
  assert.equal(numberFromCardId('promo'), null)
  // A trailing dash yields no number rather than an empty string.
  assert.equal(numberFromCardId('sv01-'), null)
})

test('search rows: a number that round-trips is omitted, one that does not is emitted', () => {
  withTmpDir((dir) => {
    const cards = [
      card('sv03.5', '1', 'Alpha Fixture'), // 'sv03.5-1' → '1' ✓ omit
      card('sv01', '26', 'Beta Fixture'), // 'sv01-26'  → '26' ✓ omit
    ]
    // A synthetic id whose NUMBER itself contains a dash: cardId 'fxp-FX-007'
    // splits to setId 'fxp-FX' and number '007', so the real number 'FX-007'
    // has to be carried explicitly or search shows '007'.
    const dashed: BakeCard = { ...card('fxp', 'FX-007', 'Gamma Fixture'), cardId: 'fxp-FX-007', number: 'FX-007' }
    cards.push(dashed)

    emitCatalog(model(oneSet('sv01', cards)), { outDir: dir })
    const rows: Record<string, string[]> = {}
    for (const b of ['a', 'b', 'g']) {
      const f = JSON.parse(readFileSync(join(dir, 'search', 'b', `${b}.json`), 'utf8')) as {
        rows: string[][]
      }
      for (const r of f.rows) rows[r[0]!] = r
    }
    assert.deepEqual(rows['sv03.5-1'], ['sv03.5-1', 'Alpha Fixture'], 'round-trips → two-element row')
    assert.deepEqual(rows['sv01-26'], ['sv01-26', 'Beta Fixture'], 'round-trips → two-element row')
    assert.deepEqual(
      rows['fxp-FX-007'],
      ['fxp-FX-007', 'Gamma Fixture', 'FX-007'],
      'does not round-trip → explicit number',
    )
  })
})

test('search rows: a setId that does not round-trip is counted and exampled, not silently dropped', () => {
  withTmpDir((dir) => {
    const dashed: BakeCard = { ...card('fxp', '1', 'Delta Fixture'), cardId: 'fxp-FX-007', number: 'FX-007' }
    const report = emitCatalog(model(oneSet('fxp', [card('fxp', '1', 'Alpha Fixture'), dashed])), { outDir: dir })
    assert.equal(report.counts.setIdMismatches, 1)
    assert.equal(report.counts.numberOverrides, 1)
    assert.match(report.setIdMismatchExamples[0]!, /^fxp-FX-007 \(set fxp\)$/)
    // The row still ships — a wrong-ish search hit beats a missing card.
    const f = JSON.parse(readFileSync(join(dir, 'search', 'b', 'd.json'), 'utf8')) as { rows: string[][] }
    assert.equal(f.rows.length, 1)
  })
})

// ── §2 bucketing ───────────────────────────────────────────────────────────

test('bucketFor: digits share one bucket, symbols and non-decomposing scripts go to _', () => {
  assert.equal(bucketFor('Alpha Fixture'), 'a')
  assert.equal(bucketFor('alpha fixture'), 'a')
  assert.equal(bucketFor('9 Fixture'), '0', 'a leading digit files under 0')
  assert.equal(bucketFor('0 Fixture'), '0')
  assert.equal(bucketFor('≡ Fixture'), '_', 'a leading symbol files under _')
  assert.equal(bucketFor("'Fixture"), '_')
  // A non-ASCII LETTER that decomposes to an ASCII base takes that base's
  // bucket; one that does not decompose falls to _. Both are documented
  // choices in emit.ts, and this is where they are pinned.
  assert.equal(bucketFor('Épsilon Fixture'), 'e', 'É decomposes to E')
  assert.equal(bucketFor('Ωmega Fixture'), '_', 'Ω does not decompose to an ASCII letter')
  assert.equal(bucketFor('Якорь'), '_', 'Cyrillic does not decompose to an ASCII letter')
  assert.equal(bucketFor('  Zeta Fixture'), 'z', 'leading whitespace is trimmed first')
})

test('the bucket list is ordered a…z, then 0, then _', () => {
  withTmpDir((dir) => {
    const cards = [
      card('fx1', '1', 'Zeta Fixture'),
      card('fx1', '2', '9 Fixture'),
      card('fx1', '3', '≡ Fixture'),
      card('fx1', '4', 'Alpha Fixture'),
    ]
    emitCatalog(model(oneSet('fx1', cards)), { outDir: dir })
    const idx = JSON.parse(readFileSync(join(dir, 'search', 'index.json'), 'utf8')) as { buckets: string[] }
    assert.deepEqual(idx.buckets, ['a', 'z', '0', '_'])
  })
})

test('search/index.json reports its own measured size, and the number is true', () => {
  withTmpDir((dir) => {
    const report = emitCatalog(model(oneSet('fx1', [card('fx1', '1', 'Alpha Fixture')])), { outDir: dir })
    const raw = readFileSync(join(dir, 'search', 'index.json'), 'utf8')
    const idx = JSON.parse(raw) as { bytes: { index: number; buckets: number } }
    assert.equal(idx.bytes.index, Buffer.byteLength(raw, 'utf8'), 'the self-reported size is the real file size')
    assert.equal(idx.bytes.index, report.bytes.searchIndex)
    assert.equal(idx.bytes.buckets, report.bytes.searchBuckets)
  })
})

// ── §1 paging ──────────────────────────────────────────────────────────────

test('paging: exactly PAGE_SIZE cards is ONE page', () => {
  withTmpDir((dir) => {
    const cards = Array.from({ length: PAGE_SIZE }, (_, i) => card('fx1', String(i + 1), `Alpha Fixture ${i}`))
    const report = emitCatalog(model(oneSet('fx1', cards)), { outDir: dir })
    assert.equal(report.counts.setPages, 1)
    const p1 = JSON.parse(readFileSync(join(dir, 'catalog', 'sets', 'fx1.json'), 'utf8')) as {
      page: number
      pageCount: number
      total: number
      pageSize: number
      cards: unknown[]
    }
    assert.equal(p1.pageCount, 1)
    assert.equal(p1.total, PAGE_SIZE)
    assert.equal(p1.pageSize, PAGE_SIZE)
    assert.equal(p1.cards.length, PAGE_SIZE)
    assert.equal(existsSync(join(dir, 'catalog', 'sets', 'fx1.p2.json')), false, 'no empty second page')
  })
})

test('paging: PAGE_SIZE + 1 cards is two pages, and the last card is on page 2', () => {
  withTmpDir((dir) => {
    const cards = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => card('fx1', String(i + 1), `Alpha Fixture ${i}`))
    const report = emitCatalog(model(oneSet('fx1', cards)), { outDir: dir })
    assert.equal(report.counts.setPages, 2)
    const read = (f: string) =>
      JSON.parse(readFileSync(join(dir, 'catalog', 'sets', f), 'utf8')) as {
        page: number
        pageCount: number
        total: number
        cards: { cardId: string }[]
      }
    const p1 = read('fx1.json')
    const p2 = read('fx1.p2.json')
    assert.equal(p1.pageCount, 2)
    assert.equal(p2.pageCount, 2)
    assert.equal(p1.page, 1)
    assert.equal(p2.page, 2)
    assert.equal(p1.cards.length, PAGE_SIZE)
    assert.equal(p2.cards.length, 1)
    assert.equal(p2.total, PAGE_SIZE + 1, 'total is the SET total, not the page total')
    assert.equal(p2.cards[0]!.cardId, `fx1-${PAGE_SIZE + 1}`)
    // No card is duplicated or lost across the split.
    const all = new Set([...p1.cards, ...p2.cards].map((c) => c.cardId))
    assert.equal(all.size, PAGE_SIZE + 1)
  })
})

test('a set id containing a path separator is rejected — a shard name is a path', () => {
  withTmpDir((dir) => {
    for (const bad of ['sv/01', 'sv\\01', '..']) {
      assert.throws(
        () => emitCatalog(model(oneSet(bad, [card('x', '1', 'Alpha Fixture')])), { outDir: dir }),
        /set id/,
        `'${bad}' must be rejected`,
      )
    }
    // A '.' inside the id is legal and must NOT be rejected (sv03.5).
    assert.doesNotThrow(() => emitCatalog(model(oneSet('sv03.5', [card('sv03.5', '1', 'Alpha Fixture')])), { outDir: dir }))
  })
})

test('--dry-run measures the same bytes it would have written, and writes nothing', () => {
  withTmpDir((dir) => {
    const cards = Array.from({ length: 12 }, (_, i) => card('fx1', String(i + 1), `Alpha Fixture ${i}`))
    const dry = emitCatalog(model(oneSet('fx1', cards)), { outDir: dir, dryRun: true })
    assert.equal(existsSync(join(dir, 'catalog')), false, 'dry run wrote a directory')
    const wet = emitCatalog(model(oneSet('fx1', cards)), { outDir: dir })
    assert.deepEqual(dry.bytes, wet.bytes)
    assert.deepEqual(dry.counts, wet.counts)
    assert.equal(dry.files, wet.files)
  })
})

// ── variant derivations (COLUMNS.derived) ──────────────────────────────────

test('variant display name and tier are derived from variant_kind_code', () => {
  assert.equal(variantDisplayName('normal'), 'Normal')
  assert.equal(variantDisplayName('reverse-holo'), 'Reverse Holo')
  assert.equal(variantDisplayName('holo-foil-cosmos'), 'Holo Foil Cosmos')
  assert.equal(variantTier('normal'), 'standard')
  // 'reverse-holo' contains both words; reverse is the distinguishing half.
  assert.equal(variantTier('reverse-holo'), 'reverse')
  assert.equal(variantTier('holo'), 'holo')
  assert.equal(variantTier('holo-foil-cosmos'), 'holo')
  assert.equal(variantTier('jumbo'), 'special')
})

// ── §6 ─────────────────────────────────────────────────────────────────────

test('assertNoUserScopedFields catches a planted key at depth', () => {
  const planted = {
    version: 1,
    series: [{ slug: 'x', sets: [{ setId: 'y', cards: [{ cardId: 'y-1', ownership: { owned: 2 } }] }] }],
  }
  assert.throws(
    () => assertNoUserScopedFields(planted, 'catalog/index.json'),
    (e: Error) => {
      assert.match(e.message, /catalog\/index\.json/)
      assert.match(e.message, /ownership/)
      assert.match(e.message, /series\[0\]\.sets\[0\]\.cards\[0\]\.ownership/, 'the path names where it is')
      return true
    },
  )
})

test('assertNoUserScopedFields catches every forbidden name, and no innocent one', () => {
  for (const k of [
    'owned',
    'ownedOnly',
    'ownership',
    'quantity',
    'totalQuantity',
    'progress',
    'userId',
    'user_id',
    'collection',
    'have',
    'OWNED',
    'Quantity',
  ]) {
    assert.throws(() => assertNoUserScopedFields({ a: { b: { [k]: 1 } } }, 'x'), new RegExp(k, 'i'), `${k} must throw`)
  }
  // Whole-key match, not a substring dragnet: these are catalog fields.
  assert.doesNotThrow(() =>
    assertNoUserScopedFields(
      { ownedByArtist: 1, quantityPrinted: 2, collectionNumber: 3, progressive: 4, haveNot: 5 },
      'x',
    ),
  )
})

test('assertNoUserScopedFields terminates on a cyclic model', () => {
  const a: Record<string, unknown> = { name: 'set' }
  a.self = a
  assert.doesNotThrow(() => assertNoUserScopedFields(a, 'x'))
})

test('every emitted artifact passes §6 — the emitter runs the guard itself', () => {
  withTmpDir((dir) => {
    const poisoned = oneSet('fx1', [card('fx1', '1', 'Alpha Fixture')])
    // A field nobody selected cannot leak; this proves the SECOND line of
    // defence by planting one on the model the emitter is handed.
    ;(poisoned[0]!.sets[0]!.cards[0] as unknown as Record<string, unknown>).quantity = 3
    assert.throws(() => emitCatalog(model(poisoned), { outDir: dir }), /quantity/)
  })
})

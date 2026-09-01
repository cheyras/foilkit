// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake/fixture-bake.test.ts — run tools/bake-fixture.mts for real, into
// a temp directory, and read back every file it claims to have written.
//
// This is the only test that exercises the CLI rather than the module, and it
// is spawned rather than imported on purpose: argv parsing, the default
// output path, the .mts entry point and the emitter all have to agree, and an
// imported function proves none of that. It is also the test that would catch
// docs/HOSTED-EDITOR.md and the code drifting apart, because it asserts the
// contract's field names, not the implementation's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Baked {
  dir: string
  index: {
    version: number
    generatedAt: string
    source: string
    resolverVersion: number
    counts: { series: number; sets: number; cards: number; printings: number }
    series: { slug: string; name: string; tcgdexId: string | null; setCount: number; cardCount: number }[]
  }
  searchIndex: {
    version: number
    generatedAt: string
    source: string
    resolverVersion: number
    total: number
    buckets: string[]
    bytes: { index: number; buckets: number }
  }
}

function bake(): Baked {
  const dir = mkdtempSync(join(tmpdir(), 'foilkit-fixture-bake-'))
  execFileSync(process.execPath, ['--conditions', 'source', join(ROOT, 'tools', 'bake-fixture.mts'), '--out', dir], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  const read = <T>(...p: string[]): T => JSON.parse(readFileSync(join(dir, ...p), 'utf8')) as T
  return { dir, index: read('catalog', 'index.json'), searchIndex: read('search', 'index.json') }
}

let baked: Baked | null = null
const get = (): Baked => (baked ??= bake())

test.after(() => {
  if (baked) rmSync(baked.dir, { recursive: true, force: true })
})

test('fixture bake: catalog/index.json carries the staleness stamp §1 requires', () => {
  const { index } = get()
  assert.equal(index.version, 1)
  assert.match(index.generatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  // "A fixture never claims to be the real catalog" — the header says so, and
  // the editor badges it from exactly this field.
  assert.match(index.source, /^fixture:/)
  assert.equal(typeof index.resolverVersion, 'number')
  assert.ok(index.resolverVersion > 0)
  assert.equal(index.series.length, index.counts.series)
  // Three series: two entirely invented, plus the CORPUS-OVERLAP one. That
  // third series carries the real catalog ids the committed mask corpus covers
  // (invented names, real ids — an id is a coordinate, a name is a trademark),
  // and it exists so the editor's end-to-end run can open a card whose real
  // hand mask loads. Without it every fixture card resolves to scope 'none' and
  // there is nothing to draw.
  assert.equal(index.counts.series, 3, '2 invented series + the corpus-overlap one')
  assert.equal(index.counts.sets, 5, '4 invented sets + base1')
  const overlap = index.series.find((s) => s.slug === 'base')
  assert.ok(overlap, 'the corpus-overlap series is present')
  assert.equal(overlap.setCount, 1)
})

test('fixture bake: the counts in index.json agree with the shards they summarize', () => {
  const { dir, index } = get()
  let sets = 0
  let cards = 0
  let printings = 0
  for (const s of index.series) {
    const ser = JSON.parse(readFileSync(join(dir, 'catalog', 'series', `${s.slug}.json`), 'utf8')) as {
      seriesSlug: string
      sets: { setId: string; name: string; releasedOn: string | null; cardCountTotal: number | null }[]
    }
    assert.equal(ser.seriesSlug, s.slug)
    assert.equal(ser.sets.length, s.setCount, `${s.slug}: setCount matches the series shard`)
    sets += ser.sets.length
    let cardsInSeries = 0
    for (const st of ser.sets) {
      assert.ok(st.releasedOn === null || /^\d{4}-\d{2}-\d{2}$/.test(st.releasedOn), 'releasedOn is a plain date')
      const p1 = JSON.parse(readFileSync(join(dir, 'catalog', 'sets', `${st.setId}.json`), 'utf8')) as {
        setId: string
        set: { setId: string; name: string; slug: string; seriesName: string; seriesTcgdexId: string | null }
        page: number
        pageCount: number
        total: number
        pageSize: number
        cards: { cardId: string; number: string; name: string; variants: unknown[] }[]
      }
      assert.equal(p1.setId, st.setId)
      assert.equal(p1.set.slug, s.slug, 'the set shard names its own series')
      assert.equal(p1.set.seriesName, s.name)
      assert.equal(p1.page, 1)
      assert.equal(p1.pageSize, 250)
      let seen = p1.cards.length
      for (const c of p1.cards) {
        printings += c.variants.length
        assert.ok(c.variants.length > 0, `${c.cardId} has at least one printing`)
      }
      for (let page = 2; page <= p1.pageCount; page++) {
        const pn = JSON.parse(readFileSync(join(dir, 'catalog', 'sets', `${st.setId}.p${page}.json`), 'utf8')) as {
          page: number
          pageCount: number
          total: number
          cards: { variants: unknown[] }[]
        }
        assert.equal(pn.page, page)
        assert.equal(pn.pageCount, p1.pageCount)
        assert.equal(pn.total, p1.total, 'every page reports the SET total')
        seen += pn.cards.length
        for (const c of pn.cards) printings += c.variants.length
      }
      assert.equal(seen, p1.total, `${st.setId}: the pages add up to the stated total`)
      cardsInSeries += seen
    }
    assert.equal(cardsInSeries, s.cardCount, `${s.slug}: cardCount matches the shards`)
    cards += cardsInSeries
  }
  assert.equal(sets, index.counts.sets)
  assert.equal(cards, index.counts.cards)
  assert.equal(printings, index.counts.printings)
  assert.ok(printings > cards, 'printings and cards are different numbers — the fixture proves the distinction')
})

test('fixture bake: the promo set pages, and the split is at 250', () => {
  const { dir } = get()
  const p1 = JSON.parse(readFileSync(join(dir, 'catalog', 'sets', 'fxsp.json'), 'utf8')) as {
    pageCount: number
    total: number
    cards: unknown[]
  }
  assert.equal(p1.total, 260)
  assert.equal(p1.pageCount, 2)
  assert.equal(p1.cards.length, 250)
  const p2 = JSON.parse(readFileSync(join(dir, 'catalog', 'sets', 'fxsp.p2.json'), 'utf8')) as { cards: unknown[] }
  assert.equal(p2.cards.length, 10)
  assert.equal(existsSync(join(dir, 'catalog', 'sets', 'fxsp.p3.json')), false)
})

test('fixture bake: a set id with a dot shards under its literal name', () => {
  const { dir } = get()
  assert.ok(existsSync(join(dir, 'catalog', 'sets', 'fxp2.5.json')), 'sv03.5-style ids are legal')
})

test('fixture bake: the search index covers every card exactly once', () => {
  const { dir, index, searchIndex } = get()
  assert.equal(searchIndex.version, 1)
  assert.equal(searchIndex.source, index.source, 'both artifacts come from one run')
  assert.equal(searchIndex.generatedAt, index.generatedAt)
  assert.equal(searchIndex.resolverVersion, index.resolverVersion)
  assert.equal(searchIndex.total, index.counts.cards)

  const seen = new Set<string>()
  let bucketBytes = 0
  for (const b of searchIndex.buckets) {
    const raw = readFileSync(join(dir, 'search', 'b', `${b}.json`), 'utf8')
    bucketBytes += Buffer.byteLength(raw, 'utf8')
    const f = JSON.parse(raw) as { bucket: string; rows: (string[] | undefined)[] }
    assert.equal(f.bucket, b)
    assert.ok(f.rows.length > 0, `bucket ${b} is not empty`)
    for (const row of f.rows) {
      assert.ok(row && (row.length === 2 || row.length === 3), 'a row is a two- or three-tuple')
      assert.equal(seen.has(row[0]!), false, `${row[0]} appears once`)
      seen.add(row[0]!)
    }
  }
  assert.equal(seen.size, searchIndex.total, 'every card has exactly one search row')
  assert.equal(searchIndex.bytes.buckets, bucketBytes, 'the reported bucket size is the real one')
  assert.equal(
    searchIndex.bytes.index,
    Buffer.byteLength(readFileSync(join(dir, 'search', 'index.json'), 'utf8'), 'utf8'),
  )
  // The fixture deliberately contains a digit-leading, a symbol-leading and
  // an accented name, so all three bucketing branches have live rows.
  assert.ok(searchIndex.buckets.includes('0'), 'the digit bucket exists')
  assert.ok(searchIndex.buckets.includes('_'), 'the fallback bucket exists')
  assert.ok(searchIndex.buckets.includes('e'), 'É filed under e')
})

test('fixture bake: every search row round-trips, or carries its number', () => {
  const { dir, searchIndex } = get()
  // Rebuild the card → number map out of the SHARDS, then check the index
  // against it the way apps/editor/src/catalog/search.ts will.
  const numberOf = new Map<string, string>()
  for (const s of JSON.parse(readFileSync(join(dir, 'catalog', 'index.json'), 'utf8')).series as { slug: string }[]) {
    const ser = JSON.parse(readFileSync(join(dir, 'catalog', 'series', `${s.slug}.json`), 'utf8')) as {
      sets: { setId: string }[]
    }
    for (const st of ser.sets) {
      const p1 = JSON.parse(readFileSync(join(dir, 'catalog', 'sets', `${st.setId}.json`), 'utf8')) as {
        pageCount: number
        cards: { cardId: string; number: string }[]
      }
      const pages = [p1]
      for (let p = 2; p <= p1.pageCount; p++) {
        pages.push(JSON.parse(readFileSync(join(dir, 'catalog', 'sets', `${st.setId}.p${p}.json`), 'utf8')))
      }
      for (const pg of pages) for (const c of pg.cards) numberOf.set(c.cardId, c.number)
    }
  }
  let explicit = 0
  for (const b of searchIndex.buckets) {
    const f = JSON.parse(readFileSync(join(dir, 'search', 'b', `${b}.json`), 'utf8')) as { rows: string[][] }
    for (const row of f.rows) {
      const cardId = row[0]!
      const derived = cardId.slice(cardId.lastIndexOf('-') + 1)
      const read = row.length === 3 ? row[2]! : derived
      assert.equal(read, numberOf.get(cardId), `${cardId}: the reader recovers the shard's number`)
      if (row.length === 3) explicit++
    }
  }
  assert.equal(explicit, 10, 'the fixture plants exactly ten dashed-number cards')
})

test('fixture bake: §4 artifacts ride along, stamped from the same run', () => {
  const { dir, index } = get()
  const pc = JSON.parse(readFileSync(join(dir, 'foil-pattern-cards.json'), 'utf8')) as {
    version: number
    generatedAt: string
    source: string
    resolverVersion: number
    variantsScanned: number
    variantsAssigned: number
    patterns: Record<string, unknown[]>
  }
  const vm = JSON.parse(readFileSync(join(dir, 'foil-verification-map.json'), 'utf8')) as {
    version: number
    generatedAt: string
    source: string
    resolverVersion: number
    countingUnits: Record<string, string>
    catalog: { variantsScanned: number; variantsAssigned: number; cardsAssigned: number; groups: number }
    groups: { key: string; printings: number; leverage: number }[]
  }
  assert.equal(pc.version, 3, '§4: pattern cards are version 3')
  assert.equal(vm.version, 1, '§4: the verification map is version 1')
  for (const a of [pc, vm]) {
    assert.equal(a.generatedAt, index.generatedAt, 'one run, one timestamp')
    assert.equal(a.source, index.source)
    assert.equal(a.resolverVersion, index.resolverVersion)
  }
  assert.equal(pc.variantsScanned, index.counts.printings, 'the inversion walked the same printings')
  assert.equal(vm.catalog.variantsScanned, index.counts.printings)
  assert.equal(vm.catalog.variantsAssigned, pc.variantsAssigned)
  assert.equal(vm.catalog.groups, vm.groups.length)
  // COUNTING_UNITS is load-bearing documentation, not decoration — it must
  // arrive in the file the editor reads.
  assert.ok(vm.countingUnits.patternAssignment.includes('(cardId, variantId)'))
  // leverage is sorted descending; the queue IS this order.
  for (let i = 1; i < vm.groups.length; i++) {
    assert.ok(vm.groups[i - 1]!.leverage >= vm.groups[i]!.leverage, 'groups are sorted by leverage desc')
  }
})

test('fixture bake: no artifact ships a real CDN URL or a real card name', () => {
  const { dir, index } = get()
  for (const s of index.series) {
    const ser = JSON.parse(readFileSync(join(dir, 'catalog', 'series', `${s.slug}.json`), 'utf8')) as {
      sets: { setId: string }[]
    }
    for (const st of ser.sets) {
      const raw = readFileSync(join(dir, 'catalog', 'sets', `${st.setId}.json`), 'utf8')
      // F2: a fixture is the easiest place to vendor somebody else's assets.
      assert.equal(raw.includes('tcgdex'), false, 'no upstream CDN host in a fixture')
      assert.equal(raw.includes('pokemon'), false)
      const p = JSON.parse(raw) as { cards: { images: { low: string; high: string } }[] }
      for (const c of p.cards) {
        assert.match(c.images.low, /^https:\/\/fixture\.invalid\//)
        assert.match(c.images.high, /^https:\/\/fixture\.invalid\//)
      }
    }
  }
})

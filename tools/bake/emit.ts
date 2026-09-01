// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake/emit.ts — the ONE writer for docs/HOSTED-EDITOR.md §1 and §2.
//
// tools/bake-catalog.mts (needs Postgres) and tools/bake-fixture.mts (needs
// nothing) both call this. That is the entire point of the module existing: a
// fixture with its own emitter would let the editor be developed and tested
// against a shape the real bake never produces, and the first time anybody
// noticed would be after a deploy. One emitter means the fixture is a
// different INPUT, never a different OUTPUT FORMAT.
//
// Everything here is in-memory and synchronous apart from the final writes,
// and `dryRun` skips even those — the byte report is produced by serializing
// the artifacts either way, so `--dry-run` measures the same bytes the real
// run would write rather than estimating them.

import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoUserScopedFields } from './guards.ts'

/** docs/HOSTED-EDITOR.md §1: "the api's old maximum". */
export const PAGE_SIZE = 250

// ── The in-memory catalog model ────────────────────────────────────────────
// Deliberately a tree, not the flat rows the query returns: the artifacts are
// a tree, so assembling it once in the caller and walking it once here keeps
// the "which set does this card belong to" question answered in exactly one
// place. `variantCount` is absent by design — §1 says the editor derives it
// from `variants.length` rather than the bake repeating itself.

export interface BakeVariant {
  /** The card_variant id. §1's one sanctioned internal id: the mask corpus is keyed by it. */
  variantId: number
  kind: string
  displayName: string
  tier: string
}

/**
 * A variant's human label, DERIVED from `variant_kind_code` rather than
 * selected. See tools/bake-catalog.mts's COLUMNS block: a derivation we own
 * cannot fail on a schema guess, and `variant_kind_code` is the one variant
 * column 3a already proved exists. `reverse-holo` → "Reverse Holo".
 */
export function variantDisplayName(kind: string): string {
  const words = kind.split(/[-_\s]+/).filter(Boolean)
  if (words.length === 0) return kind
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * The coarse bucket a variant sits in, likewise derived. Four values, in the
 * order they are tested — a code is reverse before it is holo, because
 * `reverse-holo` contains both and the reverse is the distinguishing half.
 */
export function variantTier(kind: string): 'standard' | 'reverse' | 'holo' | 'special' {
  const k = kind.toLowerCase()
  if (k === 'normal' || k === 'standard') return 'standard'
  if (k.includes('reverse')) return 'reverse'
  if (k.includes('holo') || k.includes('foil')) return 'holo'
  return 'special'
}

export interface BakeCard {
  cardId: string
  number: string
  name: string
  rarity: string | null
  /** Absolute upstream URLs. The editor rewrites them through /api/image at view time (§5). */
  images: { low: string; high: string }
  variants: BakeVariant[]
}

export interface BakeSet {
  setId: string
  name: string
  /** 'YYYY-MM-DD' or null — never a Date, so the JSON has no timezone in it. */
  releasedOn: string | null
  cardCountTotal: number | null
  cards: BakeCard[]
}

export interface BakeSeries {
  slug: string
  name: string
  tcgdexId: string | null
  sets: BakeSet[]
}

export interface CatalogModel {
  generatedAt: string
  /** 'catalog' or 'fixture:<name>'. A fixture never claims to be the real catalog. */
  source: string
  resolverVersion: number
  series: BakeSeries[]
}

// ── Search rows (§2) ───────────────────────────────────────────────────────

/**
 * setId from a cardId: everything before the LAST `-`. Same split
 * `@foilkit/forge`'s setIdOf uses and the same one
 * apps/editor/src/catalog/search.ts owns on the read side. Duplicated rather
 * than imported so this module keeps its "node: builtins only" property and
 * so the bake's assertion is against the literal rule the contract states.
 */
export function setIdFromCardId(cardId: string): string | null {
  const i = cardId.lastIndexOf('-')
  return i > 0 ? cardId.slice(0, i) : null
}

/** number from a cardId: everything after the LAST `-`. */
export function numberFromCardId(cardId: string): string | null {
  const i = cardId.lastIndexOf('-')
  return i > 0 && i < cardId.length - 1 ? cardId.slice(i + 1) : null
}

/**
 * The bucket a name is filed under — the normalized first letter.
 *
 * Decision, because §2 leaves it to the bake: the name is NFD-decomposed and
 * its combining marks stripped before the first character is taken, so
 * "Éclair" files under `e` and a search for "ec" finds it. A name whose first
 * character is a digit files under `0` (one bucket for all ten, not ten
 * near-empty files). Everything else — punctuation, a leading quote, and any
 * script that does NOT decompose to an ASCII letter (Cyrillic, Greek, kana,
 * CJK) — files under `_`.
 *
 * `_` is therefore a real bucket with real contents, not an error case. The
 * editor loads it for any keystroke that is not [a-z0-9], which is the honest
 * behaviour: we cannot bucket a script by a first letter we do not index.
 */
export function bucketFor(name: string): string {
  const first = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks, so É → E
    .trim()
    .charAt(0)
    .toLowerCase()
  if (first >= 'a' && first <= 'z') return first
  if (first >= '0' && first <= '9') return '0'
  return '_'
}

/** Buckets in the order §2's example lists them: a…z, then 0, then _. */
const BUCKET_ORDER = (b: string): number => (b === '_' ? 2 : b === '0' ? 1 : 0)

/** `[cardId, name]`, or `[cardId, name, number]` when the number does not round-trip. */
export type SearchRow = [string, string] | [string, string, string]

export interface EmitOptions {
  /** Where `catalog/` and `search/` are written. */
  outDir: string
  /** Build and measure everything, write nothing. */
  dryRun?: boolean
}

export interface BucketReport {
  bucket: string
  rows: number
  bytes: number
  gzip: number
}

export interface EmitReport {
  files: number
  bytes: {
    catalogIndex: number
    catalogSeries: number
    catalogSets: number
    catalog: number
    searchIndex: number
    searchBuckets: number
    search: number
    searchGzip: number
    total: number
  }
  counts: {
    series: number
    sets: number
    cards: number
    printings: number
    setPages: number
    buckets: number
    /** Rows that had to carry an explicit `number` because it did not round-trip. */
    numberOverrides: number
    /** Rows whose setId does NOT round-trip out of the cardId — see below. */
    setIdMismatches: number
  }
  buckets: BucketReport[]
  largestBucket: BucketReport | null
  /** cardIds whose setId does not round-trip, capped — for the printed report. */
  setIdMismatchExamples: string[]
}

const enc = new TextEncoder()
const bytesOf = (s: string): number => enc.encode(s).length

/**
 * Write §1's catalog shards and §2's search index. Returns the measured
 * report; nothing here is estimated.
 */
export function emitCatalog(model: CatalogModel, opts: EmitOptions): EmitReport {
  const { outDir, dryRun = false } = opts
  const stamp = {
    generatedAt: model.generatedAt,
    source: model.source,
    resolverVersion: model.resolverVersion,
  }

  const written: { path: string; body: string }[] = []
  const write = (relPath: string, obj: unknown, where: string): number => {
    // §6 runs BEFORE serialization, on every object, in the one place every
    // artifact passes through. A guard the emitter skips for one file is a
    // guard that does not exist.
    assertNoUserScopedFields(obj, where)
    const body = JSON.stringify(obj) + '\n'
    written.push({ path: relPath, body })
    return bytesOf(body)
  }

  // ── Counts first: index.json states them, so they must be known up front ──
  let cards = 0
  let printings = 0
  let sets = 0
  for (const ser of model.series) {
    sets += ser.sets.length
    for (const s of ser.sets) {
      cards += s.cards.length
      for (const c of s.cards) printings += c.variants.length
    }
  }

  // ── §1 catalog/index.json ────────────────────────────────────────────────
  const catalogIndex = {
    version: 1,
    ...stamp,
    counts: { series: model.series.length, sets, cards, printings },
    series: model.series.map((ser) => ({
      slug: ser.slug,
      name: ser.name,
      tcgdexId: ser.tcgdexId,
      setCount: ser.sets.length,
      cardCount: ser.sets.reduce((n, s) => n + s.cards.length, 0),
    })),
  }
  const catalogIndexBytes = write(join('catalog', 'index.json'), catalogIndex, 'catalog/index.json')

  // ── §1 catalog/series/<slug>.json ────────────────────────────────────────
  let catalogSeriesBytes = 0
  for (const ser of model.series) {
    if (/[/\\]/.test(ser.slug)) {
      throw new Error(`bake: series slug '${ser.slug}' contains a path separator — a shard name is a path.`)
    }
    catalogSeriesBytes += write(
      join('catalog', 'series', `${ser.slug}.json`),
      {
        version: 1,
        // EVERY ARTIFACT CARRIES THE STAMP, not only the two index files.
        //
        // A shard that does not say when it was baked, from what, or against
        // which resolver cannot be distinguished from a shard out of a
        // different bake — and "they shipped together, check index.json" is an
        // answer that is wrong exactly when it matters, which is when a partial
        // deploy or a hand-copied file is what you are chasing. ~70 bytes per
        // shard against a catalog whose set pages run 15 KB each.
        //
        // The COMMITTED shards under data/catalog/ predate this and are not
        // rewritten by adding it here: they restamp on the next bake, which is
        // the only thing that can honestly stamp them.
        ...stamp,
        seriesSlug: ser.slug,
        sets: ser.sets.map((s) => ({
          setId: s.setId,
          name: s.name,
          releasedOn: s.releasedOn,
          cardCountTotal: s.cardCountTotal,
        })),
      },
      `catalog/series/${ser.slug}.json`,
    )
  }

  // ── §1 catalog/sets/<setId>.json (+ .p<N>.json) ──────────────────────────
  let catalogSetsBytes = 0
  let setPages = 0
  const seenSetId = new Set<string>()
  for (const ser of model.series) {
    for (const s of ser.sets) {
      // §1: "a shard name is a path". `.` is legal (sv03.5); `/` and `\` are
      // not, and this is where that is enforced rather than trusted.
      if (/[/\\]/.test(s.setId)) {
        throw new Error(
          `bake: set id '${s.setId}' contains a path separator — a shard name is a path, and this one would ` +
            `escape data/catalog/sets/. Fix the catalog, not this check.`,
        )
      }
      if (s.setId === '' || s.setId === '.' || s.setId === '..') {
        throw new Error(`bake: set id '${s.setId}' is not a usable file name.`)
      }
      if (seenSetId.has(s.setId)) {
        throw new Error(`bake: duplicate set id '${s.setId}' — two sets would write the same shard.`)
      }
      seenSetId.add(s.setId)

      const total = s.cards.length
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
      const header = {
        setId: s.setId,
        name: s.name,
        slug: ser.slug,
        seriesName: ser.name,
        seriesTcgdexId: ser.tcgdexId,
        releasedOn: s.releasedOn,
      }
      for (let page = 1; page <= pageCount; page++) {
        const file = page === 1 ? `${s.setId}.json` : `${s.setId}.p${page}.json`
        catalogSetsBytes += write(
          join('catalog', 'sets', file),
          {
            version: 1,
            // Same stamp, same reason — and this is the shard the editor's CARD
            // DETAIL comes out of, so it is the one a stale-deploy question is
            // usually actually about.
            ...stamp,
            setId: s.setId,
            set: header,
            page,
            pageCount,
            total,
            pageSize: PAGE_SIZE,
            cards: s.cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
          },
          `catalog/sets/${file}`,
        )
        setPages++
      }
    }
  }

  // ── §2 search ────────────────────────────────────────────────────────────
  const byBucket = new Map<string, SearchRow[]>()
  let numberOverrides = 0
  let setIdMismatches = 0
  const setIdMismatchExamples: string[] = []
  for (const ser of model.series) {
    for (const s of ser.sets) {
      for (const c of s.cards) {
        // §2: the reader recovers setId and number from the cardId. The bake
        // asserts that round-trip for every row it writes.
        if (setIdFromCardId(c.cardId) !== s.setId) {
          // NOT fatal, and that is a decision. The row format §2 fixes is a
          // two- or three-tuple with no setId slot, so there is nothing to
          // emit as a correction; failing the whole bake over one malformed
          // promo id would trade a slightly-wrong search result for no site.
          // It is counted, exampled and printed loudly instead, so it is a
          // finding somebody acts on rather than a silence.
          setIdMismatches++
          if (setIdMismatchExamples.length < 10) setIdMismatchExamples.push(`${c.cardId} (set ${s.setId})`)
        }
        const bucket = bucketFor(c.name)
        const row: SearchRow =
          numberFromCardId(c.cardId) === c.number ? [c.cardId, c.name] : [c.cardId, c.name, c.number]
        if (row.length === 3) numberOverrides++
        const list = byBucket.get(bucket)
        if (list) list.push(row)
        else byBucket.set(bucket, [row])
      }
    }
  }

  const bucketNames = [...byBucket.keys()].sort(
    (a, b) => BUCKET_ORDER(a) - BUCKET_ORDER(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
  const buckets: BucketReport[] = []
  let searchBucketsBytes = 0
  let searchBucketsGzip = 0
  for (const bucket of bucketNames) {
    const rows = byBucket.get(bucket)!
    const b = write(join('search', 'b', `${bucket}.json`), { bucket, rows }, `search/b/${bucket}.json`)
    const body = written[written.length - 1]!.body
    const gzip = gzipSync(Buffer.from(body, 'utf8')).length
    searchBucketsBytes += b
    searchBucketsGzip += gzip
    buckets.push({ bucket, rows: rows.length, bytes: b, gzip })
  }

  // search/index.json states its OWN size, which is self-referential: writing
  // the measured number changes the number. Iterate to a fixed point (three
  // passes at most — the field only grows by digits) rather than shipping an
  // "index" byte count that is a lie by a handful of characters.
  const searchIndexObj = (indexBytes: number): Record<string, unknown> => ({
    version: 1,
    ...stamp,
    total: cards,
    buckets: bucketNames,
    bytes: { index: indexBytes, buckets: searchBucketsBytes },
  })
  let searchIndexBytes = 0
  for (let i = 0; i < 5; i++) {
    const next = bytesOf(JSON.stringify(searchIndexObj(searchIndexBytes)) + '\n')
    if (next === searchIndexBytes) break
    searchIndexBytes = next
  }
  const finalIndex = searchIndexObj(searchIndexBytes)
  write(join('search', 'index.json'), finalIndex, 'search/index.json')
  const searchIndexGzip = gzipSync(Buffer.from(written[written.length - 1]!.body, 'utf8')).length

  if (!dryRun) {
    for (const f of written) {
      const abs = join(outDir, f.path)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, f.body, 'utf8')
    }
  }

  const largestBucket = buckets.reduce<BucketReport | null>((best, b) => (!best || b.bytes > best.bytes ? b : best), null)
  const catalogBytes = catalogIndexBytes + catalogSeriesBytes + catalogSetsBytes
  const searchBytes = searchIndexBytes + searchBucketsBytes

  return {
    files: written.length,
    bytes: {
      catalogIndex: catalogIndexBytes,
      catalogSeries: catalogSeriesBytes,
      catalogSets: catalogSetsBytes,
      catalog: catalogBytes,
      searchIndex: searchIndexBytes,
      searchBuckets: searchBucketsBytes,
      search: searchBytes,
      searchGzip: searchIndexGzip + searchBucketsGzip,
      total: catalogBytes + searchBytes,
    },
    counts: {
      series: model.series.length,
      sets,
      cards,
      printings,
      setPages,
      buckets: bucketNames.length,
      numberOverrides,
      setIdMismatches,
    },
    buckets,
    largestBucket,
    setIdMismatchExamples,
  }
}

/** The size block §2 asks the bake to print so the partitioning can be revisited against a number. */
export function formatSizeReport(report: EmitReport): string {
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`
  const lines: string[] = []
  lines.push('── search index size (measured, not estimated) ──────────────────────')
  lines.push(`  index.json          ${kb(report.bytes.searchIndex).padStart(10)}`)
  lines.push(
    `  ${String(report.counts.buckets).padStart(2)} bucket file(s)   ${kb(report.bytes.searchBuckets).padStart(10)}`,
  )
  lines.push(
    `  TOTAL               ${kb(report.bytes.search).padStart(10)} raw / ${kb(report.bytes.searchGzip)} gzipped`,
  )
  if (report.largestBucket) {
    const b = report.largestBucket
    lines.push(`  largest bucket      '${b.bucket}' — ${b.rows} row(s), ${kb(b.bytes)} raw / ${kb(b.gzip)} gzipped`)
  }
  lines.push('  per bucket:')
  for (const b of report.buckets) {
    lines.push(
      `    ${b.bucket.padEnd(2)} ${String(b.rows).padStart(6)} row(s)  ${kb(b.bytes).padStart(10)} raw  ` +
        `${kb(b.gzip).padStart(10)} gzipped`,
    )
  }
  lines.push('── catalog shards ───────────────────────────────────────────────────')
  lines.push(`  index.json          ${kb(report.bytes.catalogIndex).padStart(10)}`)
  lines.push(`  series/             ${kb(report.bytes.catalogSeries).padStart(10)}`)
  lines.push(
    `  sets/  ${String(report.counts.setPages).padStart(4)} page(s) ${kb(report.bytes.catalogSets).padStart(10)}`,
  )
  lines.push(`  files written       ${String(report.files).padStart(10)}`)
  lines.push(`  ALL ARTIFACTS       ${kb(report.bytes.total).padStart(10)} raw`)
  return lines.join('\n')
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake-catalog.mts — THE BAKE. docs/HOSTED-EDITOR.md's first producer.
//
// foilkit.deckpal.app has no database at runtime. Every question the read path
// asks — which series, which sets, which cards, which printings, which foil —
// is answered by a FILE. This script is where those files come from, and it is
// the only place in the repository that needs a catalog.
//
// It is run BY HAND, by the maintainer, who has the database. See RUN-BAKE.md
// for the copy-pasteable sequence. It is not part of `pnpm build`, on purpose:
// a build step that needs production credentials is a build step that fails on
// every machine that does not have them, including Vercel's.
//
//   node --conditions source tools/bake-catalog.mts --dry-run
//   node --conditions source tools/bake-catalog.mts
//   node --conditions source tools/bake-catalog.mts --out /tmp/bake
//
// Writes (all relative to --out, default <root>/data):
//   catalog/index.json, catalog/series/<slug>.json,
//   catalog/sets/<setId>.json (+ .p<N>.json)      §1
//   search/index.json, search/b/<bucket>.json      §2
//   foil-pattern-cards.json, foil-verification-map.json   §4
//
// ── The connection budget ─────────────────────────────────────────────────
// ONE connection for the whole job. Not one per artifact, not one per query —
// one. The three queries below and the resolver inversion all ride it, which
// is why tools/bake/pattern-cards.ts exists as a module: so §4's two artifacts
// come out of the rows THIS connection already fetched instead of a second
// script opening a second connection to fetch them again.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { RESOLVER_VERSION } from '@foilkit/resolver'
import {
  emitCatalog,
  formatSizeReport,
  numberFromCardId,
  variantDisplayName,
  variantTier,
  type BakeCard,
  type BakeSeries,
  type BakeSet,
  type BakeVariant,
  type CatalogModel,
} from './bake/emit.ts'
import { buildPatternCards, readEvidence, type CatalogRow } from './bake/pattern-cards.ts'
import { assertNoUserScopedFields } from './bake/guards.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const OUT = arg('--out') ?? join(ROOT, 'data')
const DRY_RUN = process.argv.includes('--dry-run')

// ══════════════════════════════════════════════════════════════════════════
// COLUMNS — THE FIRST THING TO CHECK WHEN THIS BAKE FAILS
// ══════════════════════════════════════════════════════════════════════════
//
// Every DeckPal column name this script touches is in this one block, and
// nothing below writes a column name in a query string by hand. If the bake
// dies with a Postgres "column ... does not exist", this is the file section
// to edit — one place, not eleven query strings.
//
// The block is split by HOW MUCH WE KNOW, because that is the honest state:
//
//  VERIFIED — these eleven appear in tools/build-pattern-cards.mts's query,
//    which has been run against the live DeckPal schema and returned rows.
//    They are not guesses.
//
//  PROBED — these were NOT verifiable when this script was written (the
//    author had no database access), so instead of guessing once and failing
//    at run time, the bake ASKS information_schema which of several candidate
//    names actually exists, over the same one connection, before it selects
//    anything. Each entry is a candidate list in preference order; the first
//    that exists wins, and a list that matches nothing yields NULL and a
//    loud line in the report rather than a crash. Add a name to a list here
//    if the schema calls it something this list does not know about.
//
//  DERIVED — deliberately NOT selected at all. A derivation we own cannot
//    fail on a schema guess, and these three are all recoverable from data we
//    already have. See the notes on each.
const COLUMNS = {
  verified: {
    seriesId: 'ser.id',
    seriesSlug: 'ser.slug',
    setPk: 'cs.id',
    cardPk: 'c.id',
    setId: 'cs.tcgdex_id',
    setName: 'cs.name',
    setSeriesId: 'cs.series_id',
    cardId: 'c.tcgdex_id',
    cardName: 'c.name',
    cardRarity: 'c.rarity',
    cardSetId: 'c.set_id',
    variantId: 'cv.id',
    variantCardId: 'cv.card_id',
    variantKind: 'cv.variant_kind_code',
  },
  probed: {
    /** series display name — 'Scarlet & Violet' beside slug 'scarlet-violet'. */
    seriesName: { table: 'series', candidates: ['name', 'title', 'display_name'] },
    /** series tcgdex id — 'sv'. §1's `tcgdexId`, and half of an image URL. */
    seriesTcgdexId: { table: 'series', candidates: ['tcgdex_id', 'tcgdex_serie_id', 'external_id', 'code'] },
    /** set release date. Cast ::date then to_char, so a text or a timestamptz column both land as 'YYYY-MM-DD'. */
    setReleasedOn: { table: 'card_set', candidates: ['release_date', 'released_at', 'released_on', 'release_at'] },
    /** the set's official printed size — NOT the number of rows we hold. */
    setCardCountTotal: {
      table: 'card_set',
      candidates: ['card_count_total', 'card_count_official', 'total_cards', 'card_count'],
    },
    /** upstream low-res image URL, if DeckPal stores one. */
    cardImageLow: {
      table: 'card',
      candidates: ['image_url_low', 'image_low', 'img_low', 'image_small', 'image_url'],
    },
    /** upstream high-res image URL. */
    cardImageHigh: { table: 'card', candidates: ['image_url_high', 'image_high', 'img_high', 'image_large'] },
  },
  derived: {
    /** CARD NUMBER — taken from the cardId suffix ('sv01-26' → '26'), never
     *  from a column. Two reasons, and the second is the load-bearing one:
     *  (a) `local_id` is a guess and this is not, and (b) §2's search rows
     *  recover the number by splitting the cardId on its last '-', so a
     *  number derived that same way round-trips BY CONSTRUCTION. Selecting a
     *  column here would introduce disagreements between the shard and the
     *  search index that only show up as a wrong search result. When a cardId
     *  carries no '-' at all the probed card-image tables cannot help either,
     *  and the number falls back to the whole cardId. */
    cardNumber: 'cardId.slice(cardId.lastIndexOf("-") + 1)',
    /** VARIANT DISPLAY NAME — Title-Cased from variant_kind_code. */
    variantDisplayName: 'variantDisplayName(variant_kind_code)',
    /** VARIANT TIER — bucketed from variant_kind_code. */
    variantTier: 'variantTier(variant_kind_code)',
  },
} as const

/** Upstream image URLs when DeckPal stores none — §5's own worked example is
 *  `/en/base/base1/4/high.webp`, i.e. series tcgdex id / set id / number. The
 *  editor rewrites these through /api/image anyway, so a URL that 404s
 *  degrades to a missing thumbnail, not a broken page. */
const TCGDEX_ASSETS = 'https://assets.tcgdex.net/en'

// ── .env, softly ──────────────────────────────────────────────────────────
// build-pattern-cards.mts treats a missing .env as fatal because it has no
// other way to be configured. This one does: a maintainer exporting PGHOST and
// friends in their shell, or a CI job with them in the environment, is a
// perfectly good configuration and should not be told to write a file it does
// not need. So .env is read when it exists, ignored when it does not, and the
// loud failure is moved to the only place it belongs — "I could not build a
// connection config at all", below.
let envFileNote = 'no .env (using the environment)'
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=("?)(.*)\2\s*$/.exec(line.trim())
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[3]!
  }
  envFileNote = 'loaded ./.env'
} catch {
  /* not an error: the PG* vars may already be exported */
}

// ── `pg` is resolved out of the catalog's project, not this one ───────────
// Carried across from tools/build-pattern-cards.mts, and the reason is the
// same: foilkit is a dataset with a renderer attached. It ships measurements
// OF printings, not a list of them, so it has no business depending on a
// Postgres driver. The driver is borrowed at RUN TIME from whichever project
// supplies the catalog, named by PG_HOST_PACKAGE (a path to that project's
// package.json). tools/bake-fixture.mts is what a contributor without a
// catalog runs, and it needs none of this.
const PG_HOST = process.env.PG_HOST_PACKAGE ?? join(ROOT, '..', 'deckpal', 'apps', 'api', 'package.json')
interface PgConfig {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  connectionString?: string
}
interface PgClientCtor {
  new (cfg: PgConfig): {
    connect(): Promise<void>
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
    end(): Promise<void>
  }
}

/**
 * PG* first, DATABASE_URL/connectionString second. Fails loudly and by name
 * when it can build neither — a bake that dies inside the driver with
 * "ECONNREFUSED ::1:5432" has told the maintainer nothing about which
 * variable was missing.
 */
function pgConfig(): { cfg: PgConfig; describe: string } {
  const url = process.env.DATABASE_URL ?? process.env.PG_CONNECTION_STRING ?? process.env.connectionString
  if (process.env.PGHOST || process.env.PGDATABASE) {
    return {
      cfg: {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
      },
      // Never the password, and never the URL — a bake log is a thing people paste.
      describe: `PGHOST=${process.env.PGHOST ?? '(unset)'} PGDATABASE=${process.env.PGDATABASE ?? '(unset)'} PGUSER=${process.env.PGUSER ?? '(unset)'}`,
    }
  }
  if (url) return { cfg: { connectionString: url }, describe: 'DATABASE_URL (value not printed)' }
  throw new Error(
    'bake-catalog: no database configuration.\n' +
      `  ${envFileNote}\n` +
      '  Set PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE, or DATABASE_URL,\n' +
      '  either in the environment or in <root>/.env. See RUN-BAKE.md.',
  )
}

// ── Row shapes ────────────────────────────────────────────────────────────
interface SetRow {
  series_slug: string
  series_name: string | null
  series_tcgdex_id: string | null
  set_id: string
  set_name: string
  released_on: string | null
  card_count_total: number | string | null
}
interface CardRow extends CatalogRow {
  image_low: string | null
  image_high: string | null
}
interface ColumnRow {
  table_name: string
  column_name: string
}

/** `<table>.<column>` for every column the four catalog tables actually have. */
type ColumnSet = Set<string>

/**
 * Resolve one PROBED entry against what the schema really has. Returns the
 * qualified column expression, or null when no candidate exists.
 */
function pick(cols: ColumnSet, alias: string, spec: { table: string; candidates: readonly string[] }): string | null {
  for (const c of spec.candidates) if (cols.has(`${spec.table}.${c}`)) return `${alias}.${c}`
  return null
}

async function main(): Promise<void> {
  // Local evidence first — exactly as 3a does it. A disk problem should
  // surface before, not during, the one connection the budget rule allows.
  const evidence = await readEvidence(ROOT)

  const { cfg, describe } = pgConfig()
  const Client: PgClientCtor = (createRequire(PG_HOST)('pg') as { Client: PgClientCtor }).Client
  console.log(`bake-catalog: ${envFileNote}; connecting — ${describe}`)
  console.log(`  pg resolved from ${PG_HOST}`)

  const client = new Client(cfg)
  await client.connect() // ── the ONE connection (budget rule) ──
  let setRows: SetRow[]
  let cardRows: CardRow[]
  const probeNotes: string[] = []
  try {
    // 1/3 — which optional columns exist. Cheap, and it turns six schema
    // GUESSES into six measured facts before a single row is fetched.
    const probe = await client.query<ColumnRow>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('series','card_set','card','card_variant')`,
    )
    const cols: ColumnSet = new Set(probe.rows.map((r) => `${r.table_name}.${r.column_name}`))
    const P = COLUMNS.probed
    const seriesName = pick(cols, 'ser', P.seriesName)
    const seriesTcgdexId = pick(cols, 'ser', P.seriesTcgdexId)
    const setReleasedOn = pick(cols, 'cs', P.setReleasedOn)
    const setCardCountTotal = pick(cols, 'cs', P.setCardCountTotal)
    const cardImageLow = pick(cols, 'c', P.cardImageLow)
    const cardImageHigh = pick(cols, 'c', P.cardImageHigh)
    for (const [name, got] of [
      ['seriesName', seriesName],
      ['seriesTcgdexId', seriesTcgdexId],
      ['setReleasedOn', setReleasedOn],
      ['setCardCountTotal', setCardCountTotal],
      ['cardImageLow', cardImageLow],
      ['cardImageHigh', cardImageHigh],
    ] as const) {
      probeNotes.push(
        got
          ? `  probed ${name.padEnd(18)} → ${got}`
          : `  probed ${name.padEnd(18)} → NOT FOUND (emitting null; add the real name to COLUMNS.probed)`,
      )
    }

    // 2/3 — series and sets. `::date` before to_char so a text column, a date
    // and a timestamptz all serialize as a plain 'YYYY-MM-DD' with no zone.
    const V = COLUMNS.verified
    setRows = (
      await client.query<SetRow>(
        `SELECT ${V.seriesSlug} AS series_slug,
                ${seriesName ?? 'NULL::text'} AS series_name,
                ${seriesTcgdexId ?? 'NULL::text'} AS series_tcgdex_id,
                ${V.setId} AS set_id,
                ${V.setName} AS set_name,
                ${setReleasedOn ? `to_char(${setReleasedOn}::date, 'YYYY-MM-DD')` : 'NULL::text'} AS released_on,
                ${setCardCountTotal ? `${setCardCountTotal}::int` : 'NULL::int'} AS card_count_total
           FROM card_set cs
           JOIN series ser ON ${V.seriesId} = ${V.setSeriesId}`,
      )
    ).rows

    // 3/3 — every printing. This is 3a's exact query with the two image
    // columns appended; the eight aliases it already had are the ones
    // tools/bake/pattern-cards.ts's CatalogRow is named for, so the SAME rows
    // feed the shards and the resolver inversion. One walk, one connection.
    cardRows = (
      await client.query<CardRow>(
        `SELECT ${V.cardId} AS card_id, ${V.cardName} AS card_name, ${V.cardRarity} AS rarity,
                ${V.setId} AS set_id, ${V.setName} AS set_name, ${V.seriesSlug} AS series_slug,
                ${V.variantId} AS variant_id, ${V.variantKind} AS kind,
                ${cardImageLow ?? 'NULL::text'} AS image_low,
                ${cardImageHigh ?? 'NULL::text'} AS image_high
           FROM card_variant cv
           JOIN card c ON ${V.cardPk} = ${V.variantCardId}
           JOIN card_set cs ON ${V.setPk} = ${V.cardSetId}
           JOIN series ser ON ${V.seriesId} = ${V.setSeriesId}`,
      )
    ).rows
  } finally {
    await client.end() // released before a single byte is written
  }
  console.log(probeNotes.join('\n'))
  console.log(`  ${setRows.length} set row(s), ${cardRows.length} printing row(s) over ONE connection`)

  // ── Assemble the model (§1's tree) ──────────────────────────────────────
  const seriesBySlug = new Map<string, BakeSeries>()
  const setById = new Map<string, BakeSet>()
  const tcgdexIdBySetId = new Map<string, string | null>()
  for (const r of setRows) {
    let ser = seriesBySlug.get(r.series_slug)
    if (!ser) {
      ser = { slug: r.series_slug, name: r.series_name ?? r.series_slug, tcgdexId: r.series_tcgdex_id, sets: [] }
      seriesBySlug.set(r.series_slug, ser)
    }
    const s: BakeSet = {
      setId: r.set_id,
      name: r.set_name,
      releasedOn: r.released_on,
      cardCountTotal: r.card_count_total === null ? null : Number(r.card_count_total),
      cards: [],
    }
    ser.sets.push(s)
    setById.set(r.set_id, s)
    tcgdexIdBySetId.set(r.set_id, r.series_tcgdex_id)
  }

  // Printings collapse into cards: one row per (card, variant) comes back, and
  // §1's shard carries one entry per CARD with its variants nested.
  const cardByKey = new Map<string, BakeCard>()
  let orphanRows = 0
  let derivedImages = 0
  for (const r of cardRows) {
    const set = setById.get(r.set_id)
    if (!set) {
      // A printing whose set the sets query did not return. Counted, not
      // silently dropped — it means the two queries disagree, which is a
      // finding about the catalog, not about this script.
      orphanRows++
      continue
    }
    const key = `${r.set_id} ${r.card_id}`
    let card = cardByKey.get(key)
    if (!card) {
      const number = numberFromCardId(r.card_id) ?? r.card_id
      const serieId = tcgdexIdBySetId.get(r.set_id)
      let low = r.image_low
      let high = r.image_high
      if ((!low || !high) && serieId) {
        low ??= `${TCGDEX_ASSETS}/${serieId}/${r.set_id}/${number}/low.webp`
        high ??= `${TCGDEX_ASSETS}/${serieId}/${r.set_id}/${number}/high.webp`
        derivedImages++
      }
      card = {
        cardId: r.card_id,
        number,
        name: r.card_name,
        rarity: r.rarity,
        images: { low: low ?? '', high: high ?? '' },
        variants: [],
      }
      cardByKey.set(key, card)
      set.cards.push(card)
    }
    const variant: BakeVariant = {
      variantId: Number(r.variant_id),
      kind: r.kind,
      displayName: variantDisplayName(r.kind),
      tier: variantTier(r.kind),
    }
    card.variants.push(variant)
  }

  const series = [...seriesBySlug.values()]
  const generatedAt = new Date().toISOString()
  const source = 'catalog'
  const model: CatalogModel = { generatedAt, source, resolverVersion: RESOLVER_VERSION, series }

  // ── Emit §1 + §2 through the shared emitter ─────────────────────────────
  const report = emitCatalog(model, { outDir: OUT, dryRun: DRY_RUN })

  // ── Emit §4 from the SAME rows ──────────────────────────────────────────
  const { patternCards, verificationMap } = buildPatternCards(cardRows, evidence, { source, generatedAt })
  assertNoUserScopedFields(patternCards, 'foil-pattern-cards.json')
  assertNoUserScopedFields(verificationMap, 'foil-verification-map.json')
  if (!DRY_RUN) {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'foil-pattern-cards.json'), JSON.stringify(patternCards) + '\n', 'utf8')
    writeFileSync(join(OUT, 'foil-verification-map.json'), JSON.stringify(verificationMap, null, 2) + '\n', 'utf8')
  }

  // ── The report ──────────────────────────────────────────────────────────
  const assigned = patternCards.variantsAssigned as number
  const groups = (verificationMap.groups as unknown[]).length
  console.log('')
  console.log(DRY_RUN ? `DRY RUN — nothing written. Would write into ${OUT}` : `wrote ${report.files + 2} file(s) → ${OUT}`)
  console.log(
    `  ${report.counts.series} series, ${report.counts.sets} sets, ${report.counts.cards} cards, ` +
      `${report.counts.printings} printings, ${report.counts.setPages} set page(s)`,
  )
  console.log(`  resolverVersion ${RESOLVER_VERSION}, generatedAt ${generatedAt}`)
  console.log(`  foil-pattern-cards.json — ${assigned}/${cardRows.length} printings assigned`)
  console.log(`  foil-verification-map.json — ${groups} rule group(s)`)
  if (derivedImages > 0) {
    console.log(`  ${derivedImages} card(s) had an image URL DERIVED from assets.tcgdex.net (no stored URL column)`)
  }
  if (orphanRows > 0) {
    console.log(`  WARNING: ${orphanRows} printing row(s) named a set the sets query did not return — dropped.`)
  }
  if (report.counts.setIdMismatches > 0) {
    console.log(
      `  WARNING: ${report.counts.setIdMismatches} search row(s) whose setId does not round-trip out of the cardId.\n` +
        `           §2's reader will derive the wrong setId for these. Examples: ` +
        report.setIdMismatchExamples.join(', '),
    )
  }
  console.log(formatSizeReport(report))
  console.log('')
  console.log(
    'If the search TOTAL above passes ~2 MB raw / ~600 KB gzipped, revisit the partitioning:\n' +
      'that is the point at which a single bucket stops being a cheap first keystroke.\n' +
      'Below that, §2’s a–z/0/_ split is doing its job and needs no change.',
  )
  if (!DRY_RUN) console.log('\nNext: commit the artifacts. Vercel builds from git — see RUN-BAKE.md.')
}

void main()

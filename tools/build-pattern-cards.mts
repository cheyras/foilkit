// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/build-pattern-cards.mts — invert the foil resolver over the
// whole catalog: pattern id → every (cardId, variantId) the v5 resolver
// actually assigns that pattern to. Powers the canon-lab CARD PREVIEW
// (Chey 2026-08-04: "preview any holo pattern on a randomized card that
// it's assigned to ... with a button to re-randomize"): the dev api samples
// random rows from the baked file (DeckPal's foil-lab route
// GET /pattern-cards/:patternId), so the client never ships the catalog.
//
// The resolver is CLIENT code (packages/resolver/src/resolver.ts) and the
// foil-lab router is deliberately DB-free, so the inversion is baked here —
// tsx imports the real resolver (no reimplementation, no drift beyond
// staleness) and ONE Postgres connection walks the variants.
//
// Run from repo root (loads ./.env itself):
//   node --conditions source tools/build-pattern-cards.mts
// Output: data/foil-pattern-cards.json — re-run after catalog syncs or
// resolver/assignment changes (the file records resolverVersion + counts).
//
// ── Holo 3a (2026-08-31): the VERIFICATION MAP rides the same walk ─────────
// The same one-connection catalog walk now also emits
// data/foil-verification-map.json: the corpus grouped by RULE — the unit a
// human decision actually improves — keyed (eraId, scope, patternId,
// guess.match), with how many printings each rule governs and how much human
// evidence sits under it. leverage = printings ÷ (exemplars + 1) ranks where
// an hour of attention moves the most pixels. Extending this script rather
// than writing a new one is deliberate: it already imports the REAL
// resolveFoil (so the map cannot drift from what the app renders), already
// honours the one-connection budget, and already records resolverVersion so a
// stale map is detectable.
//
// The evidence half is read from local disk BEFORE the connection opens —
// data/foil-masks through the sanctioned selectExemplars() path (never a
// directory glob: that is what keeps unreviewed `ai` masks out of the count)
// and data/foil-windows for window geometry.
//
//   --evidence-only   build and print the local evidence index, then exit.
//                     Touches no database and writes no files — the dry run
//                     for everything that does not need Postgres.
//   --fixture <path>  read the catalog rows from a JSON array instead of
//                     Postgres and write BOTH artifacts beside the fixture
//                     (<path>.pattern-cards.json, <path>.verification-map.json)
//                     stamped `source: fixture:<path>`. data/ is never written
//                     and no connection is opened — this is how the grouping,
//                     leverage and emission paths get exercised without a
//                     database. A fixture-built map is not the real map and
//                     says so in its own header.
//
// ── Holo 7 (2026-09-01): this file is now a CLI, not an implementation ─────
// The rows-and-evidence core moved to tools/bake/pattern-cards.ts so that
// tools/bake-catalog.mts can emit these two artifacts from the SAME single
// connection it already opens for the catalog shards. Everything below is
// argv parsing, .env loading, the one connection, and the printed report.
// Same flags, same output shapes, same bytes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildPatternCards, readEvidence, type CatalogRow } from './bake/pattern-cards.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE_ONLY = process.argv.includes('--evidence-only')
const FIXTURE: string | null = (() => {
  const i = process.argv.indexOf('--fixture')
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
})()
/** Nothing below opens a connection or writes into data/ when this is true. */
const OFFLINE = EVIDENCE_ONLY || FIXTURE !== null

// .env loader (no dotenv dep): KEY=VALUE lines, quotes optional. Still hard —
// a missing .env on the real run must fail here, not as a confusing pg error.
// The offline modes never open a connection, so they skip the file entirely.
if (!OFFLINE) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=("?)(.*)\2\s*$/.exec(line.trim())
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[3]!
  }
}

// ── The one tool here that needs a database ────────────────────────────────
//
// This script INVERTS the resolver: it walks every card_variant in a catalog,
// feeds each row through the real resolveFoil(), and writes which printings
// each pattern governs. That walk needs a catalog, and foilkit ships none — the
// corpus here is measurements OF printings, not a list of them.
//
// So `pg` is not a dependency of this repository and never will be. It is
// resolved at RUN TIME out of whatever project supplies the catalog, named by
// PG_HOST_PACKAGE (a path to that project's package.json). Without it the tool
// still runs in its two offline modes (--evidence-only, --fixture), which is
// what CI and a contributor without a catalog use.
//
// Subtask 7 turns this into a BUILD-TIME input question for the hosted editor:
// the map has to be baked, because the editor has no database at read time.
const PG_HOST = process.env.PG_HOST_PACKAGE ?? join(ROOT, '..', 'deckpal', 'apps', 'api', 'package.json')
interface PgClientCtor {
  new (cfg: {
    host?: string
    port?: number
    user?: string
    password?: string
    database?: string
    connectionString?: string
  }): {
    connect(): Promise<void>
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
    end(): Promise<void>
  }
}
const Client: PgClientCtor = OFFLINE
  ? (null as unknown as PgClientCtor)
  : (createRequire(PG_HOST)('pg') as { Client: PgClientCtor }).Client

/** Shapes of the two returned artifacts, only as far as the report reads them. */
interface Verdict {
  reason: string
  detail: string
  alternates: number
}
interface ReportedGroup {
  key: string
  printings: number
  distinctCards: number
  exemplars: number
  leverage: number
}

async function main(): Promise<void> {
  // Local evidence first: a disk problem should surface before, not during,
  // the one connection the budget rule allows.
  const evidence = await readEvidence(ROOT)
  if (EVIDENCE_ONLY) {
    console.log(
      `mask corpus: ${evidence.maskRecords} record(s) across ${evidence.maskCards} distinct card(s), ` +
        `${evidence.maskUnits.size} (cardId, scope) coverage unit(s)`,
    )
    console.log(`window geometry: ${evidence.windowFiles} file(s) across ${evidence.windowCards.size} card(s)`)
    // Every era/scope pair the corpus itself carries — the catalog walk asks
    // for a superset of these, and every pair outside this set is empty.
    for (const pair of [...evidence.corpusPairs].sort()) {
      const [eraId, scope] = pair.split('|') as [string, string]
      const p = evidence.poolFor(eraId, scope)
      console.log(
        `  exemplars ${eraId}/${scope}: ${p.exemplars} unit(s) (${p.records} admissible record(s), ` +
          `weight ${p.weight}, ${p.rejected} rejected) ${JSON.stringify(p.byMethod)}`,
      )
    }
    console.log('--evidence-only: no database touched, no files written.')
    return
  }

  let rows: CatalogRow[]
  if (FIXTURE) {
    rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as CatalogRow[]
    console.log(`--fixture ${FIXTURE}: ${rows.length} row(s), no database opened`)
  } else {
    const client = new Client({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    })
    await client.connect() // the ONE connection (budget rule)
    try {
      const res = await client.query<CatalogRow>(
        `SELECT c.tcgdex_id AS card_id, c.name AS card_name, c.rarity,
                cs.tcgdex_id AS set_id, cs.name AS set_name, ser.slug AS series_slug,
                cv.id AS variant_id, cv.variant_kind_code AS kind
           FROM card_variant cv
           JOIN card c ON c.id = cv.card_id
           JOIN card_set cs ON cs.id = c.set_id
           JOIN series ser ON ser.id = cs.series_id`,
      )
      rows = res.rows
    } finally {
      await client.end()
    }
  }

  const generatedAt = new Date().toISOString()
  /** 'catalog' or 'fixture:<path>' — a fixture-built file never claims to be real. */
  const source = FIXTURE ? `fixture:${FIXTURE}` : 'catalog'
  const { patternCards, verificationMap } = buildPatternCards(rows, evidence, { source, generatedAt })

  const patterns = patternCards.patterns as Record<string, unknown[]>
  const diagnosis = patternCards.diagnosis as Record<string, Verdict>
  const assigned = patternCards.variantsAssigned as number
  const mapGroups = verificationMap.groups as ReportedGroup[]
  const cardsAssigned = (verificationMap.catalog as { cardsAssigned: number }).cardsAssigned

  const dest = FIXTURE ? `${FIXTURE}.pattern-cards.json` : join(ROOT, 'data', 'foil-pattern-cards.json')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, JSON.stringify(patternCards) + '\n', 'utf8')

  const mapDest = FIXTURE ? `${FIXTURE}.verification-map.json` : join(ROOT, 'data', 'foil-verification-map.json')
  writeFileSync(mapDest, JSON.stringify(verificationMap, null, 2) + '\n', 'utf8')
  const counts = Object.entries(patterns)
    .map(([p, list]) => `${p}:${list.length}`)
    .sort()
    .join(' ')
  console.log(`wrote ${dest} — ${assigned}/${rows.length} variants across ${Object.keys(patterns).length} patterns`)
  console.log(counts)
  for (const [p, v] of Object.entries(diagnosis)) {
    console.log(`  empty pool: ${p} — ${v.reason} (alt ${v.alternates}) — ${v.detail}`)
  }

  console.log(
    `\nwrote ${mapDest} — ${mapGroups.length} rule group(s) over ${assigned} printing(s) ` + `/ ${cardsAssigned} card(s)`,
  )
  console.log(
    `evidence: ${evidence.maskRecords} mask record(s), ${evidence.maskCards} card(s), ` +
      `${evidence.maskUnits.size} (cardId, scope) unit(s), ${evidence.exemplarUnits.size} of them admissible; ` +
      `${evidence.windowFiles} window file(s) over ${evidence.windowCards.size} card(s)`,
  )
  console.log('\ntop groups by leverage (printings ÷ (exemplars + 1))')
  for (const g of mapGroups.slice(0, 10)) {
    console.log(
      `  ${String(Math.round(g.leverage)).padStart(7)}  ${g.key.padEnd(52)} ` +
        `printings ${String(g.printings).padStart(6)}  cards ${String(g.distinctCards).padStart(6)}  ` +
        `exemplars ${g.exemplars}`,
    )
  }
}

void main()

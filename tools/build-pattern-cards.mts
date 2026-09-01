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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveFoil, citedFoilPatterns, RESOLVER_VERSION } from '@foilkit/resolver'
import { PATTERNS, canonicalPatternId } from '@foilkit/patterns'
import usageIndex from '@foilkit/resolver/usage-index.json'
import { readCorpus, selectExemplars } from '@foilkit/forge'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
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

interface Row {
  card_id: string
  card_name: string
  rarity: string | null
  set_id: string
  set_name: string
  series_slug: string
  variant_id: string
  kind: string
}

// ── The human-evidence side (local disk only — no database) ────────────────
//
// COUNTING UNITS (3a step 3 — getting these wrong inflates the map severalfold):
//
//  * MASK COVERAGE counts per (cardId, scope), NOT per (cardId, variantId).
//    All variants of one cardId render the same scan — imagery is keyed per
//    card and card_variant carries none of its own — so one mask serves every
//    sibling variant whose prior.scope matches (newest savedAt wins, reported
//    as X-Foil-Mask-Alias-Of). A holo (window) and a reverse (sheet) of the
//    same card must never share one, hence scope is part of the key.
//  * WINDOW GEOMETRY aliases scope-agnostically: the art box is a property of
//    the scan and a sheet is the same box inverted. Counted per cardId.
//  * PATTERN ASSIGNMENT counts per printing — (card, variant) — because a holo
//    and a reverse of one card resolve to different patterns.
//  * CROSS-CARD REUSE NEVER ALIASES. Different cardIds that reprint the same
//    illustration (Base Set 2, promo reprints) cannot be proven identical from
//    the catalog — no illustration key, illustrator+name is heuristic, pHash is
//    similarity not identity — so they stay separate rows.
const COUNTING_UNITS = {
  maskCoverage: '(cardId, scope) — one mask serves every sibling variant of the card at that scope',
  windowGeometry: 'cardId — scope-agnostic; a sheet is the same art box inverted',
  patternAssignment: '(cardId, variantId) — one printing, since holo and reverse resolve differently',
  crossCardReuse: 'never aliased — reprints of one illustration under different cardIds stay separate rows',
  exemplars:
    'admissible masks via selectExemplars({eraId, scope}) (EXEMPLAR_WEIGHT > 0), then aliased to distinct ' +
    '(cardId, scope) units — never a directory glob, so unreviewed `ai` masks can never count as evidence',
  leverage: 'printings ÷ (exemplars + 1) — where an hour of human attention moves the most pixels',
  maskCoveredCards:
    'coverage is NOT evidence: a group can carry masks that selectExemplars rejects (unreviewed `ai`), so ' +
    'maskCoveredCards ≥ exemplarsInGroup by design',
  confidenceHistogram: "guess.confidence per printing; a null confidence (heuristic) is bucketed as 'none'",
} as const

interface ExemplarPool {
  eraId: string
  scope: string
  /** Admissible masks, aliased to distinct (cardId, scope) units. THE count. */
  exemplars: number
  /** Raw admissible records before aliasing (a card with two is still one unit). */
  records: number
  /** Σ EXEMPLAR_WEIGHT over the aliased winners — hand 1, ai-corrected 0.6. */
  weight: number
  byMethod: Record<string, number>
  /** Considered and thrown out, with why — auditable, per selectExemplars. */
  rejected: number
}

interface Evidence {
  maskRecords: number
  maskCards: number
  /** (cardId, scope) that carry ANY mask record, admissible or not. */
  maskUnits: Set<string>
  /** (cardId, scope) that carry at least one ADMISSIBLE exemplar. */
  exemplarUnits: Set<string>
  /** cardIds with a data/foil-windows/<cardId>/<variantId>.json. */
  windowCards: Set<string>
  windowFiles: number
  /** `${eraId}|${scope}` pairs the corpus itself carries — every other pool is empty. */
  corpusPairs: Set<string>
  /** `${eraId}|${scope}` → pool, memoised; the pool is the generator's evidence. */
  pools: Map<string, ExemplarPool>
  poolFor: (eraId: string, scope: string) => ExemplarPool
}

async function readEvidence(): Promise<Evidence> {
  const corpus = await readCorpus(join(ROOT, 'data', 'foil-masks'))
  const maskUnits = new Set<string>()
  const exemplarUnits = new Set<string>()
  const maskCards = new Set<string>()
  const corpusPairs = new Set<string>()
  for (const e of corpus) {
    maskCards.add(e.cardId)
    // A sidecar with no prior.scope cannot be aliased safely; key it alone.
    maskUnits.add(`${e.cardId}|${String(e.sidecar.prior?.scope ?? 'unknown')}`)
    corpusPairs.add(`${String(e.sidecar.prior?.eraId ?? 'unknown')}|${String(e.sidecar.prior?.scope ?? 'unknown')}`)
  }
  // Admissibility goes through the real path, unfiltered, once.
  for (const e of selectExemplars(corpus).chosen) {
    exemplarUnits.add(`${e.cardId}|${String(e.sidecar.prior?.scope ?? 'unknown')}`)
  }

  const windowCards = new Set<string>()
  let windowFiles = 0
  const windowsDir = join(ROOT, 'data', 'foil-windows')
  let dirs: string[] = []
  try {
    dirs = readdirSync(windowsDir)
  } catch {
    /* no window corpus in this checkout */
  }
  for (const cardId of dirs) {
    let files: string[]
    try {
      if (!statSync(join(windowsDir, cardId)).isDirectory()) continue
      files = readdirSync(join(windowsDir, cardId))
    } catch {
      continue
    }
    const geo = files.filter((f) => /^\d{1,10}\.json$/.test(f))
    if (geo.length === 0) continue
    windowCards.add(cardId) // per cardId — scope-agnostic (see COUNTING_UNITS)
    windowFiles += geo.length
  }

  const pools = new Map<string, ExemplarPool>()
  const poolFor = (eraId: string, scope: string): ExemplarPool => {
    const key = `${eraId}|${scope}`
    const hit = pools.get(key)
    if (hit) return hit
    const sel = selectExemplars(corpus, { eraId, scope })
    // Alias to (cardId, scope): scope is fixed by the query, so distinct
    // cardId IS the unit. selectExemplars already sorted weight desc then
    // savedAt desc, so the first sighting of a card is the winner.
    const seen = new Set<string>()
    const byMethod: Record<string, number> = {}
    let weight = 0
    for (const e of sel.chosen) {
      if (seen.has(e.cardId)) continue
      seen.add(e.cardId)
      weight += e.weight
      const m = e.sidecar.derivation_method
      byMethod[m] = (byMethod[m] ?? 0) + 1
    }
    const pool: ExemplarPool = {
      eraId,
      scope,
      exemplars: seen.size,
      records: sel.chosen.length,
      weight: Number(weight.toFixed(3)),
      byMethod,
      rejected: sel.rejected.length,
    }
    pools.set(key, pool)
    return pool
  }

  return {
    maskRecords: corpus.length,
    maskCards: maskCards.size,
    maskUnits,
    exemplarUnits,
    windowCards,
    windowFiles,
    corpusPairs,
    pools,
    poolFor,
  }
}

async function main(): Promise<void> {
  // Local evidence first: a disk problem should surface before, not during,
  // the one connection the budget rule allows.
  const evidence = await readEvidence()
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

  let rows: Row[]
  if (FIXTURE) {
    rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Row[]
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
      const res = await client.query<Row>(
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

  // [cardId, variantId, kind, scope, match, confidence] — tuple array keeps the
  // file compact. Holo 3a appended the last two (the resolver's own account of
  // WHY it guessed: 'card' | 'facet' | 'set' | 'series' | 'heuristic', and the
  // winning row's confidence). Appending is safe for existing readers: the
  // foil-lab pattern-cards route destructures the first four positionally.
  type Tuple = [string, number, string, string, string, string | null]
  const patterns: Record<string, Tuple[]> = {}
  // R7: the SECONDARY pool — cards a cited row names for a pattern that did
  // NOT win the resolver's single-winner contest (see citedFoilPatterns).
  // Capped so the file stays a preview index, not a second catalog.
  const ALT_CAP = 240
  const alternates: Record<string, Tuple[]> = {}
  const altSeen: Record<string, number> = {}
  // Who DID win, per losing pattern — the honest answer to "why no cards".
  const outrankedBy: Record<string, Record<string, number>> = {}
  // ── The verification map's accumulator: one entry per RULE ────────────────
  // Key (eraId, scope, patternId, guess.match) — the unit a human decision
  // improves, because verifying inside a group refits the guess for every
  // other printing the same rule governs.
  interface Group {
    eraId: string
    scope: string
    patternId: string
    match: string
    /** Printings — (cardId, variantId). See COUNTING_UNITS.patternAssignment. */
    printings: number
    cards: Set<string>
    confidence: Record<string, number>
  }
  const groups = new Map<string, Group>()
  const assignedCards = new Set<string>()
  let assigned = 0
  for (const r of rows) {
    const input = {
      seriesSlug: r.series_slug,
      rarity: r.rarity,
      variantKind: r.kind,
      setId: r.set_id,
      setName: r.set_name,
      cardName: r.card_name,
      cardId: r.card_id,
    }
    const ref = resolveFoil(input)
    if (ref.patternId === 'none' || ref.scope === 'none') continue
    const tuple: Tuple = [r.card_id, Number(r.variant_id), r.kind, ref.scope, ref.guess.match, ref.guess.confidence]
    ;(patterns[ref.patternId] ??= []).push(tuple)
    assigned++
    assignedCards.add(r.card_id)
    const gk = `${ref.eraId}|${ref.scope}|${ref.patternId}|${ref.guess.match}`
    const g = (groups.get(gk) ??
      (groups
        .set(gk, {
          eraId: ref.eraId,
          scope: ref.scope,
          patternId: ref.patternId,
          match: ref.guess.match,
          printings: 0,
          cards: new Set<string>(),
          confidence: {},
        })
        .get(gk) as Group))
    g.printings++
    g.cards.add(r.card_id) // a Set — cross-card reuse never aliases, but the
    // same cardId's holo and reverse land in DIFFERENT groups (different scope)
    const c = ref.guess.confidence ?? 'none'
    g.confidence[c] = (g.confidence[c] ?? 0) + 1
    for (const p of citedFoilPatterns(input)) {
      if (p === ref.patternId) continue
      altSeen[p] = (altSeen[p] ?? 0) + 1
      ;((outrankedBy[p] ??= {})[ref.patternId] = (outrankedBy[p]?.[ref.patternId] ?? 0) + 1)
      const list = (alternates[p] ??= [])
      // Reservoir-lite: keep an even spread across the catalog, not the first N.
      if (list.length < ALT_CAP) list.push(tuple)
      else {
        const j = Math.floor(Math.random() * altSeen[p]!)
        if (j < ALT_CAP) list[j] = tuple
      }
    }
  }

  // ── Why a pattern has no cards (R7: Chey asked this four times) ───────────
  // Every implemented recipe with an empty PRIMARY pool gets a machine-readable
  // verdict the canon lab can show instead of a bare "no catalog cards".
  const usageRows = (usageIndex as { rows: { p: string; sets: string[]; at: string[] }[] }).rows
  const catalogSetNames = new Set<string>()
  const displayName = new Map<string, string>()
  for (const r of rows) {
    const n = r.set_name.toLowerCase().replace(/\s+/g, ' ').trim()
    catalogSetNames.add(n)
    if (!displayName.has(n)) displayName.set(n, r.set_name)
  }
  type Verdict = {
    reason: string
    detail: string
    /** Rows kept in the sampled fallback pool (capped at ALT_CAP). */
    alternates: number
    /** How many printings the cited rows actually name (uncapped). */
    citedPrintings: number
    outrankedBy?: [string, number][]
  }
  const diagnosis: Record<string, Verdict> = {}
  for (const pat of PATTERNS) {
    if (pat.id === 'none' || (patterns[pat.id]?.length ?? 0) > 0) continue
    const cited = usageRows.filter((u) => canonicalPatternId(u.p) === pat.id)
    const alt = alternates[pat.id]?.length ?? 0
    const ranked = Object.entries(outrankedBy[pat.id] ?? {}).sort((a, b) => b[1] - a[1])
    if (alt > 0) {
      diagnosis[pat.id] = {
        reason: 'outranked',
        detail:
          `${altSeen[pat.id]!.toLocaleString()} catalog printings are named by a cited row for this pattern, but a ` +
          `higher-ranked row wins each of them. Both claims can be true — cited rows often describe different ` +
          `physical layers of the same card.`,
        alternates: alt,
        citedPrintings: altSeen[pat.id] ?? 0,
        outrankedBy: ranked.slice(0, 4) as [string, number][],
      }
      continue
    }
    if (cited.length === 0) {
      diagnosis[pat.id] = {
        reason: 'no-cited-rows',
        detail: 'No cited usage or assignment row maps this pattern to any catalog set, so the resolver can never pick it.',
        alternates: 0,
        citedPrintings: 0,
      }
      continue
    }
    const named = [...new Set(cited.flatMap((u) => u.sets))]
    const inCatalog = named.filter((s) => catalogSetNames.has(s))
    if (inCatalog.length === 0) {
      diagnosis[pat.id] = {
        reason: 'sets-absent',
        detail: `Cited on ${named.length} set name(s) that do not exist in this catalog.`,
        alternates: 0,
        citedPrintings: 0,
      }
      continue
    }
    const classes = [...new Set(cited.flatMap((u) => u.at))]
    const pretty = inCatalog.map((s) => displayName.get(s) ?? s)
    const shown = pretty.slice(0, 4).join(', ') + (pretty.length > 4 ? ` +${pretty.length - 4} more` : '')
    diagnosis[pat.id] = {
      reason: 'class-absent',
      detail:
        `Cited only on the ${classes.join('/')} printings of ${shown} — and the catalog carries no such variant for ` +
        `those sets, so no printing can resolve to it. This is a catalog gap upstream, not a resolver miss.`,
      alternates: 0,
      citedPrintings: 0,
    }
  }

  const generatedAt = new Date().toISOString()
  /** 'catalog' or 'fixture:<path>' — a fixture-built file never claims to be real. */
  const source = FIXTURE ? `fixture:${FIXTURE}` : 'catalog'
  const out = {
    version: 3, // v3: tuples carry guess.match + guess.confidence (Holo 3a)
    generatedAt,
    source,
    resolverVersion: RESOLVER_VERSION,
    variantsScanned: rows.length,
    variantsAssigned: assigned,
    tupleFields: ['cardId', 'variantId', 'kind', 'scope', 'match', 'confidence'],
    patterns,
    alternates,
    diagnosis,
  }
  const dest = FIXTURE ? `${FIXTURE}.pattern-cards.json` : join(ROOT, 'data', 'foil-pattern-cards.json')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, JSON.stringify(out) + '\n', 'utf8')

  // ── The verification map (Holo 3a) ───────────────────────────────────────
  // Rule groups ranked by leverage. No Postgres is read here — every number
  // below comes from the walk above or from the local evidence index, which is
  // what lets subtask 7 bake this file into a static site.
  const mapGroups = [...groups.values()]
    .map((g) => {
      const pool = evidence.poolFor(g.eraId, g.scope)
      const cards = [...g.cards]
      // Evidence sitting on THIS group's own cards, aliased per (cardId, scope).
      const exemplarsInGroup = cards.filter((c) => evidence.exemplarUnits.has(`${c}|${g.scope}`)).length
      const maskCoveredCards = cards.filter((c) => evidence.maskUnits.has(`${c}|${g.scope}`)).length
      const windowGeometryCards = cards.filter((c) => evidence.windowCards.has(c)).length
      return {
        key: `${g.eraId}|${g.scope}|${g.patternId}|${g.match}`,
        eraId: g.eraId,
        scope: g.scope,
        patternId: g.patternId,
        match: g.match,
        printings: g.printings,
        distinctCards: g.cards.size,
        confidence: g.confidence,
        /** The (eraId, scope) exemplar pool a regeneration pass would refit on. */
        exemplars: pool.exemplars,
        exemplarRecords: pool.records,
        exemplarWeight: pool.weight,
        exemplarsByMethod: pool.byMethod,
        /** Of those, the ones that are cards of THIS group. */
        exemplarsInGroup,
        /** (cardId, scope) units in this group carrying ANY mask — coverage, not evidence. */
        maskCoveredCards,
        windowGeometryCards,
        leverage: Number((g.printings / (pool.exemplars + 1)).toFixed(3)),
      }
    })
    .sort((a, b) => b.leverage - a.leverage || b.printings - a.printings || (a.key < b.key ? -1 : 1))

  const mapOut = {
    version: 1,
    generatedAt,
    source,
    resolverVersion: RESOLVER_VERSION,
    /** How every number here is counted — read this before comparing anything. */
    countingUnits: COUNTING_UNITS,
    groupKey: ['eraId', 'scope', 'patternId', 'match'],
    sortedBy: 'leverage desc, then printings desc, then key',
    catalog: {
      variantsScanned: rows.length,
      variantsAssigned: assigned,
      /** Distinct cardIds with at least one assigned printing. */
      cardsAssigned: assignedCards.size,
      groups: mapGroups.length,
    },
    corpus: {
      maskRecords: evidence.maskRecords,
      maskCards: evidence.maskCards,
      maskCoverageUnits: evidence.maskUnits.size,
      exemplarUnits: evidence.exemplarUnits.size,
      windowGeometryFiles: evidence.windowFiles,
      windowGeometryCards: evidence.windowCards.size,
      exemplarPools: Object.fromEntries([...evidence.pools].map(([k, v]) => [k, v])),
    },
    groups: mapGroups,
  }
  const mapDest = FIXTURE ? `${FIXTURE}.verification-map.json` : join(ROOT, 'data', 'foil-verification-map.json')
  writeFileSync(mapDest, JSON.stringify(mapOut, null, 2) + '\n', 'utf8')
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
    `\nwrote ${mapDest} — ${mapGroups.length} rule group(s) over ${assigned} printing(s) ` +
      `/ ${assignedCards.size} card(s)`,
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

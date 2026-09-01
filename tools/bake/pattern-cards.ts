// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake/pattern-cards.ts — the pure core of the 3a inversion, lifted out
// of tools/build-pattern-cards.mts so a SECOND producer can call it.
//
// Nothing here opens a connection, reads process.argv, or writes a file. It
// takes catalog rows and a local evidence index and returns two objects. The
// callers supply the I/O:
//
//   tools/build-pattern-cards.mts   the original CLI — one PG connection, or a
//                                   fixture file, writes data/*.json
//   tools/bake-catalog.mts          Holo 7's bake — the SAME one connection it
//                                   already opened for the catalog shards
//
// That second caller is the whole reason for this module. The connection
// budget is one connection for the job, and "the job" now emits five files,
// not two. Two scripts each opening their own connection would be two, and a
// bake that re-implemented the inversion would drift from the resolver the
// app actually renders with — which is the exact failure 3a was built to make
// impossible.
//
// The behaviour is a straight port. If this file and build-pattern-cards.mts
// ever disagree about a number, this file is wrong.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFoil, citedFoilPatterns, RESOLVER_VERSION } from '@foilkit/resolver'
import { PATTERNS, canonicalPatternId } from '@foilkit/patterns'
import usageIndex from '@foilkit/resolver/usage-index.json' with { type: 'json' }
import { readCorpus, selectExemplars } from '@foilkit/forge'

/**
 * One printing, as the catalog walk yields it. The column aliases are the
 * ones 3a's query already proved against the live DeckPal schema — see
 * tools/bake-catalog.mts's COLUMNS block for the ones that are still guesses.
 */
export interface CatalogRow {
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
export const COUNTING_UNITS = {
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

export interface ExemplarPool {
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

export interface Evidence {
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

/**
 * Read the local human-evidence index out of `<rootDir>/data`. No database,
 * no network. `rootDir` is a parameter rather than a module constant so the
 * two callers cannot disagree about where the repository root is.
 */
export async function readEvidence(rootDir: string): Promise<Evidence> {
  const corpus = await readCorpus(join(rootDir, 'data', 'foil-masks'))
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
  const windowsDir = join(rootDir, 'data', 'foil-windows')
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

export interface BuildPatternCardsOptions {
  /** 'catalog' or 'fixture:<name>' — a fixture-built file never claims to be real. */
  source: string
  /** Stamped into BOTH artifacts, identical, so a pair is provably one run. */
  generatedAt: string
}

/** [cardId, variantId, kind, scope, match, confidence] */
export type PatternTuple = [string, number, string, string, string, string | null]

export interface PatternCardsResult {
  /** data/foil-pattern-cards.json — version 3. */
  patternCards: Record<string, unknown>
  /** data/foil-verification-map.json — version 1. */
  verificationMap: Record<string, unknown>
}

/**
 * Invert the resolver over `rows` and group the result by RULE.
 *
 * Pure apart from Math.random(): the `alternates` pool uses reservoir sampling
 * once a pattern's cited printings exceed ALT_CAP, so a pattern with more than
 * 240 cited-but-outranked printings samples a different 240 each run. Below
 * that cap — which is every pattern in the fixture corpus — the output is
 * deterministic. The sampling is deliberate (an even spread across the catalog
 * beats the first N, which would all be Base Set), and it only ever touches
 * the preview pool, never a count.
 */
export function buildPatternCards(
  rows: CatalogRow[],
  evidence: Evidence,
  opts: BuildPatternCardsOptions,
): PatternCardsResult {
  // [cardId, variantId, kind, scope, match, confidence] — tuple array keeps the
  // file compact. Holo 3a appended the last two (the resolver's own account of
  // WHY it guessed: 'card' | 'facet' | 'set' | 'series' | 'heuristic', and the
  // winning row's confidence). Appending is safe for existing readers: the
  // foil-lab pattern-cards route destructures the first four positionally.
  type Tuple = PatternTuple
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

  const { generatedAt, source } = opts
  const patternCards = {
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

  const verificationMap = {
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

  return { patternCards, verificationMap }
}

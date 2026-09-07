// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/task-queue/build.ts — the generator behind `tools/build-task-queue.mts`.
//
// WHAT IT IS FOR. The hosted editor's home screen ranked RULE GROUPS by
// leverage, which answers "where does an hour move the most pixels" and
// nothing else. It is the right spine and it is not the whole list: five other
// kinds of contribution are recorded in this repository — approximated
// recipes, canon-less patterns, standing verification nays, machine masks
// nobody has corrected, untargeted research residuals, and patterns whose
// resolver pool is empty — and every one of them was invisible from the queue.
// This builder turns all six into ONE sorted list of task cards, so the
// landing page can say what is needed, roughly how long it takes, and who can
// do it.
//
// EVERY CARD TRACES TO ITS SOURCE. `task.source` names the file and the field
// the card was derived from, and the page renders it. There is no hardcoded
// task list anywhere in here: the six generators below read the repository's
// own artifacts and emit whatever those artifacts say today. Where a document
// makes a COUNT claim that the data disagrees with, the disagreement is
// emitted as a `reconciliation` row rather than resolved silently — a
// divergence is a finding about the corpus, and a builder that quietly agreed
// with whatever it found would never surface one.
//
// NO DATABASE, NO NETWORK. Same rule as tools/corpus-manifest/build.ts: this
// runs on EVERY build of the hosted editor, so it stays file reads plus the
// resolver, which is pure.
//
// ── WHY THE BAKE DIRECTORY IS A PARAMETER ──────────────────────────────────
//
// Two of the inputs (`foil-verification-map.json`, `foil-pattern-cards.json`)
// and the whole catalog are outputs of `tools/bake-catalog.mts`, which needs a
// database. `apps/editor/copy-data.mjs` already resolves them from
// `data/fixture-bake` under FOILKIT_BAKE=fixture, and this builder follows the
// same seam so the fixture site gets a real queue built from fixture numbers
// rather than an empty one. The COMMITTED corpus (the manifest, the verdicts,
// the assignments) always comes from `data/`, exactly as copy-data.mjs's
// CORPUS_DIRS do.
//
// A missing bake is TOLERATED and RECORDED (`bakedInputs.present: false`), not
// fatal — the editor already renders "this artifact has not been baked" as a
// banner, and a build step that needed production credentials would fail on
// every machine that does not have them. A missing COMMITTED input is fatal,
// because that is a broken checkout rather than an unrun job.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PATTERNS } from '@foilkit/patterns'
import { resolveFoil } from '@foilkit/resolver'

// ── The units, emitted verbatim into the artifact ──────────────────────────

/** Read this before comparing any number on a task card. */
export const COUNTING_UNITS = {
  impact:
    'PRINTINGS the resolver assigns to the rule this task teaches — a (cardId, variantId) count, since a holo and ' +
    'a reverse of one card resolve differently. It is the sort key: a mask on a card whose group governs 1,600 ' +
    'printings outranks a one-off. `null` means the input needed to size it is not in this bake, NOT zero',
  noHandMask:
    'a (cardId, scope) mask unit whose winning record has reviewStatus !== "human-authored" — machine output ' +
    'nobody has corrected. Cards with NO mask at all are excluded on purpose: they have no diff.agreement, and ' +
    'agreement is what ranks this section',
  divergence:
    '1 − sidecar.diff.agreement (Jaccard) of the machine mask against the era rule it was seeded from. HIGH ' +
    'divergence means the era rule and the machine both had to guess and disagreed, which is exactly where a hand ' +
    'mask teaches the most',
  emptyPool:
    "an implemented recipe the resolver never picks. The bake's own diagnosis block says WHICH of four causes, and " +
    'the four imply four different contributions — they are not one backlog',
  estimate:
    'a TIER, not a number: minutes / half-hour / hours. Every tier carries a one-line rationale. Anything more ' +
    'precise would be invented',
} as const

/** The skills a task can want. A contributor filters on exactly one of these. */
export const SKILLS = {
  mask: 'Mask drawing — trace where the foil actually sits on one printing.',
  slider: 'Slider tuning — move the canon dials until the recipe matches the reference.',
  glsl: 'GLSL — write or repair a pattern recipe.',
  research: 'Research / citation — find a source that names cards, and cite it.',
  'live-tilt':
    'Live tilt — look at a tilting card and record a verdict. No code. This is a real skill here because the ' +
    'still-frame judge is structurally blind to motion, and a human eye is the only instrument that is not.',
} as const

export type Skill = keyof typeof SKILLS

/** The guards a card can carry. Rendered on the card, not buried in a doc. */
export const GUARDS = {
  'do-not-flip-winners':
    'Do not flip a resolver winner just to fill a pool. Cited rows routinely describe different physical layers ' +
    'of the same card — one names the sheet, another names the art window — and both being true is a documented ' +
    'non-bug. Closing this means finding a source the resolver does not have, not re-ranking the ones it does.',
  'live-tilt-not-glsl':
    'The ask here is a LIVE-TILT HUMAN VERDICT, not another GLSL round. This nay is a motion claim, and the judge ' +
    'scores still frames; several of its claims are already refuted at pixel level. Shader work cannot move a ' +
    'dimension the instrument cannot measure.',
  'needs-a-bake':
    'Closing this edits data/foil-card-assignments.json, which changes what the resolver guesses. The verification ' +
    'map and the pattern-card pools this queue is built from are bake outputs, so they must be regenerated in the ' +
    'same change or the queue will describe a corpus that no longer exists.',
  'motion-half-needs-tilt':
    'One dimension of this nay is motion-only and needs a live-tilt verdict separately; the GLSL ask here is the ' +
    'asset/shader half. Do not read the still-frame motion refutation as license to skip the tilt — it closes a ' +
    'different half of this row than the shader work does.',
} as const

export type Guard = keyof typeof GUARDS

export type Estimate = 'minutes' | 'half-hour' | 'hours'

export type TaskType =
  | 'approximation'
  | 'canon'
  | 'verdict'
  | 'mask'
  | 'window-mask'
  | 'residual'
  | 'empty-pool'

export interface Task {
  /** Stable across builds — the page uses it as a React key and a filter anchor. */
  id: string
  type: TaskType
  /** WHAT'S NEEDED, imperative, naming the actual thing. Never a category label. */
  title: string
  /** One or two sentences: what doing it means. */
  need: string
  skill: Skill
  estimate: Estimate
  /** Why that tier. One line. */
  estimateWhy: string
  /** Printings governed. Null when this bake cannot size it — never faked as 0. */
  impact: number | null
  impactWhy: string
  /** Deep link into the exact surface, or null when no surface addresses it. */
  link: string | null
  /** The file and field this card was derived from. */
  source: string
  guards: Guard[]
  /**
   * Secondary sort, higher first, only among cards of EQUAL impact.
   *
   * It exists for one section: five Base Set holos all sit in the same rule
   * group, so their impact is identical to the printing and an id tie-break
   * would order them alphabetically — putting the 40%-agreement mask (the one
   * where the era rule and the machine disagree most) fifth. This carries the
   * divergence so the honest order survives the global sort. 0 everywhere else.
   */
  tieBreak: number
  /** Type-specific numbers the card renders. Always JSON-serializable. */
  detail: Record<string, string | number | boolean | null>
}

export interface EmptyPool {
  patternId: string
  reason: string
  /** The bake's own sentence, rendered verbatim. */
  detail: string
  citedPrintings: number
  alternates: number
  outrankedBy: { patternId: string; printings: number }[]
  /** What THIS cause implies a contributor should do. One per cause, not one per pattern. */
  implies: string
}

export interface Reconciliation {
  key: string
  /** What a document claims, quoted, with where it says so. */
  claim: string
  claimedAt: string
  /** What this repository's own data measures today. */
  measured: string
  agrees: boolean
  /** Why they differ, when they do. */
  note: string
}

export interface TaskQueue {
  version: 1
  generatedAt: string
  source: string | null
  resolverVersion: number | null
  countingUnits: typeof COUNTING_UNITS
  skills: typeof SKILLS
  guards: typeof GUARDS
  estimateTiers: Record<Estimate, string>
  bakedInputs: Record<string, boolean>
  counts: {
    tasks: number
    byType: Record<string, number>
    bySkill: Record<string, number>
    /** Printings governed by every task that could be sized. */
    impactTotal: number
    unsized: number
  }
  reconciliation: Reconciliation[]
  emptyPools: EmptyPool[]
  tasks: Task[]
}

export interface BuildReport {
  queue: TaskQueue
  /** Reconciliation rows where the doc and the data disagree — the CLI prints these. */
  findings: Reconciliation[]
  /** Set shards actually opened, so the cost of this step is visible. */
  shardsRead: number
}

export class TaskQueueError extends Error {
  override readonly name = 'TaskQueueError'
}

// A DECLARATION so TypeScript treats it as control-flow-terminating.
function fail(msg: string): never {
  throw new TaskQueueError(msg)
}

const ESTIMATE_TIERS: Record<Estimate, string> = {
  minutes: 'One sitting at one card. Open it, look, answer.',
  'half-hour': 'One focused pass over one thing, with the surface already in front of you.',
  hours: 'New work — a recipe, a silhouette from scratch, or a source that has to be found before it can be cited.',
}

// ── The doc claims this builder checks itself against ───────────────────────
//
// NOT used to compute anything. Each is a COUNT a document asserts; the
// builder derives the real number from the repository and emits a
// `reconciliation` row either way. Same discipline as
// tools/build-corpus-manifest.mts's SUBTASK_5_UNCANONED: a change in one of
// these numbers is a finding, and a build that agreed with whatever it found
// would never print one.

/**
 * docs/SHADER-CONTRACT.md:290-295 originally claimed 5 (big-glitter, sequin,
 * tcg-classic, acid-wash, disco — the R3 list, itself defined at
 * docs/VERIFICATION.md:530-533). CORRECTED 2026-09-06 at the same site
 * (line 295): four of the five shipped dedicated recipes in R3-MISC, leaving
 * one. This constant tracks the doc's CURRENT claim, post-correction.
 */
const CLAIMED_APPROXIMATIONS = ['big-glitter']
const CLAIMED_APPROXIMATIONS_AT = 'docs/SHADER-CONTRACT.md:295 (corrected 2026-09-06; the R3 list, docs/VERIFICATION.md:530-533)'

/**
 * docs/VERIFICATION.md:61-73 (R2b) originally claimed 4 ("the four standing
 * nays are unchanged from R2"): starlight, energy-symbols, pokeball-hologram,
 * radiant-collection-dots. CORRECTED 2026-09-06 at the same site (line 73):
 * two of the four were broken by later waves and three new nays were
 * recorded. This constant tracks the doc's CURRENT claim, post-correction.
 */
const CLAIMED_STANDING_NAYS = ['ace-spec', 'energy-symbols', 'pokeball-hologram', 'prismatic-pokeball', 'radiant']
const CLAIMED_STANDING_NAYS_AT = 'docs/VERIFICATION.md:73 (corrected 2026-09-06; R2b vocabulary wave, 2026-08-02)'

/** What each empty-pool cause implies. The bake names the cause; this says what to DO. */
const CAUSE_IMPLIES: Record<string, string> = {
  outranked:
    'A cited row DOES name these printings — a higher-ranked row simply wins them. Nothing is broken and nothing ' +
    'needs re-ranking. If this recipe is genuinely used somewhere, the contribution is a citation for a card, set ' +
    'or variant kind the resolver has never been told about.',
  'no-cited-rows':
    'No row maps this pattern to any set, so the resolver can never reach it. The contribution is the FIRST ' +
    'citation: a source that names where this treatment physically appears.',
  'class-absent':
    'The citation exists and names a product the catalog does not carry as a variant. This is a catalog gap ' +
    'upstream, not a resolver miss — the contribution is upstream data, or a note that this pattern is ' +
    'permanently unreachable here.',
  'sets-absent':
    'The citation names sets this catalog does not contain at all. Nothing in this repository can close it; the ' +
    'contribution is upstream catalog coverage.',
}

/** Read + parse a JSON file. `required` decides whether absence is fatal. */
async function readJson<T>(path: string, rel: string, required: boolean): Promise<T | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) {
    if (required) fail(`${rel} could not be read — the committed corpus is not optional.`)
    return null
  }
  try {
    return JSON.parse(text) as T
  } catch (err) {
    return fail(`${rel} will not parse as JSON: ${(err as Error).message}`)
  }
}

interface ManifestMaskRecord {
  variantId: number
  scope: string
  eraId: string
  method: string
  reviewStatus: string
  tier: string
  agreement: number | null
  savedAt: string
}

interface CorpusManifestShape {
  generatedAt: string
  masks: Record<string, Record<string, ManifestMaskRecord>>
  maskUnits: Record<string, number>
  uncanoned: string[]
}

interface MapGroup {
  key: string
  eraId: string
  scope: string
  patternId: string
  match: string
  printings: number
  distinctCards: number
  exemplars: number
  maskCoveredCards: number
  leverage: number
}

interface VerificationMapShape {
  generatedAt: string
  source: string
  resolverVersion: number
  groups: MapGroup[]
}

interface PatternCardsShape {
  generatedAt: string
  diagnosis: Record<
    string,
    { reason: string; detail: string; alternates: number; citedPrintings: number; outrankedBy?: [string, number][] }
  >
}

interface Residual {
  lane: string
  setId?: string
  cls?: string
  reason: string
  resolved?: string
}

interface AssignmentsShape {
  known_residuals: Residual[]
  rows: { pattern: string; sel: { setIds: string[]; cls: string; cardIds?: string[] | null } }[]
}

interface VerdictRow {
  patternId: string
  verdict: string
  standing: boolean
  wave: string
  judgedOn: string
  score?: string
  docLines: string
  judgeNote: string
  residual: string | null
  stillFrameBlind: boolean
  stillFrameNote: string | null
  ask: string | null
  askDetail: string | null
}

interface VerdictsShape {
  source: { doc: string }
  verdicts: VerdictRow[]
}

interface CatalogCard {
  cardId: string
  number: string
  name: string
  rarity: string | null
  variants: { variantId: number; kind: string }[]
}

interface SetShard {
  setId: string
  set: { name: string }
  page: number
  pageCount: number
  cards: CatalogCard[]
}

/**
 * The catalog, lazily and only where a task card needs it.
 *
 * Sizing a residual means counting the printings of one (setId, cls), and
 * sizing a mask task means resolving one printing — both need the set shard.
 * Reading all 229 of them on every build to answer forty questions would be
 * the wrong trade, so shards are opened on demand and cached, and the CLI
 * prints how many were actually touched.
 */
class CatalogReader {
  readonly seriesOf = new Map<string, string>()
  readonly setName = new Map<string, string>()
  private readonly shards = new Map<string, SetShard[] | null>()
  shardsRead = 0
  // A plain field rather than a parameter property: Node runs these files by
  // STRIPPING types, and a parameter property is the one TypeScript-only
  // construct that has runtime meaning, so it is a syntax error here.
  private readonly dir: string

  private constructor(dir: string) {
    this.dir = dir
  }

  static async open(bakeDir: string): Promise<CatalogReader | null> {
    const dir = join(bakeDir, 'catalog')
    const reader = new CatalogReader(dir)
    const seriesDir = join(dir, 'series')
    const files = await readdir(seriesDir).catch(() => null)
    if (files === null) return null
    for (const f of [...files].sort()) {
      if (!f.endsWith('.json')) continue
      const s = await readJson<{ seriesSlug: string; sets: { setId: string; name: string }[] }>(
        join(seriesDir, f),
        `catalog/series/${f}`,
        false,
      )
      if (s === null) continue
      for (const set of s.sets) {
        reader.seriesOf.set(set.setId, s.seriesSlug)
        reader.setName.set(set.setId, set.name)
      }
    }
    return reader
  }

  /** Every page of one set, or null when the catalog does not carry it. */
  async cards(setId: string): Promise<CatalogCard[] | null> {
    const held = this.shards.get(setId)
    if (held !== undefined) return held === null ? null : held.flatMap((s) => s.cards)
    const first = await readJson<SetShard>(join(this.dir, 'sets', `${setId}.json`), `catalog/sets/${setId}.json`, false)
    if (first === null) {
      this.shards.set(setId, null)
      return null
    }
    this.shardsRead++
    const pages = [first]
    for (let p = 2; p <= first.pageCount; p++) {
      const next = await readJson<SetShard>(
        join(this.dir, 'sets', `${setId}.p${p}.json`),
        `catalog/sets/${setId}.p${p}.json`,
        false,
      )
      if (next === null) break
      this.shardsRead++
      pages.push(next)
    }
    this.shards.set(setId, pages)
    return pages.flatMap((s) => s.cards)
  }

  async card(cardId: string): Promise<{ card: CatalogCard; setId: string } | null> {
    // Walk hyphens right-to-left: a promo's NUMBER can carry one
    // (`fxsp-FX-257`), so "everything before the last hyphen" names no shard.
    for (let cut = cardId.lastIndexOf('-'); cut > 0; cut = cardId.lastIndexOf('-', cut - 1)) {
      const setId = cardId.slice(0, cut)
      const cards = await this.cards(setId)
      const found = cards?.find((c) => c.cardId === cardId)
      if (found) return { card: found, setId }
    }
    return null
  }
}

/** Which foil class a variant kind + rarity lands in, in the assignment file's vocabulary. */
const FULL_FOIL_RARITY = /double rare|ultra rare|illustration rare|secret rare|hyper rare|rainbow rare|shiny rare/i
function classOf(kind: string, rarity: string | null): string {
  const k = kind.toLowerCase()
  if (k.includes('reverse')) return 'reverse'
  if (FULL_FOIL_RARITY.test(rarity ?? '')) return 'full-foil'
  if (k.includes('holo')) return 'holo'
  return 'normal'
}

export async function buildTaskQueue(root: string, bakeDir: string): Promise<BuildReport> {
  const dataDir = join(root, 'data')

  // ── Committed inputs: fatal if absent ─────────────────────────────────────
  const manifest = (await readJson<CorpusManifestShape>(
    join(dataDir, 'corpus-manifest.json'),
    'data/corpus-manifest.json',
    true,
  ))!
  const verdictsFile = (await readJson<VerdictsShape>(
    join(dataDir, 'verification-verdicts.json'),
    'data/verification-verdicts.json',
    true,
  ))!
  const assignments = (await readJson<AssignmentsShape>(
    join(dataDir, 'foil-card-assignments.json'),
    'data/foil-card-assignments.json',
    true,
  ))!

  // ── Baked inputs: tolerated if absent, always recorded ────────────────────
  const map = await readJson<VerificationMapShape>(
    join(bakeDir, 'foil-verification-map.json'),
    'foil-verification-map.json',
    false,
  )
  const patternCards = await readJson<PatternCardsShape>(
    join(bakeDir, 'foil-pattern-cards.json'),
    'foil-pattern-cards.json',
    false,
  )
  const catalog = await CatalogReader.open(bakeDir)

  const known = new Set(PATTERNS.map((p) => p.id))
  for (const v of verdictsFile.verdicts) {
    if (!known.has(v.patternId)) {
      fail(
        `data/verification-verdicts.json names '${v.patternId}', which is not an implemented pattern id. ` +
          'A verdict nothing can render is a finding, not a row.',
      )
    }
  }
  for (const id of Object.keys(patternCards?.diagnosis ?? {})) {
    if (!known.has(id)) {
      fail(`${bakeDir}/foil-pattern-cards.json diagnoses '${id}', which is not an implemented pattern id.`)
    }
  }

  const groups = map?.groups ?? []
  /** patternId → printings the resolver assigns it, summed over every group. */
  const printingsByPattern = new Map<string, number>()
  for (const g of groups) printingsByPattern.set(g.patternId, (printingsByPattern.get(g.patternId) ?? 0) + g.printings)
  /** (eraId, scope) → printings, the fallback when a card's exact group is not found. */
  const printingsByEraScope = new Map<string, number>()
  for (const g of groups) {
    const k = `${g.eraId}|${g.scope}`
    printingsByEraScope.set(k, (printingsByEraScope.get(k) ?? 0) + g.printings)
  }

  const tasks: Task[] = []
  const reconciliation: Reconciliation[] = []

  // ── 1. Approximations: recipes that are still standing in for another ─────
  //
  // DERIVED from PATTERNS, never from the doc: `implemented: false` plus an
  // `approxVia` label IS the machine-readable form of "approximated", and
  // docs/SHADER-CONTRACT.md:294-295 says so itself ("To ship a real recipe:
  // write the GLSL, flip the entry to `implemented: true`, drop `approxVia`").
  const approximations = PATTERNS.filter((p) => p.implemented === false).map((p) => p.id).sort()
  for (const id of approximations) {
    const p = PATTERNS.find((x) => x.id === id)!
    const impact = printingsByPattern.get(id) ?? null
    tasks.push({
      id: `approximation:${id}`,
      type: 'approximation',
      title: `Write a real recipe for ${p.label}`,
      need:
        `${p.label} has no faithful recipe — it renders through ${p.approxVia ?? 'another recipe'} and says so on ` +
        `every surface. It models: ${p.taxonomy}. Used on: ${p.usedOn}`,
      skill: 'glsl',
      estimate: 'hours',
      estimateWhy: 'A new recipe is GLSL plus a judging round; the four that shipped in R3-MISC each took one to three rounds.',
      impact,
      impactWhy:
        impact === null
          ? 'No group in this bake resolves to this pattern, so there is nothing to count.'
          : 'Printings the resolver already assigns to this pattern — every one of them renders the stand-in today.',
      link: `/canon?pattern=${encodeURIComponent(id)}`,
      source: 'packages/patterns/src/patterns.ts — PATTERNS[].implemented === false, approxVia',
      guards: [],
      tieBreak: 0,
      detail: {
        approxVia: p.approxVia ?? null,
        taxonomy: p.taxonomy,
        family: p.family,
      },
    })
  }
  reconciliation.push({
    key: 'approximations',
    claim:
      `${CLAIMED_APPROXIMATIONS.length} taxonomy type${CLAIMED_APPROXIMATIONS.length === 1 ? '' : 's'} still ` +
      `approximated with no catalog exemplar: ${CLAIMED_APPROXIMATIONS.join(', ')}`,
    claimedAt: CLAIMED_APPROXIMATIONS_AT,
    measured:
      approximations.length === 0
        ? 'every implemented pattern carries its own recipe'
        : `${approximations.length}: ${approximations.join(', ')}`,
    agrees:
      approximations.length === CLAIMED_APPROXIMATIONS.length &&
      approximations.every((id, i) => id === CLAIMED_APPROXIMATIONS[i]),
    note:
      'FIXED 2026-09-06: the R3 list was originally five. Four of them (sequin, tcg-classic, acid-wash, disco) ' +
      'shipped dedicated recipes in the R3-MISC wave — docs/VERIFICATION.md:840-843, "12/12 final yay" — and ' +
      'docs/SHADER-CONTRACT.md:290-295 now carries a correction at the same site rather than the stale count. The ' +
      'code is still the enforceable form; the doc and the code agree today. Note that the R3-MISC passage also ' +
      'claims "zero approxVia fallbacks remain in the library", which the code refutes: big-glitter still carries one.',
  })

  // ── 2. Canon-less patterns ────────────────────────────────────────────────
  //
  // A DIFFERENT AXIS from #1, and conflating them is the mistake this section
  // exists to prevent. "Approximated" means the GLSL stands in for another
  // process; "canon-less" means nobody has saved a uniform snapshot, so the
  // recipe inherits whatever the code defaults say at read time. big-glitter is
  // approximated AND canon'd; acid-wash is canon-less AND has a real recipe.
  for (const id of manifest.uncanoned) {
    const impact = printingsByPattern.get(id) ?? null
    const p = PATTERNS.find((x) => x.id === id)
    tasks.push({
      id: `canon:${id}`,
      type: 'canon',
      title: `Freeze a canon for ${p?.label ?? id}`,
      need:
        'No canon file exists, so this pattern renders whatever the code defaults happen to be. Open it in the ' +
        'canon lab, tilt it against the reference, move the dials until it matches, and save. The saved snapshot ' +
        'becomes the pattern truth every card inherits.',
      skill: 'slider',
      estimate: 'half-hour',
      estimateWhy: 'The dials are live and the reference is on screen; this is one tuning pass, not new machinery.',
      impact,
      impactWhy:
        impact === null
          ? 'No group in this bake resolves to this pattern, so there is nothing to count.'
          : 'Printings the resolver assigns to this pattern — all of them render the code default until a canon exists.',
      link: `/canon?pattern=${encodeURIComponent(id)}`,
      source: 'data/corpus-manifest.json — uncanoned[] (PATTERNS minus data/foil-canon/*.json, derived)',
      guards: [],
      tieBreak: 0,
      detail: { hasRealRecipe: p?.implemented ?? false },
    })
  }
  reconciliation.push({
    key: 'uncanoned',
    claim: '13 patterns carry no canon file (subtask 5)',
    // docs/HOSTED-EDITOR.md:195-200 is the CORRECTION ("The number is 12, not
    // 13"), not a site that still claims 13 — citing it as claimedAt pointed a
    // reader at the fix instead of the claim. Nothing in docs/ still asserts
    // 13 as live; the only place it survives is as history, in DECISIONS.md.
    // Cite the most recent entry that restates it, and say so.
    claimedAt: 'DECISIONS.md:2062-2065 (2026-09-06, historical record — the doc claim itself was corrected at docs/HOSTED-EDITOR.md:195-200)',
    measured: `${manifest.uncanoned.length}: ${manifest.uncanoned.join(', ')}`,
    agrees: manifest.uncanoned.length === 13,
    note:
      'The manifest derives the list rather than trusting the count, and 13 counted `none`, the no-foil recipe, ' +
      'which has no canon by definition. This is NOT the same list as the approximations above: canon-less is ' +
      'about a saved uniform snapshot, approximated is about the GLSL. Three slugs (acid-wash, disco, tcg-classic) ' +
      'appear on both lists for unrelated reasons.',
  })

  // ── 3. Standing verification nays ─────────────────────────────────────────
  const standing = verdictsFile.verdicts.filter((v) => v.standing && v.verdict === 'nay')
  for (const v of [...standing].sort((a, b) => a.patternId.localeCompare(b.patternId))) {
    const p = PATTERNS.find((x) => x.id === v.patternId)
    const impact = printingsByPattern.get(v.patternId) ?? null
    const skill: Skill = v.ask === 'live-tilt' ? 'live-tilt' : v.ask === 'glsl' ? 'glsl' : 'research'
    tasks.push({
      id: `verdict:${v.patternId}`,
      type: 'verdict',
      title:
        skill === 'live-tilt'
          ? `Tilt ${p?.label ?? v.patternId} and record a verdict`
          : `Close the standing nay on ${p?.label ?? v.patternId}`,
      need: v.askDetail ?? v.judgeNote,
      skill,
      estimate: skill === 'live-tilt' ? 'minutes' : 'hours',
      estimateWhy:
        skill === 'live-tilt'
          ? 'Open the canon lab, tilt the card, write one sentence. The instrument is your eye, and it is already calibrated.'
          : 'This nay names a missing asset or a shader change, which is new work rather than a judgement.',
      impact,
      impactWhy:
        impact === null
          ? 'No group in this bake resolves to this pattern, so there is nothing to count.'
          : 'Printings rendering this recipe — the verdict decides whether they are right.',
      link: `/canon?pattern=${encodeURIComponent(v.patternId)}`,
      source: `data/verification-verdicts.json — verdicts[] (extracted from ${v.docLines})`,
      // Keyed on ASK, not on stillFrameBlind: a still-frame-blind pattern whose
      // ask is GLSL (energy-symbols — the residual is an icon atlas, not a
      // motion claim) is a structural PAIR, not a single live-tilt row. The
      // full guard belongs only to the live-tilt ask; the GLSL ask gets a
      // softer note that the motion half is a separate, still-open dimension.
      guards: v.ask === 'live-tilt' ? ['live-tilt-not-glsl'] : v.ask === 'glsl' && v.stillFrameBlind ? ['motion-half-needs-tilt'] : [],
      tieBreak: 0,
      detail: {
        wave: v.wave,
        judgedOn: v.judgedOn,
        score: v.score ?? null,
        judgeNote: v.judgeNote,
        residual: v.residual,
        stillFrameBlind: v.stillFrameBlind,
        stillFrameNote: v.stillFrameNote,
        docLines: v.docLines,
      },
    })
  }
  const standingIds = standing.map((v) => v.patternId).sort()
  const broken = verdictsFile.verdicts.filter((v) => !v.standing).map((v) => v.patternId).sort()
  reconciliation.push({
    key: 'standing-nays',
    claim: `${CLAIMED_STANDING_NAYS.length} standing nays: ${CLAIMED_STANDING_NAYS.join(', ')}`,
    claimedAt: CLAIMED_STANDING_NAYS_AT,
    measured: `${standingIds.length}: ${standingIds.join(', ')}`,
    agrees:
      standingIds.length === CLAIMED_STANDING_NAYS.length &&
      standingIds.every((id, i) => id === CLAIMED_STANDING_NAYS[i]),
    note:
      `FIXED 2026-09-06: two of the original four were broken by later waves (${broken.join(', ')}) and three new ` +
      'nays were recorded in R3-MOTION and R3-GLYPH. VERIFICATION.md now carries a correction at the same site ' +
      '(:73) restating the standing set as five, and data/verification-verdicts.json is the machine-readable form ' +
      'of that restatement — see its $supersededClaim block for the line numbers.',
  })

  // ── 4. Machine masks nobody has corrected ─────────────────────────────────
  //
  // Ranked by DIVERGENCE, which is 1 − diff.agreement: the Jaccard overlap
  // between the machine's mask and the era rule it was seeded from. A low
  // agreement means the era rule and the generator disagreed about where the
  // foil is, and one of them is wrong — which is precisely the printing where
  // a human tracing teaches the most. Coverage is not evidence: these records
  // exist, and selectExemplars rejects every one of them.
  interface MaskRow {
    cardId: string
    scope: string
    rec: ManifestMaskRecord
  }
  const noHand: MaskRow[] = []
  for (const [unitKey, variantId] of Object.entries(manifest.maskUnits)) {
    const cardId = unitKey.slice(0, unitKey.lastIndexOf('|'))
    const scope = unitKey.slice(unitKey.lastIndexOf('|') + 1)
    const rec = manifest.masks[cardId]?.[String(variantId)]
    if (!rec) {
      fail(
        `data/corpus-manifest.json maskUnits["${unitKey}"] points at variant ${variantId}, which masks["${cardId}"] ` +
          'does not carry. The manifest is internally inconsistent — rebuild it.',
      )
    }
    if (rec.reviewStatus === 'human-authored') continue
    noHand.push({ cardId, scope, rec })
  }
  // Most divergent first; a tie falls to the card id so the order is stable.
  noHand.sort((a, b) => (a.rec.agreement ?? 1) - (b.rec.agreement ?? 1) || a.cardId.localeCompare(b.cardId))

  for (const row of noHand) {
    const found = catalog === null ? null : await catalog.card(row.cardId)
    let impact: number | null = null
    let impactWhy = 'This bake carries no catalog, so the group this card teaches cannot be sized.'
    let patternId: string | null = null
    if (found !== null && catalog !== null) {
      const variant = found.card.variants.find((v) => v.variantId === row.rec.variantId) ?? found.card.variants[0]
      const seriesSlug = catalog.seriesOf.get(found.setId) ?? ''
      const guess = resolveFoil({
        seriesSlug,
        rarity: found.card.rarity,
        variantKind: variant?.kind ?? null,
        setId: found.setId,
        setName: catalog.setName.get(found.setId) ?? null,
        cardName: found.card.name,
        cardId: found.card.cardId,
      })
      patternId = guess.patternId
      const exact = groups.find(
        (g) => g.patternId === guess.patternId && g.scope === guess.scope && g.eraId === guess.eraId,
      )
      if (exact) {
        impact = exact.printings
        impactWhy = `Printings in ${exact.key} — the group this card's mask would become evidence for.`
      } else {
        const fallback = printingsByEraScope.get(`${row.rec.eraId}|${row.scope}`)
        if (fallback !== undefined) {
          impact = fallback
          impactWhy = `No group matches this printing exactly, so this is every ${row.rec.eraId} ${row.scope} printing in the bake.`
        }
      }
    }
    const divergence = row.rec.agreement === null ? null : Number((1 - row.rec.agreement).toFixed(4))
    tasks.push({
      id: `mask:${row.cardId}|${row.scope}`,
      type: 'mask',
      title: `Draw the foil zone on ${found?.card.name ?? row.cardId}`,
      need:
        `A machine put a ${row.scope}-scope mask on this printing and nobody has corrected it, so it carries no ` +
        `exemplar weight — the generator cannot learn from its own output. Its overlap with the ${row.rec.eraId} ` +
        `era rule is ${row.rec.agreement === null ? 'unrecorded' : `${(row.rec.agreement * 100).toFixed(1)}%`}` +
        ', which is how far apart the two guesses are.',
      skill: 'mask',
      estimate: 'half-hour',
      estimateWhy: 'The AI proposal is already on the canvas; this is correction with a brush, not tracing from nothing.',
      impact,
      impactWhy,
      link: `/card?id=${encodeURIComponent(row.cardId)}&v=${row.rec.variantId}`,
      source: 'data/corpus-manifest.json — masks[].agreement (sidecar diff.agreement, Jaccard) where reviewStatus !== human-authored',
      guards: [],
      // Divergence, so the most-disagreeing mask leads its own section even
      // though every Base Set holo shares one rule group and one impact number.
      tieBreak: divergence ?? 0,
      detail: {
        cardId: row.cardId,
        variantId: row.rec.variantId,
        scope: row.scope,
        eraId: row.rec.eraId,
        method: row.rec.method,
        tier: row.rec.tier,
        agreement: row.rec.agreement,
        divergence,
        patternId,
        setName: found === null || catalog === null ? null : (catalog.setName.get(found.setId) ?? null),
      },
    })
  }

  // ── 5. Window-scope groups with no exemplar at all ────────────────────────
  //
  // Subtask 3's backlog, read off the map rather than off a doc: a window-scope
  // rule with zero admissible exemplars is a rule nothing human has ever
  // checked. Distinct from #4, which is about a mask that EXISTS and is
  // unreviewed; here there is nothing at all, and the first mask in the group
  // is a from-scratch trace.
  const windowGroups = groups
    .filter((g) => g.scope === 'window' && g.exemplars === 0)
    .sort((a, b) => b.leverage - a.leverage || a.key.localeCompare(b.key))
  for (const g of windowGroups) {
    tasks.push({
      id: `window-mask:${g.key}`,
      type: 'window-mask',
      title: `Trace the first art window for ${g.patternId} (${g.eraId})`,
      need:
        `${g.printings.toLocaleString()} printings resolve to this rule at window scope and not one of them carries ` +
        'an admissible exemplar. The first hand mask here becomes the seed the generator refits against, and the ' +
        'whole group improves at once through the supersedes path.',
      skill: 'mask',
      estimate: 'hours',
      estimateWhy:
        'Nothing is on the canvas to correct. The art window is quick; the subject silhouette is the part that ' +
        'takes the time, and it is where the measured region-learn error is worst.',
      impact: g.printings,
      impactWhy: 'Printings governed by this rule group, straight off the verification map.',
      link: null,
      source: 'foil-verification-map.json — groups[] where scope === "window" && exemplars === 0',
      guards: [],
      tieBreak: 0,
      detail: {
        groupKey: g.key,
        eraId: g.eraId,
        patternId: g.patternId,
        match: g.match,
        distinctCards: g.distinctCards,
        leverage: Math.round(g.leverage),
        maskCoveredCards: g.maskCoveredCards,
      },
    })
  }

  // ── 6. Untargeted research residuals ──────────────────────────────────────
  //
  // A residual is a claim the research swarm RECORDED and could not target: it
  // knows a subset of a set uses a different pattern and cannot name the cards.
  // Closing one is citation work, and it edits the assignment file, so every
  // one of these carries the needs-a-bake guard.
  const openResiduals = assignments.known_residuals.filter((r) => r.resolved === undefined)
  for (const r of openResiduals) {
    const setId = r.setId ?? null
    const cls = r.cls ?? null
    let impact: number | null = null
    let impactWhy = 'This residual names no set, so there is nothing in the catalog to size it against.'
    let sample: string | null = null
    if (setId !== null && catalog !== null) {
      const cards = await catalog.cards(setId)
      if (cards === null) {
        impactWhy = `This bake's catalog does not carry ${setId}, so the affected printings cannot be counted.`
      } else {
        let n = 0
        for (const c of cards) {
          for (const v of c.variants) {
            if (cls === null || classOf(v.kind, c.rarity) === cls) {
              n++
              sample ??= `${c.cardId}|${v.variantId}`
            }
          }
        }
        impact = n
        impactWhy = `Printings in ${setId} matching class "${cls ?? 'any'}" — the rows this residual over- or under-covers.`
      }
    }
    const idBase = `${r.lane}:${setId ?? 'none'}:${cls ?? 'none'}`
    const [linkCard, linkVariant] = (sample ?? '|').split('|')
    tasks.push({
      id: `residual:${idBase}`,
      type: 'residual',
      title:
        setId === null
          ? `Find a vocabulary slug for the ${r.lane} residual`
          : `Name the cards behind the ${[setId, cls].filter((x) => x !== null).join(' ')} residual`,
      need: r.reason,
      skill: 'research',
      estimate: 'hours',
      estimateWhy:
        'The blocker is a source that names cards. The swarm already looked; closing one means finding something it ' +
        'did not have, or deriving the list from catalog data it now does.',
      impact,
      impactWhy,
      link: sample === null || linkCard === '' ? null : `/card?id=${encodeURIComponent(linkCard!)}&v=${linkVariant}`,
      source: 'data/foil-card-assignments.json — known_residuals[] with no `resolved` field',
      guards: ['needs-a-bake'],
      tieBreak: 0,
      detail: {
        lane: r.lane,
        setId,
        cls,
        setName: setId === null || catalog === null ? null : (catalog.setName.get(setId) ?? null),
      },
    })
  }
  const resolvedResiduals = assignments.known_residuals.filter((r) => r.resolved !== undefined)
  const sheenRows = assignments.rows.filter((r) => r.pattern === 'vertical-sheen-rainbow' && (r.sel.cardIds?.length ?? 0) > 0)
  reconciliation.push({
    key: 'residuals',
    claim:
      'two residuals were closable from the catalog in one query — the six Holo Rare basic Energies of ex13 and ex16 ' +
      'resolve to vertical-sheen-rainbow',
    claimedAt: 'the step-11 plan; the residual rows themselves at data/foil-card-assignments.json known_residuals[2] and [4]',
    measured:
      `${assignments.known_residuals.length} residuals recorded, ${resolvedResiduals.length} closed, ` +
      `${openResiduals.length} open. The ex13/ex16 closure is already committed: ${sheenRows.length} cardIds row(s) ` +
      `assign vertical-sheen-rainbow, covering ${sheenRows.reduce((n, r) => n + (r.sel.cardIds?.length ?? 0), 0)} cards.`,
    agrees: sheenRows.length === 2,
    note:
      'Closed on 2026-08-08 in the R7 pass, before this queue existed — both residuals carry a `resolved` field ' +
      'naming the exact card ids. The ex13 half is marked partial: the Cosmos Ultra/Secret Rare half of that set is ' +
      'still open and is queued above.',
  })

  // ── The empty-pool diagnosis, rendered verbatim ───────────────────────────
  const emptyPools: EmptyPool[] = []
  for (const [patternId, d] of Object.entries(patternCards?.diagnosis ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const label = PATTERNS.find((p) => p.id === patternId)?.label ?? patternId
    const implies = CAUSE_IMPLIES[d.reason]
    if (implies === undefined) {
      fail(
        `${bakeDir}/foil-pattern-cards.json diagnoses '${patternId}' with reason '${d.reason}', which this builder ` +
          'has no contribution for. A new cause is a new kind of work — add it to CAUSE_IMPLIES rather than ' +
          'letting it render as a bare label.',
      )
    }
    emptyPools.push({
      patternId,
      reason: d.reason,
      detail: d.detail,
      citedPrintings: d.citedPrintings,
      alternates: d.alternates,
      outrankedBy: (d.outrankedBy ?? []).map(([p, n]) => ({ patternId: p, printings: n })),
      implies,
    })
    tasks.push({
      id: `empty-pool:${patternId}`,
      type: 'empty-pool',
      // One title per CAUSE, because the four causes are four different jobs
      // and a shared title ("find a printing") describes only one of them.
      title:
        d.reason === 'outranked'
          ? `Decide whether ${label} needs a citation of its own`
          : d.reason === 'no-cited-rows'
            ? `Cite the first printing that carries ${label}`
            : `Record the catalog gap behind ${label}`,
      need: `${d.detail} ${implies}`,
      skill: 'research',
      estimate: d.reason === 'outranked' ? 'half-hour' : 'hours',
      estimateWhy:
        d.reason === 'outranked'
          ? 'Read the two cited rows and decide whether they describe different physical layers of the same card. Usually they do, and the answer is "nothing to fix".'
          : 'Nothing in this repository can close it — the work is finding or importing the upstream data.',
      // NOT citedPrintings, and the difference is the whole guard. For
      // `outranked`, 1,818 printings ARE named by a cited row for this pattern
      // — and a higher-ranked row legitimately wins every one of them, so
      // closing this moves nothing unless a NEW source turns up, and how much
      // is unknowable until it does. Ranking the card by 1,818 would put
      // "usually nothing to fix" above a mask that really does move 1,624
      // printings, and would read as an invitation to go and win them back.
      // The number stays on the card as detail; it is not the impact.
      impact: d.reason === 'outranked' ? null : 0,
      impactWhy:
        d.reason === 'outranked'
          ? `Not sizeable: ${d.citedPrintings.toLocaleString()} printings are named by a cited row for this pattern, ` +
            'and a higher-ranked row legitimately wins each one. A new source would move an unknown number; ' +
            're-ranking the existing ones moves none, and is the documented wrong move.'
          : 'Zero, and that is the finding: no printing in this catalog can reach this recipe at all.',
      link: `/canon?pattern=${encodeURIComponent(patternId)}`,
      source: 'foil-pattern-cards.json — diagnosis[] (the bake emits it; this renders it verbatim)',
      guards: d.reason === 'outranked' ? ['do-not-flip-winners'] : [],
      tieBreak: 0,
      detail: {
        reason: d.reason,
        alternates: d.alternates,
        citedPrintings: d.citedPrintings,
        outranked: (d.outrankedBy ?? []).map(([p, n]) => `${p} (${n})`).join(', ') || null,
      },
    })
  }

  // ── Sort by IMPACT, and say so ────────────────────────────────────────────
  //
  // Descending printings, unsized cards LAST (null is "not measurable in this
  // bake", not "zero"), ties broken by id so two builds of the same data
  // produce the same bytes.
  tasks.sort((a, b) => {
    if (a.impact === null && b.impact !== null) return 1
    if (b.impact === null && a.impact !== null) return -1
    if (a.impact !== null && b.impact !== null && a.impact !== b.impact) return b.impact - a.impact
    if (a.tieBreak !== b.tieBreak) return b.tieBreak - a.tieBreak
    return a.id.localeCompare(b.id)
  })

  const byType: Record<string, number> = {}
  const bySkill: Record<string, number> = {}
  for (const t of tasks) {
    byType[t.type] = (byType[t.type] ?? 0) + 1
    bySkill[t.skill] = (bySkill[t.skill] ?? 0) + 1
  }

  // `generatedAt` is the NEWEST stamp the INPUTS carry, never a clock reading —
  // same rule as the corpus manifest, and for the same reason: `--check` is
  // CI's only proof the committed file matches the data, and it can only say
  // that if the same inputs serialize to the same bytes.
  const stamps = [manifest.generatedAt, map?.generatedAt, patternCards?.generatedAt].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  const generatedAt = [...stamps].sort().at(-1) ?? '1970-01-01T00:00:00.000Z'

  const queue: TaskQueue = {
    version: 1,
    generatedAt,
    source: map?.source ?? null,
    resolverVersion: map?.resolverVersion ?? null,
    countingUnits: COUNTING_UNITS,
    skills: SKILLS,
    guards: GUARDS,
    estimateTiers: ESTIMATE_TIERS,
    bakedInputs: {
      'foil-verification-map.json': map !== null,
      'foil-pattern-cards.json': patternCards !== null,
      catalog: catalog !== null,
    },
    counts: {
      tasks: tasks.length,
      byType,
      bySkill,
      impactTotal: tasks.reduce((n, t) => n + (t.impact ?? 0), 0),
      unsized: tasks.filter((t) => t.impact === null).length,
    },
    reconciliation,
    emptyPools,
    tasks,
  }

  return {
    queue,
    findings: reconciliation.filter((r) => !r.agrees),
    shardsRead: catalog?.shardsRead ?? 0,
  }
}

// ── Serialization ──────────────────────────────────────────────────────────
//
// Object keys are NOT sorted here, unlike the corpus manifest: a task card is
// read top-to-bottom by a human in a diff, and `id, type, title, need` in that
// order is the sentence. Determinism comes from the sort above and from
// `generatedAt` being derived rather than clocked, which is what `--check`
// actually needs.

export function serializeQueue(queue: TaskQueue): string {
  return JSON.stringify(queue, null, 2) + '\n'
}

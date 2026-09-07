// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// foil/ink.ts — the REVERSE-HOLO DESIGN resolver (R8-INK, 2026-09-07).
//
// `resolveFoil` answers "which foil sheet is under this printing". This answers
// a second, orthogonal question the 43-type taxonomy conflates with it: "which
// DESIGN is printed on top of that sheet, blocking it".
//
// Why they cannot be one function. The foil is embossed micro-texture in
// aluminium — physical, so a procedural GLSL recipe converges on it and
// packages/patterns is its correct home. The design is opaque ink laid over the
// sheet: an artist's layout from TPCi. Procedural will never converge on that,
// because there is nothing to converge to. Sceptile and Magneton, and a dozen
// other visually different reverses, sit on the SAME vertical-sheen sheet. The
// resolver already half-knew this and threw the knowledge away: both of its
// tiers carry a `penaltyOf` that demotes `mirror` rows on reverses because the
// research corpus records them as "ink-design evidence, not foil evidence"
// (resolver.ts, and data/foil-pattern-usage.json's own note). This module is
// where that evidence goes instead of being discarded.
//
// KEYING is (scope, type, variantKind) with RARITY joining it, resolving
//   card > subset > set > era
// — the same most-specific-wins shape as `lookupAssignment`, and for the same
// reason. It is deliberately NOT (era, type):
//   * Prismatic Evolutions ships THREE reverses of one card (standard, Poke
//     Ball, Master Ball) on one sheet, distinguished only by variant kind.
//   * Black Bolt and White Flare do the same; Ascended Heroes carries SIX.
//   * The Plasma sets substitute a Team Plasma shield for the type symbol on
//     Team Plasma cards only.
//   * EX Emerald -> EX Power Keepers gate gold name / gold HP / silver rarity
//     symbol on RARITY, differently per set, and EX Crystal Guardians gates it
//     on three named cards (3b's era-research.md, section 4).
// Every one of those is invisible to a key without variantKind, and the last
// two are invisible to a key without rarity and without a card tier.
//
// OPTIONAL BY CONSTRUCTION, like the rest of this package: nothing in
// @foilkit/core or @foilkit/patterns imports it, and a renderer that never
// calls it renders exactly what it rendered before — `uInkOn` stays 0.

import inkIndex from './ink-index.json' with { type: 'json' }
import layouts from './era-layouts.json' with { type: 'json' }

/** Bumped when the ink keying or the registry's meaning changes. */
export const INK_RESOLVER_VERSION = 1

/**
 * What data/frames.json's `shows` says about an image source: does the raster
 * already carry the reverse printing?
 *
 * `unknown` is the value on all 24 records today, and frames.json's own $doc is
 * explicit that this is the finding rather than an unfilled field — derived,
 * never claimed. It also sets the rule this module obeys: **only a MEASURED
 * `reverse` may suppress the overlay.**
 */
export type FrameShows = 'normal' | 'reverse' | 'unknown'

export interface InkPlacement {
  /** Tiles across the card WIDTH — a period a human can measure off a scan. */
  across: number
  /** Lattice phase, in cells. */
  phaseX: number
  phaseY: number
  /** Lattice rotation about the card centre, in turns. */
  turns: number
  /** Per-cell positional jitter, in cell fractions. */
  jitter: number
  /** Odd-row x offset in cells: 0 = square grid, 0.5 = brick. */
  stagger: number
  /** How completely the ink blocks the foil beneath it, 0..1. */
  strength: number
  /** How far the ink lifts the blocked field toward paper white, 0..1. */
  tone: number
}

export interface InkDesignRef {
  /**
   * The tile to draw, or null. Null has THREE distinct causes and `state` says
   * which — a caller that treats them the same will report a queued trademark
   * as "no design here", which is the exact confusion this tier exists to end.
   */
  tileId: string | null
  /** Where `tileId` lives, relative to the repository root. Null when tileId is. */
  tileFile: string | null
  /**
   * `design`  — a tile resolved and should be drawn.
   * `queued`  — a row matched, but its tile is a trademarked mark we may not
   *             trace (data/ink-tiles/INK-TILES-NOTICE.md). The slot is empty
   *             ON PURPOSE; the recipe renders its procedural fallback and the
   *             task queue carries the work.
   * `no-ink`  — a row matched and its recorded DECISION is that this printing
   *             needs no ink tile at all: the reverse treatment is real but it
   *             is not a repeated overprint (Legendary Collection's Fireworks
   *             is foil across the whole face, with the artwork ink unchanged).
   *             The third cause of a null `tileId`, and the one that must not
   *             be reported as `queued` — nobody is waiting on a drawing.
   * `none`    — no row matched this key at all. Not a reverse, or an era
   *             nobody has keyed yet. NOTHING IS DRAWN and the recipe keeps its
   *             stand-in: an unkeyed series must never inherit another era's
   *             design, which is the drawn-from-nothing defect this tier was
   *             built to end.
   * `in-scan` — a row matched AND its tile exists, but the image source is
   *             MEASURED as already showing the reverse printing, so drawing
   *             it would double it and misregister it.
   */
  state: 'design' | 'queued' | 'no-ink' | 'none' | 'in-scan'
  /** The queued mark's id when `state` is 'queued'; null otherwise. */
  queued: string | null
  placement: InkPlacement
  /** Which tier answered — the same ladder shape as FoilGuess.match. */
  match: 'card' | 'subset' | 'set' | 'era' | 'none'
  /** The scope id that answered (a cardId, subset id, setId or eraId). */
  scope: string | null
  confidence: 'high' | 'medium' | 'low' | null
  /** 3b's scan-diff class for this key: null | frame | full. */
  delta: 'null' | 'frame' | 'full' | null
  sources: string[]
  /**
   * The two shader gates, so a surface never has to re-derive them:
   * uInkOn = the design tier owns this card's design layer (recipes stop
   * guessing); uInkDraw = actually draw the tile.
   */
  uInkOn: boolean
  uInkDraw: boolean
}

interface IndexRow {
  scope: string
  kind: 'card' | 'subset' | 'set' | 'era'
  types: string[] | null
  kinds: string[] | null
  rar: string[] | null
  cards: string[] | null
  tile: string | null
  queued: string | null
  /** A recorded decision that this row needs NO ink tile. Never with `queued`. */
  noInk: boolean
  pl: number[]
  delta: 'null' | 'frame' | 'full'
  conf: 'high' | 'medium' | 'low'
  src: string[]
}

const ROWS = inkIndex.rows as IndexRow[]
const TILES = inkIndex.tiles as Record<
  string,
  { file: string; across: number; n: number; conf: string | null; seam: number }
>
const FRAME_SHOWS = inkIndex.frameShows as Record<string, string>
const PLACEMENT_KEYS = inkIndex.placementKeys as (keyof InkPlacement)[]

/**
 * Series slug -> era id, and it is DELIBERATELY PARTIAL.
 *
 * `era-layouts.json` carries the three eras whose art window somebody actually
 * measured — wotc, modern-swsh, modern-sv — over eight of the catalog's
 * twenty-one series. The other thirteen (ex, xy, sun-moon, diamond-pearl,
 * platinum, hgss, black-white, pop, trainer-kits, …) have no measured era here
 * and therefore NO ERA ROW that could speak for them.
 *
 * This map used to end in `?? 'modern-sv'`, which handed every one of those
 * thirteen — 6,963 of the catalog's 13,165 reverse printings, 52.9% — the
 * Scarlet & Violet dot grid at strength 0.8, on no evidence whatsoever. That is
 * the drawn-from-nothing defect this whole tier exists to end, reborn one
 * layer up: an unmeasured design drawn at full strength over half the corpus.
 *
 * So an unmapped series resolves to NO era, matches no era row, and — absent a
 * set or card row — comes back `state: 'none'` with nothing drawn and the
 * recipe's own stand-in intact, which is what the module's doc said all along.
 * Set-scoped rows still answer for those series: `ex8` and `ex11` are keyed by
 * SET, and the `ex` series needs no era mapping to reach them.
 *
 * A new mapping belongs here only when a row exists to serve it. Adding one to
 * `era-layouts.json` is not a free edit either: that file is the FOIL
 * resolver's art-window table, and a slug added for the ink tier's benefit
 * would silently move foil geometry too.
 */
const ERA_BY_SERIES: Record<string, string> = {}
for (const [eraId, era] of Object.entries(layouts.eras)) {
  for (const slug of era.seriesSlugs) ERA_BY_SERIES[slug] = eraId
}

const CONF_RANK = { high: 2, medium: 1, low: 0 } as const

/** Placement with every dial inert — what a caller gets when nothing matched. */
export const INERT_PLACEMENT: InkPlacement = {
  across: 11,
  phaseX: 0,
  phaseY: 0,
  turns: 0,
  jitter: 0,
  stagger: 0,
  strength: 0,
  tone: 0,
}

function toPlacement(pl: number[]): InkPlacement {
  const out = { ...INERT_PLACEMENT }
  PLACEMENT_KEYS.forEach((k, i) => {
    out[k] = pl[i]!
  })
  return out
}

const NO_INK: InkDesignRef = {
  tileId: null,
  tileFile: null,
  state: 'none',
  queued: null,
  placement: INERT_PLACEMENT,
  match: 'none',
  scope: null,
  confidence: null,
  delta: null,
  sources: [],
  uInkOn: false,
  uInkDraw: false,
}

/**
 * Which tiers a row can claim, most specific first. `subset` outranks `set`
 * because a subset lives inside one — Radiant Collection inside bw11, the
 * Shiny Vault inside sma — and the assignment table already needed two escape
 * hatches (a per-row scope override and a card-only 'normal' class) to say
 * that with a flat set tier. Here it is a tier.
 *
 * SCALED BY 100 so the TIER STRICTLY DOMINATES. The bonuses below are worth 7
 * together, and the weights used to be 24/16/8/1 — so an era row carrying all
 * three (4 + 2 + 1) reached 8 and TIED a bare set row at 8, after which the
 * order fell through to confidence. A high-confidence era row would then have
 * beaten a low-confidence SET row for the same printing, which inverts the
 * whole ladder: the tiers are a statement about specificity, and a confidence
 * grade is a statement about evidence quality. They are not comparable, and the
 * first must never be settled by the second.
 *
 * No row in the registry reaches that combination today. That is why this was
 * latent rather than broken, and it is exactly the kind of thing that ships the
 * day somebody adds a rarity gate to an era row.
 */
const SCOPE_WEIGHT: Record<IndexRow['kind'], number> = { card: 2400, subset: 1600, set: 800, era: 100 }

/**
 * A row's specificity score: its TIER, plus a small bonus per axis it names.
 *
 * Exported for the test that pins the inversion above — the registry cannot
 * currently produce the tying pair, so the only honest way to test the rule is
 * to score the pair directly.
 */
export function inkRowScore(row: {
  kind: IndexRow['kind']
  kinds: readonly string[] | null
  types: readonly string[] | null
  rar: readonly string[] | null
}): number {
  return SCOPE_WEIGHT[row.kind] + (row.kinds ? 4 : 0) + (row.types ? 2 : 0) + (row.rar ? 1 : 0)
}

/**
 * The rarity gate, and it matches a WHOLE rarity rather than a substring.
 *
 * `rarity.includes('rare')` is true of "Ultra Rare", "Secret Rare", "Radiant
 * Rare", "ACE SPEC Rare", "Rare Holo LV.X" and eleven more strings this catalog
 * actually carries — so a row that named `rare` to mean the plain Rare quietly
 * claimed every one of them. The gate exists to prove rarity belongs in the key
 * (EX Delta Species gives its Rares gold name and gold HP and the Uncommon
 * none of it); a gate that matches nearly everything proves nothing.
 *
 * Whitespace is collapsed on both sides so a catalog that writes "Holo  Rare"
 * is not a different rarity from one that writes "Holo Rare". Spelling
 * variants are the REGISTRY's job to list — this catalog carries both "Holo
 * Rare" and "Rare Holo" — because an explicit list is reviewable and a fuzzy
 * match is not.
 */
const normRarity = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Resolve the ink design for one printing.
 *
 * `shows` is what data/frames.json says about the IMAGE the compositor is about
 * to draw over. Omit it and it defaults to `unknown`, which DRAWS — the safe
 * reading given every catalog scan is the normal printing per the TCGdex
 * convention (one image per card, serving every variant), and the reading
 * frames.json's own rule requires: only a MEASURED `reverse` may suppress.
 * That assumption is documented in data/ink-designs.json's `frameShows` block
 * along with the n = 7 measurement behind it, and the per-frame override that
 * beats it.
 */
export function resolveInk(input: {
  seriesSlug: string
  variantKind: string | null
  rarity?: string | null
  /** The Pokemon's energy type, for the Energy Pattern eras. */
  type?: string | null
  setId?: string | null
  cardId?: string | null
  /** data/frames.json `shows` for the image being drawn over. */
  shows?: FrameShows | null
  /** The frames.json record id, so the human override map can answer. */
  frameId?: string | null
}): InkDesignRef {
  const kind = (input.variantKind ?? '').toLowerCase()
  // The design tier is about reverse printings. A holo or a full-art has ink on
  // it too, but it is the card's own art, not a repeated overprint, and this
  // schema would be lying about it.
  if (!kind.includes('reverse')) return NO_INK

  // NO FALLBACK ERA. A series nobody has keyed gets `null`, matches no era row,
  // and — with no set or card row to answer — comes back `none`. See
  // ERA_BY_SERIES: the `?? 'modern-sv'` this replaces put the SV dot grid on
  // 52.9% of the catalog's reverse printings on no evidence at all.
  const eraId: string | null = ERA_BY_SERIES[input.seriesSlug] ?? null
  const rarity = normRarity(input.rarity ?? '')
  const type = (input.type ?? '').toLowerCase()

  type Hit = { row: IndexRow; score: number }
  const hits: Hit[] = []
  for (const row of ROWS) {
    const scopeMatches =
      row.kind === 'era'
        ? eraId !== null && row.scope === eraId
        : row.kind === 'set'
          ? row.scope === input.setId
          : // card and subset rows are defined by their card list; the scope id
            // names the group for the reader and for the task queue.
            !!input.cardId && !!row.cards?.includes(input.cardId)
    if (!scopeMatches) continue
    if (row.kinds && !row.kinds.includes(kind)) continue
    if (row.types && !(type && row.types.includes(type))) continue
    if (row.rar && !row.rar.some((r) => rarity === r)) continue
    if (row.cards && row.kind !== 'card' && row.kind !== 'subset' && !(input.cardId && row.cards.includes(input.cardId)))
      continue
    hits.push({ row, score: inkRowScore(row) })
  }
  if (hits.length === 0) return NO_INK

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      CONF_RANK[b.row.conf] - CONF_RANK[a.row.conf] ||
      // A row that ships a tile beats an equally specific row that queues one:
      // an answer beats a placeholder.
      Number(b.row.tile !== null) - Number(a.row.tile !== null) ||
      a.row.scope.localeCompare(b.row.scope),
  )
  const row = hits[0]!.row
  const match = row.kind === 'card' ? 'card' : row.kind === 'subset' ? 'subset' : row.kind === 'set' ? 'set' : 'era'
  const placement = toPlacement(row.pl)

  // The `shows` consultation. A human override on the frame record beats the
  // generated value (AGENTS.md F4 — human decisions are a ratchet and a machine
  // may not roll one back).
  const override = input.frameId ? FRAME_SHOWS[input.frameId] : undefined
  const shows: FrameShows = (override as FrameShows) ?? input.shows ?? 'unknown'
  const alreadyShown = shows === 'reverse'

  if (row.tile === null) {
    // A null tile has TWO meanings and they are not interchangeable, so the
    // registry states which and this never infers it. `noInk` is a recorded
    // DECISION — considered, and needs no tile; `queued` is an EMPTY SLOT
    // somebody is expected to fill. Reporting the first as the second puts
    // Legendary Collection on a laundry list of work nobody owes.
    //
    // Both leave uInkOn FALSE, and for the same reason: the recipe keeps its
    // procedural stand-in and the render is exactly what it is today. A queued
    // slot must cost nothing, and a no-ink row makes a claim about the ink
    // TILE, not about the recipe underneath it.
    return {
      tileId: null,
      tileFile: null,
      state: row.noInk ? 'no-ink' : 'queued',
      queued: row.noInk ? null : row.queued,
      placement,
      match,
      scope: row.scope,
      confidence: row.conf,
      delta: row.delta,
      sources: row.src,
      uInkOn: false,
      uInkDraw: false,
    }
  }

  const tile = TILES[row.tile]!
  return {
    tileId: row.tile,
    tileFile: tile.file,
    state: alreadyShown ? 'in-scan' : 'design',
    queued: null,
    placement,
    match,
    scope: row.scope,
    confidence: row.conf,
    delta: row.delta,
    sources: row.src,
    // uInkOn is TRUE in both branches: the tier owns the design layer either
    // way, so the recipe stops drawing its procedural guess either way. What
    // changes is whether we draw ours instead of, or on top of, the scan's.
    uInkOn: true,
    uInkDraw: !alreadyShown,
  }
}

/**
 * Every tile the registry ships, for the editor's picker and for tests.
 *
 * `seam` is the tiling-seam error measured by tools/build-ink-index.mjs: mean
 * |Δcoverage| across the cell's own wrap, 0..255, and 0 is the only passing
 * value. A tile whose edges do not meet its own opposite edges draws a visible
 * grid line across every card it is used on, and the builder refuses it.
 */
export function inkTiles(): Record<
  string,
  { file: string; across: number; n: number; conf: string | null; seam: number }
> {
  return TILES
}

/** The trademarked marks queued rather than traced — the laundry list. */
export function queuedInkTiles(): { tileId: string; mark: string; usedBy: string; why: string }[] {
  return inkIndex.queued as { tileId: string; mark: string; usedBy: string; why: string }[]
}

/**
 * Tiles that EXIST but no row keys yet, with the reason each is still unkeyed.
 *
 * A shipped tile nothing can reach is not a bug and not an achievement — it is
 * a drawn asset waiting for the evidence that says where it belongs. Left
 * unrecorded it reads as either: somebody deletes it as dead weight, or
 * somebody keys it to an era on a hunch, which is the drawn-from-nothing
 * defect again. So it is declared, the builder cross-checks the declaration
 * against the rows in both directions, and the list is short on purpose.
 */
export function unkeyedInkTiles(): Record<string, string> {
  return inkIndex.unkeyedTiles as Record<string, string>
}

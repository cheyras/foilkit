// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// api.ts — the editor's read/write client. Ported from the DeckPal workbench,
// with the one constant that made this port cheap swapped out.
//
// ── WHAT CHANGED, AND WHY IT WAS ONE LINE ──────────────────────────────────
//
// The old client was self-contained by design: it deliberately did NOT import
// the host app's api module, so `const BASE = '/deckscout/api'` was the entire
// coupling to a server. `catalog/artifacts.ts` is what took its place — a
// fetcher over baked FILES on the same origin. No Postgres at runtime, anywhere.
//
// ── OWNERSHIP CAME OUT ─────────────────────────────────────────────────────
//
// Every catalog route in the old api joined `user_set_progress` and ownership,
// and the picker consumed all of it: an owned-only chip persisted to
// localStorage, per-series owned counts, per-set "N owned", a per-card
// ownership badge. There is no account behind this site, so none of it
// survives — and it is REMOVED rather than hardcoded to false. A dead
// parameter threaded through four query keys is worse than its absence.
//
// The replacement filters are contribution-shaped, not collection-shaped —
// has a mask / no mask / has window geometry — and they live in
// `catalog/manifest.ts`, because they are facts about the corpus rather than
// facts about the catalog.
//
// ── THE WRITE PATH KEEPS THE OLD SHAPE ─────────────────────────────────────
//
// The old client treated a 404 from the foil-lab endpoints as "this feature is
// not available here" and hid the affordance. That behaviour is preserved
// exactly: a viewer without the writer capability gets 401/404 from the write
// endpoints and the direct-write UI hides itself, while their work goes to the
// staging layer. Read stays fully public — no login to browse, no login to open
// a card, no login to look at a canon.

import { artifactUrl, getBytes, getJson } from './catalog/artifacts.ts'
import { Catalog, type CatalogCard, type CatalogSetShard } from './catalog/shards.ts'
import { CorpusView, type CorpusManifest } from './catalog/manifest.ts'
import { SearchIndex } from './catalog/search.ts'
import { sha256Bytes } from './staging/sha.ts'

// ── Types (only the fields the workbench reads) ────────────────
//
// `FoilSeries.progress`, `FoilSet.progress`, `FoilCardRow.ownership` and
// `FoilVariant.quantity` are GONE from these shapes, not defaulted. If one
// reappears, something is reading a field the bake is forbidden to emit.

export interface FoilSeries {
  slug: string
  name: string
  /** Sets in this series. Replaces the owned/total progress pair. */
  setCount: number
  cardCount: number
}

export interface FoilSet {
  setId: string
  name: string
  releasedOn: string | null
  cardCountTotal: number
}

export interface FoilCardRow {
  cardId: string
  number: string
  name: string
  rarity: string | null
  variantCount: number
  images: { low: string; high: string }
}

export interface FoilVariant {
  variantId: number
  kind: string
  displayName: string
  /** Derived from the variant kind by the bake — never selected from a column. */
  tier: string
}

// ── Mask provenance (sidecar v3/v4 — docs/MASK-PIPELINE.md) ──

/** The five honest derivation methods. The SERVER derives this — we never send it. */
export type FoilDerivationMethod = 'layout-flatten' | 'hand' | 'hand-refined' | 'ai' | 'ai-corrected'

export type FoilReviewStatus = 'human-authored' | 'human-adjusted' | 'unreviewed'

/** Who/what made a machine mask, and which human masks it learned from. */
export interface FoilGeneratorIdentity {
  name: string
  version: number
  modelId: string | null
  runId: string
  params: Record<string, number | string | boolean>
  exemplars: { cardId: string; variantId: number; savedAt: string | null; method: FoilDerivationMethod; weight: number }[]
  confidence: number | null
  generatedAt: string
}

/** What a human changed about the mask they started from — the training signal. */
export interface FoilCorrectionRecord {
  parent: {
    cardId: string
    variantId: number
    savedAt: string | null
    method: FoilDerivationMethod
    sha256: string
    generator: FoilGeneratorIdentity | null
  }
  parentPng: string
  parentDiffPng: string
  addedPx: number
  removedPx: number
  unchangedPx: number
  agreement: number
  changedPx: number
  changedFraction: number
  bbox: [number, number, number, number] | null
  grid: { size: number; cells: number[] }
}

/**
 * What the mask was derived FROM. `rect`/`radius`/`invert` ALWAYS carry the
 * deterministic era-rule numbers (so diff.agreement keeps scoring the rule);
 * `source` says what the editing session actually started from.
 */
export interface FoilMaskPrior {
  source: 'layout' | 'window' | 'mask' | 'ai'
  eraId: string
  scope: string
  /** The DETERMINISTIC layout-rule output (era rect) — never the adjusted window. */
  rect: [number, number, number, number]
  radius: number
  invert: boolean
  feather: number
  resolverVersion: number
  /** The hand-adjusted window geometry in effect when this mask was saved. */
  window?: { rect: [number, number, number, number]; radius: number }
  /** Machine identity — on an AI mask AND carried onto every correction of it. */
  generator?: FoilGeneratorIdentity
  parentMask?: { cardId: string; variantId: number; savedAt: string | null; method: FoilDerivationMethod }
}

/** The full sidecar as it is committed to `data/foil-masks`. */
export interface FoilMaskSidecar {
  version: number
  cardId: string
  variantId: number
  artworkKey: string
  width: number
  height: number
  channel: string
  derivation_method: FoilDerivationMethod
  authorship: 'human' | 'machine' | 'mixed'
  reviewStatus: FoilReviewStatus
  savedAt: string
  artworkUrl: string | null
  /** Sidecar v4 — the framing the pixels were authored in, inferred, never claimed. */
  frame?: string
  card?: { setId: string | null; seriesSlug: string | null; name: string | null; number: string | null }
  prior: FoilMaskPrior
  diff?: { addedPx: number; removedPx: number; unchangedPx: number; agreement: number }
  correction?: FoilCorrectionRecord
  supersedes?: {
    parent: { cardId: string; variantId: number; savedAt: string | null; method: FoilDerivationMethod; sha256: string }
    runId: string
    archiveDir: string
    addedPx: number
    removedPx: number
    agreement: number
    changedPx: number
    changedFraction: number
    grid: { size: number; cells: number[] }
  }
  lineage?: { method: FoilDerivationMethod; savedAt: string | null; source: FoilMaskPrior['source']; generator: { name: string; version: number; runId: string } | null }[]
}

/**
 * What the editing session was SEEDED with. This — not a label — is what the
 * client is allowed to claim; the server decides `derivation_method` by diffing
 * the saved pixels against what this seed actually rasterizes to.
 */
export interface FoilMaskDerivation {
  startedFrom: 'layout' | 'window-bake' | 'mask'
  parent?: { cardId: string; variantId: number } | null
}

/**
 * Corpus-wide provenance report.
 *
 * On the hosted editor this is DERIVED FROM THE MANIFEST rather than computed
 * by a server walking sidecars, so two fields that the old report filled cannot
 * be filled here and are `null` instead of zero: `corrections` needs each
 * sidecar's correction block, and `bySet`/`bySeries` need catalog joins the
 * manifest does not carry. Reporting `0 corrections` would be a measurement
 * nobody took, which is exactly the failure mode `derivation_method` exists to
 * prevent — so it says "not measured here" and means it.
 */
export interface FoilCorpusReport {
  generatedAt: string
  total: number
  byMethod: Record<string, number>
  byAuthorship: Record<string, number>
  byReviewStatus: Record<string, number>
  meanAgreement: number | null
  byEra: Record<string, { n: number; byMethod: Record<string, number>; meanAgreement: number | null }>
  bySet: Record<string, { n: number; byMethod: Record<string, number>; meanAgreement: number | null }> | null
  bySeries: Record<string, { n: number; byMethod: Record<string, number>; meanAgreement: number | null }> | null
  byScope: Record<string, { n: number; byMethod: Record<string, number>; meanAgreement: number | null }>
  exemplarsAvailable: { total: number; byEra: Record<string, number>; byScope: Record<string, number> }
  awaitingReview: {
    cardId: string
    variantId: number
    savedAt: string
    generator: { name: string; version: number; runId: string; modelId: string | null } | null
    confidence: number | null
    exemplars: number
    agreement: number | null
    maskUrl: string
  }[]
  corrections: {
    n: number
    meanAgreementVsParent: number | null
    meanChangedFraction: number | null
    entries: {
      cardId: string
      variantId: number
      savedAt: string
      parentMethod: FoilDerivationMethod
      generator: string | null
      agreement: number
      changedFraction: number
      addedPx: number
      removedPx: number
    }[]
  } | null
  bySidecarVersion: Record<string, number>
}

/** Adjusted window geometry — `data/foil-windows/<cardId>/<variantId>.json`. */
export interface FoilWindowEntry {
  version: 1
  cardId: string
  variantId: number
  artworkKey: string
  savedAt: string
  scope: string
  eraId: string
  rect: [number, number, number, number]
  radius: number
  invert: boolean
  base: { rect: [number, number, number, number]; radius: number; resolverVersion: number }
}

/** Canon pattern defaults — `data/foil-canon/<patternId>.json` (surface A). */
export interface FoilCanonEntry {
  version: 1
  patternId: string
  savedAt: string
  /** FULL uniform snapshot — replaces recipe code defaults as the baseline. */
  uniforms: Record<string, number>
  /** The `main()` this file was tuned against (#5's contract stamp). */
  contract?: number
  note?: string
}

/** Per-card override — `data/foil-overrides/<cardId>/<variantId>.json` (surface B). */
export interface FoilOverrideEntry {
  version: 1
  cardId: string
  variantId: number
  patternId: string
  patternOverride: string | null
  savedAt: string
  /** SPARSE — only uniforms that differ from the canon baseline. */
  uniforms: Record<string, number>
  baseline: { canonSavedAt: string | null }
}

/** Which video-reference assets exist per pattern. Always empty here — see below. */
export interface FoilReferenceIndex {
  patterns: Record<string, { clip: boolean; frames: number }>
}

/** What the workbench knows about the saved hand mask it is displaying. */
export interface FoilMaskMeta {
  file: string
  savedAt: string | null
  /** Set when artwork aliasing answered with a sibling variant's mask. */
  aliasOf: number | null
  hasPrior: boolean
  hasDiff: boolean
  method: FoilDerivationMethod | null
  reviewStatus: FoilReviewStatus | null
  /** sha256 of the answering PNG. The staging layer's staleness pin. */
  sha256: string | null
}

export interface FoilCardPage {
  cards: FoilCardRow[]
  page: number
  pageCount: number
  total: number
}

export interface FoilSearchHit {
  cardId: string
  number: string
  name: string
  rarity: string | null
  set: { setId: string; name: string }
  images: { low: string; high: string }
}

export interface FoilSearchPage {
  hits: FoilSearchHit[]
  page: number
  pageCount: number
  total: number
}

export interface FoilPatternCards {
  patternId: string
  total: number
  via: 'assigned' | 'cited'
  citedTotal: number
  diagnosis: {
    reason: 'outranked' | 'class-absent' | 'sets-absent' | 'no-cited-rows' | string
    detail: string
    alternates: number
    outrankedBy?: [string, number][]
  } | null
  sample: { cardId: string; variantId: number; kind: string; scope: string }[]
  generatedAt: string
  resolverVersion: number
}

export interface FoilCardDetail {
  card: {
    cardId: string
    name: string
    number: string
    rarity: string | null
    images: { low: string; high: string }
    set: { setId: string; name: string; slug: string }
    series: { slug: string; name: string; tcgdexId: string }
  }
  variants: FoilVariant[]
}

// ── Shared state: the artifact readers ──────────────────────────

const catalog = new Catalog()
const searchIndex = new SearchIndex()
let corpusPromise: Promise<CorpusView> | null = null

export function corpusView(signal?: AbortSignal): Promise<CorpusView> {
  corpusPromise ??= CorpusView.load(signal)
  return corpusPromise
}

/** Drop the cached manifest — used after a direct write changes the corpus. */
export function invalidateCorpus(): void {
  corpusPromise = null
}

function toCardRow(c: CatalogCard): FoilCardRow {
  return {
    cardId: c.cardId,
    number: c.number,
    name: c.name,
    rarity: c.rarity,
    variantCount: c.variants.length,
    images: c.images,
  }
}

/**
 * Images by reference, through the proxy.
 *
 * `assets.tcgdex.net` does send `access-control-allow-origin: *` (measured),
 * so a direct `<img crossOrigin>` would texture fine. The proxy is used anyway:
 * it keeps a volunteer CDN from being hammered every time somebody scrubs a
 * set, it survives an upstream outage, and — the one that matters for the
 * corpus — #4's frame registry keys a framing on source URL plus raster
 * dimensions, so a URL under our control is what keeps that key stable.
 */
export function proxied(url: string): string {
  try {
    const u = new URL(url, location.href)
    if (u.origin !== 'https://assets.tcgdex.net') return url
    return `/api/image?p=${encodeURIComponent(u.pathname.replace(/^\//, ''))}`
  } catch {
    return url
  }
}

// ── Fetchers ───────────────────────────────────────────────────

export const foilApi = {
  // The picker browses the FULL catalog. There is no owned-only narrowing,
  // because there is no account — see the header.

  series: async (signal?: AbortSignal): Promise<FoilSeries[]> => {
    const idx = await catalog.loadIndex(signal)
    if (idx === null) return []
    return idx.series.map((s) => ({ slug: s.slug, name: s.name, setCount: s.setCount, cardCount: s.cardCount }))
  },

  sets: async (seriesSlug: string, signal?: AbortSignal): Promise<FoilSet[]> => {
    const shard = await catalog.seriesShard(seriesSlug, signal)
    return shard?.sets ?? []
  },

  // One page of a set's cards. The paging is the bake's, at the same pageSize
  // the old api capped at, so the strip's More chip keeps working unchanged.
  cards: async (setId: string, page: number, signal?: AbortSignal): Promise<FoilCardPage> => {
    const shard = await catalog.setShard(setId, page, signal)
    if (shard === null) return { cards: [], page, pageCount: 0, total: 0 }
    return { cards: shard.cards.map(toCardRow), page: shard.page, pageCount: shard.pageCount, total: shard.total }
  },

  /** Full-catalog name/number/set search, in the browser. See catalog/search.ts. */
  search: async (text: string, page: number, signal?: AbortSignal): Promise<FoilSearchPage> => {
    const PAGE = 60
    const hits = await searchIndex.search(text, PAGE * 4, signal)
    const slice = hits.slice((page - 1) * PAGE, page * PAGE)
    // The hit list carries no rarity or image url — those live in the set
    // shard, and pulling one shard per hit to fill a search result would be a
    // worse trade than showing the fields the index actually has.
    return {
      hits: slice.map((h) => ({
        cardId: h.cardId,
        number: h.number,
        name: h.name,
        rarity: null,
        set: { setId: h.setId, name: h.setId },
        images: { low: '', high: '' },
      })),
      page,
      pageCount: Math.max(1, Math.ceil(hits.length / PAGE)),
      total: hits.length,
    }
  },

  cardDetail: async (cardId: string, signal?: AbortSignal): Promise<FoilCardDetail> => {
    const found = await catalog.card(cardId, signal)
    if (found === null) throw new Error(`no catalog entry for ${cardId}`)
    const { card, shard } = found
    return {
      card: {
        cardId: card.cardId,
        name: card.name,
        number: card.number,
        rarity: card.rarity,
        images: card.images,
        set: { setId: shard.set.setId, name: shard.set.name, slug: shard.set.slug },
        series: { slug: shard.set.slug, name: shard.set.seriesName, tcgdexId: shard.set.seriesTcgdexId },
      },
      variants: card.variants,
    }
  },

  // ── The corpus, read as committed files ──────────────────────
  //
  // These used to be the "dev surface" that 404'd against production. They are
  // now plain static reads of the repository's own data, which is why the
  // hosted editor can show provenance to anybody with no login at all.

  /**
   * The mask that answers for `(cardId, variantId)` at `scope`, through the
   * same `(cardId, scope)` aliasing the server used to do — resolved from the
   * corpus manifest, and reported in `meta.aliasOf` exactly as
   * `X-Foil-Mask-Alias-Of` used to report it.
   */
  getMask: async (
    cardId: string,
    variantId: number,
    scope?: string,
    signal?: AbortSignal,
  ): Promise<{ bitmap: ImageBitmap; meta: FoilMaskMeta } | null> => {
    const view = await corpusView(signal)
    const record = scope ? view.maskFor(cardId, scope) : (view.manifest?.masks[cardId]?.[String(variantId)] ?? null)
    if (record === null) return null
    const got = await getBytes(artifactUrl.maskPng(cardId, record.variantId), signal)
    if (got === null) return null
    try {
      const bitmap = await createImageBitmap(new Blob([got.bytes as unknown as BlobPart], { type: 'image/png' }))
      return {
        bitmap,
        meta: {
          file: `data/foil-masks/${cardId}/${record.variantId}.png`,
          savedAt: record.savedAt,
          aliasOf: record.variantId === variantId ? null : record.variantId,
          // The artifacts are committed beside the mask; the manifest does not
          // list them, so this reports the two that writeMaskRecord always
          // produces and lets a missing one 404 into a hidden button.
          hasPrior: true,
          hasDiff: true,
          method: record.method as FoilDerivationMethod,
          reviewStatus: record.reviewStatus as FoilReviewStatus,
          // The manifest already measured this from the bytes, so the client
          // does not re-hash on every open — the seed pin comes free.
          sha256: record.sha256,
        },
      }
    } catch {
      return null
    }
  },

  /** The raw bytes + sha of whatever answers, for seeding and conflict probes. */
  probeMask: async (
    cardId: string,
    variantId: number,
    scope: string,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; resolvedFrom: { cardId: string; variantId: number }; savedAt: string | null; method: string } | null> => {
    const view = await corpusView(signal)
    const record = view.maskFor(cardId, scope)
    if (record === null) return null
    return {
      sha256: record.sha256,
      resolvedFrom: { cardId, variantId: record.variantId },
      savedAt: record.savedAt,
      method: record.method,
    }
  },

  maskMeta: async (
    cardId: string,
    variantId: number,
    scope?: string,
    signal?: AbortSignal,
  ): Promise<{ aliasOf: number | null; sidecar: FoilMaskSidecar } | null> => {
    const view = await corpusView(signal)
    const record = scope ? view.maskFor(cardId, scope) : (view.manifest?.masks[cardId]?.[String(variantId)] ?? null)
    if (record === null) return null
    const sidecar = await getJson<FoilMaskSidecar>(artifactUrl.maskSidecar(cardId, record.variantId), signal)
    if (sidecar === null) return null
    return { aliasOf: record.variantId === variantId ? null : record.variantId, sidecar }
  },

  maskArtifactUrl: (
    cardId: string,
    variantId: number,
    kind: 'prior' | 'diff' | 'parent' | 'parent-diff',
  ): string => artifactUrl.maskArtifact(cardId, variantId, kind),

  /** See `FoilCorpusReport` for what this can and cannot measure statically. */
  maskCorpus: async (signal?: AbortSignal): Promise<FoilCorpusReport | null> => {
    const view = await corpusView(signal)
    const m = view.manifest
    if (m === null) return null
    return buildStaticReport(m, await getJson<VerificationMap>('/foil-verification-map.json', signal))
  },

  getWindow: async (
    cardId: string,
    variantId: number,
    signal?: AbortSignal,
  ): Promise<{ entry: FoilWindowEntry; aliasOf: number | null } | null> => {
    const view = await corpusView(signal)
    // Window geometry aliases SCOPE-AGNOSTICALLY: the art box is a property of
    // the scan, and a sheet is the same box inverted.
    const answering = view.windowVariantFor(cardId)
    if (answering === null) return null
    const entry = await getJson<FoilWindowEntry>(artifactUrl.window(cardId, answering), signal)
    if (entry === null) return null
    return { entry, aliasOf: answering === variantId ? null : answering }
  },

  getCanon: async (signal?: AbortSignal): Promise<Record<string, FoilCanonEntry> | null> => {
    const view = await corpusView(signal)
    const m = view.manifest
    if (m === null) return null
    const ids = Object.entries(m.canon)
      .filter(([, c]) => c.exists)
      .map(([id]) => id)
    const entries = await Promise.all(ids.map((id) => getJson<FoilCanonEntry>(artifactUrl.canon(id), signal)))
    const out: Record<string, FoilCanonEntry> = {}
    ids.forEach((id, i) => {
      const e = entries[i]
      if (e) out[id] = e
    })
    return out
  },

  /**
   * Per-card overrides. `data/foil-overrides/` HAS NEVER EXISTED — no per-card
   * override has ever been written — so this always answers null today. The
   * code layer travelled with the extraction; the data did not, because there
   * is none. Staged overrides live in the session until #9 can open a PR for
   * one.
   */
  getOverride: async (_cardId: string, _variantId: number, _signal?: AbortSignal): Promise<FoilOverrideEntry | null> => {
    return null
  },

  /**
   * Random catalog cards the resolver assigns a pattern to — the canon lab's
   * card preview. The old api sampled server-side from the baked inversion
   * file; the file is now shipped, so the sampling moved into the browser.
   * Every call reshuffles, which is what the re-randomize button wants.
   */
  patternCards: async (patternId: string, sample: number, signal?: AbortSignal): Promise<FoilPatternCards | null> => {
    const file = await patternCardsFile(signal)
    if (file === null) return null
    const assigned = file.patterns[patternId] ?? []
    const cited = file.alternates[patternId] ?? []
    const pool = assigned.length > 0 ? assigned : cited
    const via: 'assigned' | 'cited' = assigned.length > 0 ? 'assigned' : 'cited'
    const diag = file.diagnosis[patternId] ?? null
    return {
      patternId,
      total: pool.length,
      via,
      citedTotal: diag?.citedPrintings ?? cited.length,
      diagnosis: diag ? { reason: diag.reason, detail: diag.detail, alternates: diag.alternates, outrankedBy: diag.outrankedBy } : null,
      sample: reservoir(pool, sample).map((t) => ({ cardId: t[0], variantId: t[1], kind: t[2], scope: t[3] })),
      generatedAt: file.generatedAt,
      resolverVersion: file.resolverVersion,
    }
  },

  /**
   * `/reference` is DEFERRED, not ported.
   *
   * The old route streamed committed clips out of `research/foil-video-reference/`.
   * Subtask 2 removed that media from the repository — it is cited, never
   * vendored — and subtask 12 replaces it with embeds from the source. So the
   * canon lab's reference pane is an EMPTY SLOT, treated exactly like the glyph
   * slots: shipping the slot empty is how it stays possible. This returns an
   * empty index rather than null so the pane renders its own explanation
   * instead of silently disappearing.
   */
  referenceIndex: async (_signal?: AbortSignal): Promise<FoilReferenceIndex | null> => {
    return { patterns: {} }
  },

  referenceUrl: (_slug: string, _file: string): string => '',

  // ── Writes: the direct-write path ────────────────────────────
  //
  // A writer-capability holder saves through these; everyone else never
  // reaches them, because the UI routes to the staging layer instead. They
  // answer 401 for a viewer without the capability, and the surfaces treat
  // that the way they always treated a 404 — the affordance hides itself.

  putMask: async (
    cardId: string,
    variantId: number,
    pngDataUrl: string,
    width: number,
    height: number,
    prior: FoilMaskPrior,
    derivation: FoilMaskDerivation,
    extra?: { artworkUrl?: string | null; card?: { setId: string | null; seriesSlug: string | null; name: string | null; number: string | null }; comment?: string },
  ): Promise<FoilMaskSidecar> => {
    const res = await fetch('/api/mask', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ cardId, variantId, png: pngDataUrl, width, height, prior, derivation, ...extra }),
    })
    if (!res.ok) throw new Error(await writeError(res, 'mask save'))
    invalidateCorpus()
    return (await res.json()) as FoilMaskSidecar
  },

  putWindow: async (
    cardId: string,
    variantId: number,
    body: {
      scope: string
      eraId: string
      rect: [number, number, number, number]
      radius: number
      invert: boolean
      base: { rect: [number, number, number, number]; radius: number; resolverVersion: number }
    },
  ): Promise<FoilWindowEntry> => {
    const res = await fetch('/api/window', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ cardId, variantId, ...body }),
    })
    if (!res.ok) throw new Error(await writeError(res, 'window save'))
    invalidateCorpus()
    return (await res.json()) as FoilWindowEntry
  },

  putCanon: async (patternId: string, uniforms: Record<string, number>, note?: string): Promise<FoilCanonEntry> => {
    const res = await fetch('/api/canon', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ patternId, uniforms, ...(note ? { note } : {}) }),
    })
    if (!res.ok) throw new Error(await writeError(res, 'canon save'))
    invalidateCorpus()
    return (await res.json()) as FoilCanonEntry
  },

  // `putOverride`/`deleteOverride` ARE GONE, not stubbed.
  //
  // `putOverride` threw unconditionally — there is no `/api/override` route,
  // because `data/foil-overrides/` has never held a record and a PUT with no
  // reader would be a promise rather than a feature. But it was still WIRED to
  // a "Save card overrides" button, so the one thing it reliably produced was a
  // red "save failed" that blamed a server for refusing a request it never
  // received. A client method that can only throw is a trap for the next
  // caller, so the method went with the button (FoilLab.tsx, `overrideDiff`).
  //
  // Per-card overrides are SESSION CONTENTS: `stageMask` writes them into the
  // staged session, and `getOverride` above still reads a committed one if the
  // corpus ever grows any.

  // ── Deletions: the writer path only ──────────────────────────
  //
  // NOT STAGEABLE IN v1, and that is a decision rather than an omission. A
  // contributor's first available action should not be removing ground truth,
  // and a deletion has no diff to review — the PR would be an empty file and a
  // claim. These stay live for a writer-capability holder and are simply
  // absent for everybody else.

  deleteMask: async (cardId: string, variantId: number): Promise<void> => {
    const res = await fetch(`/api/mask?cardId=${encodeURIComponent(cardId)}&variantId=${variantId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(await writeError(res, 'mask delete'))
    invalidateCorpus()
  },

  deleteWindow: async (cardId: string, variantId: number): Promise<void> => {
    const res = await fetch(`/api/window?cardId=${encodeURIComponent(cardId)}&variantId=${variantId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(await writeError(res, 'window delete'))
    invalidateCorpus()
  },

  deleteCanon: async (patternId: string): Promise<void> => {
    const res = await fetch(`/api/canon?patternId=${encodeURIComponent(patternId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    })
    if (!res.ok) throw new Error(await writeError(res, 'canon delete'))
    invalidateCorpus()
  },

  /** Is the write surface reachable for THIS viewer? Replaces `devSurface()`. */
  writeSurface: async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' })
      if (!res.ok) return false
      return ((await res.json()) as { writer?: boolean }).writer === true
    } catch {
      return false
    }
  },
}

async function writeError(res: Response, what: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  return body?.error?.message ?? `${what} failed (HTTP ${res.status})`
}

// ── pattern-cards, sampled in the browser ───────────────────────

type PatternTuple = [string, number, string, string, string?, (string | null)?]
interface PatternCardsFile {
  version: number
  generatedAt: string
  source: string
  resolverVersion: number
  patterns: Record<string, PatternTuple[]>
  alternates: Record<string, PatternTuple[]>
  diagnosis: Record<string, { reason: string; detail: string; alternates: number; citedPrintings: number; outrankedBy?: [string, number][] }>
}

let patternCardsPromise: Promise<PatternCardsFile | null> | null = null
function patternCardsFile(signal?: AbortSignal): Promise<PatternCardsFile | null> {
  patternCardsPromise ??= getJson<PatternCardsFile>('/foil-pattern-cards.json', signal)
  return patternCardsPromise
}

/** An even sample, not the first N — the preview should not always show base1. */
function reservoir<T>(pool: T[], n: number): T[] {
  if (pool.length <= n) return [...pool]
  const out = pool.slice(0, n)
  for (let i = n; i < pool.length; i++) {
    const j = Math.floor(Math.random() * (i + 1))
    if (j < n) out[j] = pool[i]!
  }
  return out
}

// ── The static corpus report ────────────────────────────────────

interface VerificationMap {
  corpus?: {
    exemplarUnits?: number
    exemplarPools?: Record<string, { eraId: string; scope: string; exemplars: number }>
  }
}

function buildStaticReport(m: CorpusManifest, map: VerificationMap | null): FoilCorpusReport {
  const byMethod: Record<string, number> = {}
  const byAuthorship: Record<string, number> = {}
  const byReviewStatus: Record<string, number> = {}
  const byEra: FoilCorpusReport['byEra'] = {}
  const byScope: FoilCorpusReport['byScope'] = {}
  const awaitingReview: FoilCorpusReport['awaitingReview'] = []
  let agreementSum = 0
  let agreementN = 0
  let total = 0

  const AUTHORSHIP: Record<string, string> = {
    hand: 'human',
    'hand-refined': 'human',
    'layout-flatten': 'human',
    ai: 'machine',
    'ai-corrected': 'mixed',
  }

  for (const [cardId, byVariant] of Object.entries(m.masks)) {
    for (const rec of Object.values(byVariant)) {
      total++
      byMethod[rec.method] = (byMethod[rec.method] ?? 0) + 1
      const auth = AUTHORSHIP[rec.method] ?? 'human'
      byAuthorship[auth] = (byAuthorship[auth] ?? 0) + 1
      byReviewStatus[rec.reviewStatus] = (byReviewStatus[rec.reviewStatus] ?? 0) + 1
      for (const [table, key] of [
        [byEra, rec.eraId],
        [byScope, rec.scope],
      ] as const) {
        const bucket = (table[key] ??= { n: 0, byMethod: {}, meanAgreement: null })
        bucket.n++
        bucket.byMethod[rec.method] = (bucket.byMethod[rec.method] ?? 0) + 1
      }
      if (rec.agreement !== null) {
        agreementSum += rec.agreement
        agreementN++
      }
      if (rec.method === 'ai' && rec.reviewStatus === 'unreviewed') {
        awaitingReview.push({
          cardId,
          variantId: rec.variantId,
          savedAt: rec.savedAt ?? '',
          generator: null,
          confidence: null,
          exemplars: 0,
          agreement: rec.agreement,
          maskUrl: artifactUrl.maskPng(cardId, rec.variantId),
        })
      }
    }
  }

  const exemplarPools = map?.corpus?.exemplarPools ?? {}
  const exByEra: Record<string, number> = {}
  const exByScope: Record<string, number> = {}
  for (const p of Object.values(exemplarPools)) {
    exByEra[p.eraId] = (exByEra[p.eraId] ?? 0) + p.exemplars
    exByScope[p.scope] = (exByScope[p.scope] ?? 0) + p.exemplars
  }

  return {
    generatedAt: m.generatedAt,
    total,
    byMethod,
    byAuthorship,
    byReviewStatus,
    meanAgreement: agreementN === 0 ? null : Number((agreementSum / agreementN).toFixed(4)),
    byEra,
    // Not measurable from the manifest — see the type's doc comment. Null, not zero.
    bySet: null,
    bySeries: null,
    byScope,
    exemplarsAvailable: { total: map?.corpus?.exemplarUnits ?? 0, byEra: exByEra, byScope: exByScope },
    awaitingReview,
    corrections: null,
    bySidecarVersion: {},
  }
}

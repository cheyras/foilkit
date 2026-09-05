// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// foil/FoilLab.tsx — surface B of the workbench split (/deckscout/foil-lab):
// the CARD ADJUSTMENT surface (issues/foil/2026-08-02_12-59-52-368_4aq756).
//
// Card-to-card differences ONLY: per-card mask work (hand masks, layout
// masks, artwork-keyed aliasing), per-card uniform overrides layered on top
// of the canon pattern defaults, and the comment queue. The canonical
// pattern recipes themselves are locked on surface A — the canon lab at
// /deckscout/foil-lab/canon (CanonLab.tsx) — and load here as the slider
// baseline (foil/canon.ts explains the layering).
//
// Reachable by URL only — linked from NOWHERE in the app shell (quarantine
// rule, roadmap/plans/foil-main.md). One card/variant at a time — ANY card in
// the catalog, owned or not (Owned-only is a filter toggle; scans come from
// the app-wide image cache either way). Layouts: single column at phone
// widths (390px), two columns from iPad-mini portrait up (≥700px: viewer |
// controls).
//
// The mask/override/comment surfaces need the BRANCH api dev instance
// (POKEDEX_FOIL_LAB=1 — roadmap/ORCHESTRATION.md); against prod they probe
// as unavailable and those affordances hide themselves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  foilApi,
  proxied,
  type FoilDerivationMethod,
  type FoilMaskMeta,
  type FoilMaskSidecar,
  type FoilVariant,
} from './api.ts'
import { MaskCorpusPanel, MaskProvenanceLine } from './MaskProvenance.tsx'
import { PATTERNS, patternById, canonicalPatternId, canonFor } from '@foilkit/patterns'
import { canonBaseline, sparseDiff } from '@foilkit/core'
import { resolveFoil, maskForScope, ERAS, RESOLVER_VERSION, type FoilScope } from '@foilkit/resolver'
import {
  CardViewer,
  MaskEditor,
  MASK_H,
  MASK_TINT,
  MASK_W,
  WindowEditor,
  ZoomHud,
  cardScreenRect,
  createMaskCanvas,
  rasterizeWindowRect,
  useTilt,
  useViewTransform,
  type BrushMode,
  type MaskEditorHandle,
  type ViewerSettings,
  type WindowGeom,
} from '@foilkit/three/react'
import { ActionBtn, Chip, CoreSliders, Section, Select, Slider, SurfaceTabs } from './ui.tsx'
import { CorpusView, FILTER_LABEL, type ContributionFilter } from './catalog/manifest.ts'
import { navigate, setParam } from './router.ts'
import { useStaging } from './staging/useStaging.ts'
import { reseedMaskSession, seedMaskSession, updateMaskSession } from './staging/session.ts'
import { detectMaskConflict, type ConflictReport } from './staging/conflict.ts'
import { provisionalReport, alphaOfRgba, type ProvisionalReport } from './staging/provisionalDiff.ts'
import { buildMaskContribution, type SubmissionResult } from './staging/submit.ts'
import { provisionalOf } from './staging/provisionalPixels.ts'
import { SubmitOutcome } from './SubmitOutcome.tsx'
import { useViewer } from './writer/useViewer.ts'
import type { MaskSession } from './staging/types.ts'
import type { Staging } from './staging/useStaging.ts'
import type { ViewerState } from './writer/useViewer.ts'

const LS_KEY = 'foil-lab:selection'
/**
 * The owned-only key is GONE, not repurposed. There is no account behind this
 * site, so the chip it drove had nothing to filter against. What replaces it is
 * contribution-shaped — has a mask / no mask / has window geometry — and it is
 * answered from the corpus manifest rather than from a query parameter.
 */
const LS_FILTER_KEY = 'foilkit:contribution-filter'

interface Selection {
  seriesSlug?: string
  setId?: string
  cardId?: string
  variantId?: number
}

/**
 * Where the card on screen comes from, in priority order.
 *
 * THE URL WINS. `/card?id=base1-4&v=3` has to open that card, because it is how
 * the queue hands you a printing to work on, how the staged list gets you back
 * to one, and how one person sends another a card. Falling back to the last
 * localStorage selection when the URL says nothing is the workbench's old
 * behaviour and is right for "I came back to keep going".
 */
/** The card the ADDRESS BAR is asking for at mount, or null when it asks for none. */
function urlTarget(): { cardId: string; variantId: number | undefined } | null {
  if (typeof location === 'undefined') return null
  const params = new URLSearchParams(location.search)
  const id = params.get('id')
  if (id === null) return null
  const v = params.get('v')
  const variantId = v === null ? undefined : Number(v)
  return { cardId: id, variantId: Number.isInteger(variantId) ? variantId : undefined }
}

function loadSelection(): Selection {
  let stored: Selection = {}
  try {
    stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Selection
  } catch {
    stored = {}
  }
  const target = urlTarget()
  if (target === null) return stored
  return {
    ...stored,
    cardId: target.cardId,
    variantId: target.variantId,
    // The series/set chain is re-derived from the card detail, so a deep link
    // does not have to carry it and cannot carry a stale version of it.
    //
    // EMPTYING THOSE TWO SLOTS IS WHAT MAKES THE DEEP LINK FRAGILE, which is
    // why `deepLink` below exists: the auto-select effects fill empty slots,
    // and the set auto-select fills `setId` by CLEARING `cardId`. Left
    // unguarded it resolves faster than the card detail does and the address
    // bar is rewritten to Base Set Machamp before the requested card ever
    // loads. The guard, not this function, is the fix — this comment is here so
    // nobody removes it as redundant.
    seriesSlug: undefined,
    setId: undefined,
  }
}

const fmtRect = (r?: [number, number, number, number]): string =>
  r ? r.map((v) => v.toFixed(3)).join(' / ') : '—'

// UI atoms + seedUniforms moved to foil/ui.tsx and foil/canon.ts for the
// workbench split — both surfaces share them.

// ── The workbench ──────────────────────────────────────────────────────────

export function FoilLab({ staging, viewer }: { staging: Staging; viewer: ViewerState }) {
  const [sel, setSel] = useState<Selection>(loadSelection)
  /**
   * THE DEEP LINK, held until the browse chain has been re-derived for it.
   *
   * `/card?id=sv3-45&v=2` arrives with `seriesSlug` and `setId` empty, because
   * only the card detail knows what they are. The auto-select effects below
   * fill empty slots — and the SET one fills `setId` by clearing `cardId`,
   * which is how a queue "Work this" into `modern-swsh` used to land on
   * `base1-8` with the address bar rewritten to match. The detail query cannot
   * win that race: it is a second network round trip and the auto-selects need
   * none.
   *
   * So the auto-selects do not run at all while this is set. It clears when the
   * chain agrees with the loaded card — or when the catalog cannot answer for
   * the id, because a permanent hold would leave the picker empty forever.
   */
  const [deepLink, setDeepLink] = useState<string | null>(() => urlTarget()?.cardId ?? null)
  /**
   * The write path for THIS viewer. `direct-write` is the writer capability:
   * one PUT, straight to the repository, exactly as the workbench always
   * behaved. Everyone else stages — which is the normal path, not a degraded
   * one, and the UI says so in those words.
   */
  const canWrite = viewer.savePath === 'direct-write'
  const [filter, setFilter] = useState<ContributionFilter>(
    () => (localStorage.getItem(LS_FILTER_KEY) as ContributionFilter | null) ?? 'all',
  )
  const [corpus, setCorpus] = useState<CorpusView | null>(null)
  const [conflict, setConflict] = useState<ConflictReport | null>(null)
  const [provisional, setProvisional] = useState<ProvisionalReport | null>(null)
  const [ghostPng, setGhostPng] = useState<string | null>(null)
  const [stageStatus, setStageStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [provisionalStale, setProvisionalStale] = useState(false)
  // Full-catalog name search (input is live; the query string is debounced).
  const [searchText, setSearchText] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [patternOverride, setPatternOverride] = useState<string>('auto')
  const [scopeOverride, setScopeOverride] = useState<'auto' | FoilScope>('auto')
  /**
   * Does upstream actually have a scan for this printing?
   *
   * A 404'd scan used to render a BLACK CARD with no explanation, which reads
   * as a broken editor rather than as a gap in a volunteer CDN. `/api/image`
   * already distinguishes the cases it is asked about — 404 "upstream has no
   * scan at this path", 502 "upstream answered and what it answered with was
   * wrong" — so the pane can say which, instead of showing a void.
   */
  const [scan, setScan] = useState<'unknown' | 'ok' | 'missing' | 'upstream-error'>('unknown')
  const [maskView, setMaskView] = useState(false)
  const [maskFeather, setMaskFeather] = useState(0.008)
  const [maxTiltDeg, setMaxTiltDeg] = useState(16)
  const [copied, setCopied] = useState(false)

  // Hand-mask state
  const maskCanvas = useMemo(() => createMaskCanvas(), [])
  const [maskSource, setMaskSource] = useState<'layout' | 'hand'>('layout')
  const [editMode, setEditMode] = useState(false)
  const [brushMode, setBrushMode] = useState<BrushMode>('brush')
  const [brushSize, setBrushSize] = useState(28)
  const [allowTouch, setAllowTouch] = useState(false)
  const [maskDirty, setMaskDirty] = useState(false)
  const [savedMask, setSavedMask] = useState(false)
  /** Sidecar meta of the hand mask on screen (null = none / layout tier). */
  const [maskMeta, setMaskMeta] = useState<FoilMaskMeta | null>(null)
  /** Full sidecar (v3 provenance) of the mask on screen — drives the badge. */
  const [maskSidecar, setMaskSidecar] = useState<FoilMaskSidecar | null>(null)
  const [corpusKey, setCorpusKey] = useState(0)
  /**
   * Provenance session state: what the canvas was SEEDED with, and whether it
   * has been painted on since. Sent as `derivation` on save — the api derives
   * the honest `derivation_method` from the pixels, this only tells it which
   * pixels to compare against (see foil/provenance.ts).
   */
  const [session, setSession] = useState<{
    startedFrom: 'layout' | 'window-bake' | 'mask'
    parent: { cardId: string; variantId: number } | null
    painted: boolean
  }>({ startedFrom: 'layout', parent: null, painted: false })
  const [maskTexVersion, setMaskTexVersion] = useState(0)
  /** Save status for the DIRECT-WRITE path, and the server's own words when it refused. */
  const [maskSaveStatus, setMaskSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [maskSaveError, setMaskSaveError] = useState<string | null>(null)
  // "Open as PR instead" — the writer's route through the contribution
  // pipeline. Separate state from the direct write, because they are separate
  // acts with separate outcomes and one of them can succeed while the other
  // has not been attempted.
  const [prBusy, setPrBusy] = useState(false)
  const [prResult, setPrResult] = useState<SubmissionResult | null>(null)
  const editorRef = useRef<MaskEditorHandle | null>(null)
  const zeroTilt = useRef({ x: 0, y: 0 })
  /** Which staged session's pixels are on the canvas. Reset when the card changes. */
  const restoredFor = useRef<string | null>(null)

  // Adjusted-window state (foil/mask-refine): handles on the layout window
  // rect, persisted pre-flatten as data/foil-windows/<cardId>/<variantId>.json.
  const [adjustMode, setAdjustMode] = useState(false)
  const [winGeom, setWinGeom] = useState<WindowGeom | null>(null)
  const [winSaved, setWinSaved] = useState<{ savedAt: string; aliasOf: number | null } | null>(null)
  const [winDirty, setWinDirty] = useState(false)
  const [winStatus, setWinStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  /** The server's own words when a window write was refused. */
  const [winError, setWinError] = useState<string | null>(null)
  const preAdjustMaskView = useRef(false)

  // Comments
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentStatus, setCommentStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // Viewer host size (for aligning the mask-editor overlay with the card).
  const viewerWrapRef = useRef<HTMLDivElement>(null)
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = viewerWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHostSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setHostSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(sel))
    // Keep the address bar honest, with replaceState so scrubbing a set does
    // not fill the back button with every card passed on the way.
    if (sel.cardId !== undefined) {
      setParam('id', sel.cardId)
      setParam('v', sel.variantId === undefined ? null : String(sel.variantId))
    }
  }, [sel])
  useEffect(() => {
    localStorage.setItem(LS_FILTER_KEY, filter)
  }, [filter])
  useEffect(() => {
    const ac = new AbortController()
    void CorpusView.load(ac.signal).then(setCorpus)
    return () => ac.abort()
  }, [])
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(searchText.trim()), 250)
    return () => clearTimeout(t)
  }, [searchText])
  const searching = searchQ.length >= 2

  const tilt = useTilt()
  // Pan/pinch-zoom while editing (foil/ViewTransform.tsx). Live only on the
  // editing surfaces — normal viewing keeps the tilt interaction untouched.
  const viewCtl = useViewTransform({
    enabled: editMode || adjustMode,
    editing: editMode,
    fingerDraws: allowTouch,
  })

  // ── Data: series → sets → cards. The full catalog, always. ──
  const seriesQ = useQuery({
    queryKey: ['foil', 'series'],
    queryFn: ({ signal }) => foilApi.series(signal),
  })
  const setsQ = useQuery({
    queryKey: ['foil', 'sets', sel.seriesSlug],
    queryFn: ({ signal }) => foilApi.sets(sel.seriesSlug!, signal),
    enabled: Boolean(sel.seriesSlug),
  })
  // Paged (promo sets run 300+ cards; the strip appends pages via a More chip).
  const cardsQ = useInfiniteQuery({
    queryKey: ['foil', 'cards', sel.setId],
    queryFn: ({ pageParam, signal }) => foilApi.cards(sel.setId!, pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pageCount ? last.page + 1 : undefined),
    enabled: Boolean(sel.setId),
  })
  const allCards = useMemo(() => cardsQ.data?.pages.flatMap((p) => p.cards) ?? [], [cardsQ.data])
  // The contribution filter is a PREDICATE over a page the client already has,
  // not a query parameter. The manifest is small and already loaded, so a
  // filter with no round trip is also one that cannot be stale relative to the
  // list it filters.
  const cards = useMemo(
    () => (corpus === null ? allCards : corpus.filter(allCards, filter)),
    [allCards, corpus, filter],
  )
  const cardsTotal = cardsQ.data?.pages[0]?.total ?? 0
  // Full-catalog search — deliberately ignores the contribution filter (search
  // exists to reach cards the browse filters would hide).
  const searchResultsQ = useInfiniteQuery({
    queryKey: ['foil', 'search', searchQ],
    queryFn: ({ pageParam, signal }) => foilApi.search(searchQ, pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.pageCount ? last.page + 1 : undefined),
    enabled: searching,
  })
  const searchHits = useMemo(
    () => searchResultsQ.data?.pages.flatMap((p) => p.hits) ?? [],
    [searchResultsQ.data],
  )
  const searchTotal = searchResultsQ.data?.pages[0]?.total ?? 0
  const detailQ = useQuery({
    queryKey: ['foil', 'card', sel.cardId],
    queryFn: ({ signal }) => foilApi.cardDetail(sel.cardId!, signal),
    enabled: Boolean(sel.cardId),
  })
  // The old `devSurface` probe asked "is the dev api mounted here". Nothing is
  // mounted or unmounted any more — the corpus is a set of committed files that
  // anybody can read — so the only remaining question is who may WRITE, and
  // that is `canWrite` above.
  // Canon pattern defaults (locked on surface A) — the slider baseline here.
  const canonQ = useQuery({ queryKey: ['foil', 'canon'], queryFn: ({ signal }) => foilApi.getCanon(signal) })
  // Saved per-card overrides for the selected card/variant (sparse vs canon).
  const overrideQ = useQuery({
    queryKey: ['foil', 'override', sel.cardId, sel.variantId],
    queryFn: ({ signal }) => foilApi.getOverride(sel.cardId!, sel.variantId!, signal),
    enabled: Boolean(sel.cardId) && sel.variantId != null,
  })

  // Auto-select down the chain, but ONLY into empty slots (prefer the classic
  // demo: Base Set Machamp). A selection that isn't in the current browse list
  // (picked via search, or hidden by Owned-only) is preserved, never clobbered.
  //
  // ALL THREE ARE HELD while a deep link is resolving — see `deepLink`. The
  // guard is on every one of them rather than only on the set step that does
  // the clobbering, because the chain is a chain: letting the series step run
  // is what enables the set step one render later.
  useEffect(() => {
    if (deepLink !== null) return
    if (!sel.seriesSlug && seriesQ.data?.length) {
      const base = seriesQ.data.find((s) => s.slug === 'base')
      setSel((p) => ({ ...p, seriesSlug: (base ?? seriesQ.data[0]).slug }))
    }
  }, [seriesQ.data, sel.seriesSlug, deepLink])
  useEffect(() => {
    if (deepLink !== null) return
    if (sel.seriesSlug && setsQ.data?.length && !sel.setId) {
      const base1 = setsQ.data.find((s) => s.setId === 'base1')
      setSel((p) => ({ ...p, setId: (base1 ?? setsQ.data[0]).setId, cardId: undefined, variantId: undefined }))
    }
  }, [setsQ.data, sel.seriesSlug, sel.setId, deepLink])
  useEffect(() => {
    if (deepLink !== null) return
    if (sel.setId && cards.length && !sel.cardId) {
      const machamp = cards.find((c) => c.cardId === 'base1-8')
      setSel((p) => ({ ...p, cardId: (machamp ?? cards[0]).cardId, variantId: undefined }))
    }
  }, [cards, sel.setId, sel.cardId, deepLink])
  // Keep the browse chain pointed at the shown card's home (a search pick can
  // jump to any set/series in the catalog). This is also the effect that
  // RESOLVES a deep link — the card detail is the only thing that knows which
  // series and set the requested card lives in.
  useEffect(() => {
    const d = detailQ.data
    if (!d) return
    setSel((p) =>
      p.cardId === d.card.cardId && (p.seriesSlug !== d.card.series.slug || p.setId !== d.card.set.setId)
        ? { ...p, seriesSlug: d.card.series.slug, setId: d.card.set.setId }
        : p,
    )
  }, [detailQ.data])
  // Release the hold once the chain agrees with the card that loaded — or at
  // once if the catalog has no entry for the requested id, because a deep link
  // to a card that does not exist must degrade to the normal picker rather than
  // freeze it.
  useEffect(() => {
    if (deepLink === null) return
    if (detailQ.isError) {
      setDeepLink(null)
      return
    }
    const d = detailQ.data
    if (!d || d.card.cardId !== deepLink) return
    if (sel.cardId === deepLink && sel.seriesSlug === d.card.series.slug && sel.setId === d.card.set.setId) {
      setDeepLink(null)
    }
  }, [deepLink, detailQ.data, detailQ.isError, sel.cardId, sel.seriesSlug, sel.setId])
  useEffect(() => {
    const vs = detailQ.data?.variants
    if (vs?.length && !vs.some((v) => v.variantId === sel.variantId)) {
      // The old rule was owned-holo > any-owned > any-holo > first. Ownership
      // is gone, so the foil-bearing kind is simply the interesting default —
      // which is what the rule was reaching for anyway.
      const holo = (v: FoilVariant) => v.kind.toLowerCase().includes('holo')
      const pick = vs.find(holo) ?? vs[0]
      setSel((p) => ({ ...p, variantId: pick.variantId }))
    }
  }, [detailQ.data, sel.variantId])

  const detail = detailQ.data
  const variant = detail?.variants.find((v) => v.variantId === sel.variantId) ?? null

  // ── Resolve pattern + mask ──
  const resolved = useMemo(
    () =>
      resolveFoil({
        seriesSlug: detail?.card.series.slug ?? sel.seriesSlug ?? '',
        rarity: detail?.card.rarity ?? null,
        variantKind: variant?.kind ?? null,
        // Set + card identity feed the cited assignment/usage lookups (v3 resolver).
        setId: detail?.card.set.setId ?? sel.setId ?? null,
        setName: detail?.card.set.name ?? null,
        cardName: detail?.card.name ?? null,
        cardId: detail?.card.cardId ?? sel.cardId ?? null,
      }),
    [detail, variant, sel.seriesSlug, sel.setId],
  )
  const effectivePatternId = patternOverride === 'auto' ? resolved.patternId : patternOverride
  const effectiveScope = scopeOverride === 'auto' ? resolved.scope : scopeOverride
  const pattern = patternById(effectivePatternId)
  // layoutMask = the DETERMINISTIC era-rule output (always the sidecar prior);
  // mask = what the viewer/editor actually uses — an adjusted window geometry
  // replaces the era rect for window/sheet scopes (sheet = same box, inverted).
  const layoutMask = maskForScope(effectiveScope, resolved.eraId)
  const windowScoped = effectiveScope === 'window' || effectiveScope === 'sheet'
  const mask =
    windowScoped && winGeom ? { rect: winGeom.rect, radius: winGeom.radius, invert: layoutMask.invert } : layoutMask
  // Does the live geometry actually differ from the era rule?
  const winDiffers = Boolean(
    winGeom &&
      (winGeom.rect.some((v, i) => Math.abs(v - layoutMask.rect[i]!) > 1e-4) ||
        Math.abs(winGeom.radius - layoutMask.radius) > 1e-4),
  )

  // ── Staging: which session owns this printing ────────────────────────────
  //
  // DERIVED FROM THE STORE, never held in its own state. It used to be a
  // `useState` synchronised by an effect, which meant `staged` lagged the
  // selection by one commit — and every guard written against it was therefore
  // reading the PREVIOUS card's session for one render. A memo over the store's
  // own list cannot lag, because there is nothing to synchronise.
  const stagedId = detail && sel.variantId != null ? `mask:${detail.card.cardId}:${sel.variantId}` : null
  const staged = useMemo<MaskSession | null>(
    () =>
      stagedId === null
        ? null
        : ((staging.sessions.find((x) => x.id === stagedId && x.kind === 'mask') as MaskSession | undefined) ?? null),
    [stagedId, staging.sessions],
  )
  /**
   * DOES A STAGED SESSION OWN THE CANVAS?
   *
   * This is the whole of HIGH-1. A staged session's PNG is a contributor's only
   * copy of work that exists nowhere else — not on a server, not in a git
   * object, nowhere — so for the printing it belongs to it beats upstream
   * unconditionally. A session re-seeded through the conflict flow carries
   * `png: null` on purpose (the canvas was repainted from upstream at the time
   * the choice was made), and that case must still load upstream, which is why
   * this asks about the pixels rather than about the record.
   */
  const stagedPixels = staged !== null && staged.png !== null

  /**
   * Per-selection reset. ALWAYS runs, whoever ends up owning the canvas — it is
   * about the surface, not about the pixels. Kept out of the mask loader below
   * precisely so that guarding the loader cannot also disable the reset.
   */
  useEffect(() => {
    setEditMode(false)
    setMaskDirty(false)
    setSavedMask(false)
    setMaskMeta(null)
    setMaskSidecar(null)
    setSession({ startedFrom: 'layout', parent: null, painted: false })
    setProvisional(null)
    setProvisionalStale(false)
    setGhostPng(null)
    setMaskSaveStatus('idle')
    setMaskSaveError(null)
    // A different printing is a different canvas, so the staged-restore latch
    // has to let the next session paint. Without this, leaving a staged card
    // and coming back showed the pixels of whatever was opened in between.
    restoredFor.current = null
  }, [detail?.card.cardId, sel.variantId])

  // ── Saved hand mask: load on card/variant change (beats the layout tier) ──
  //
  // …but a STAGED SESSION beats it in turn. This effect is a network fetch and
  // the staged restore below is a data-URL decode, so upstream always won that
  // race; the session record survived a reload while its pixels were silently
  // replaced, and the next "Save to session" then wrote the replacement over
  // the contribution. Ordering is not a fix for that — the guard is.
  useEffect(() => {
    if (!detail || sel.variantId == null) return
    // Not "no session": "we have not read the store yet". Loading upstream on
    // the strength of an unread store is the same bug with better timing.
    if (staging.loading) return
    if (stagedPixels) return
    let cancelled = false
    // Artwork-keyed lookup: pass the variant's resolved scope so a sibling
    // variant's mask on the same scan can answer (aliasOf in the meta).
    const cardId = detail.card.cardId
    const variantId = sel.variantId
    void foilApi.getMask(cardId, variantId, resolved.scope).then((r) => {
      if (cancelled) return
      if (r) {
        const ctx = maskCanvas.getContext('2d')!
        ctx.clearRect(0, 0, MASK_W, MASK_H)
        ctx.drawImage(r.bitmap, 0, 0, MASK_W, MASK_H)
        setSavedMask(true)
        setMaskMeta(r.meta)
        setMaskSource('hand')
        setMaskTexVersion((v) => v + 1)
        // The mask that answered IS the parent of whatever gets saved next —
        // an aliased answer means the sibling variant's file, not this one.
        setSession({
          startedFrom: 'mask',
          parent: { cardId, variantId: r.meta.aliasOf ?? variantId },
          painted: false,
        })
        void foilApi.maskMeta(cardId, variantId, resolved.scope).then((m) => {
          if (!cancelled) setMaskSidecar(m?.sidecar ?? null)
        })
      } else {
        setSavedMask(false)
        setMaskMeta(null)
        setMaskSource('layout')
      }
    })
    return () => {
      cancelled = true
    }
  }, [detail, sel.variantId, maskCanvas, resolved.scope, staging.loading, stagedPixels])

  // ── Saved window geometry: load on card/variant change (pre-flatten state).
  // Artwork-keyed like masks — a sibling variant's geometry on the same scan
  // answers (aliasOf reports which).
  useEffect(() => {
    setAdjustMode(false)
    setWinGeom(null)
    setWinSaved(null)
    setWinDirty(false)
    setWinStatus('idle')
    if (!detail || sel.variantId == null) return
    let cancelled = false
    void foilApi.getWindow(detail.card.cardId, sel.variantId).then((r) => {
      if (cancelled || !r) return
      setWinGeom({ rect: r.entry.rect, radius: r.entry.radius })
      setWinSaved({ savedAt: r.entry.savedAt, aliasOf: r.aliasOf })
    })
    return () => {
      cancelled = true
    }
  }, [detail, sel.variantId])

  // ── Uniforms: canon baseline + saved card overrides, live in state + ref ──
  // Layering (foil/canon.ts): code defaults < canon file < per-card override
  // < live sliders. Reseed ONLY when the seed key changes (pattern, canon
  // save, card/variant, override save) — background refetches with identical
  // data never clobber in-progress slider tweaks.
  const canon = canonFor(canonQ.data ?? undefined, pattern.id)
  const baseline = useMemo(() => canonBaseline(pattern, canon), [pattern, canon])
  const override =
    overrideQ.data && canonicalPatternId(overrideQ.data.patternId) === pattern.id ? overrideQ.data : null
  const [uniforms, setUniforms] = useState<Record<string, number>>(() => canonBaseline(pattern, undefined))
  const seedKey = `${pattern.id}|${canon?.savedAt ?? 'code'}|${sel.cardId ?? ''}|${sel.variantId ?? ''}|${override?.savedAt ?? 'none'}`
  const lastSeed = useRef<string | null>(null)
  useEffect(() => {
    if (lastSeed.current === seedKey) return
    lastSeed.current = seedKey
    setUniforms({ ...baseline, ...(override?.uniforms ?? {}) })
  }, [seedKey, baseline, override])

  /**
   * Sparse live diff vs the canon baseline — the per-card override.
   *
   * THERE IS NO "SAVE CARD OVERRIDES" BUTTON, and its absence is the fix rather
   * than an omission. It called `putOverride`, which threw unconditionally
   * because no `/api/override` route exists and `data/foil-overrides/` has
   * never held a record. Pressing it produced a red "Override save failed" that
   * blamed a server for refusing a request it was never sent — a button that
   * cannot succeed is worse than no button.
   *
   * Per-card overrides are SESSION CONTENTS (spec 8), and they already are:
   * `stageMask` writes `uniforms: overrideDiff` into the staged session for
   * everybody, writer capability or not. So the sliders are staged with the
   * mask, and the panel says so.
   */
  const overrideDiff = useMemo(() => sparseDiff(uniforms, baseline), [uniforms, baseline])
  const overrideDiffKeys = Object.keys(overrideDiff)

  // ── Staging: the session for this card+variant ───────────────────────
  //
  // `stagedId` / `staged` / `stagedPixels` are computed further up, next to the
  // mask loader they guard. The session is keyed by card+variant, so walking
  // away and coming back finds the work. It is ADOPTED rather than recreated:
  // when a staged session exists its seed wins over whatever a fresh page load
  // resolved, because the seed IS the provenance claim and re-deriving it would
  // silently reparent the correction onto whatever happens to be upstream today.
  //
  // Restore staged pixels onto the canvas when a staged session is adopted.
  useEffect(() => {
    if (staged === null || staged.png === null) return
    if (restoredFor.current === staged.id) return
    restoredFor.current = staged.id
    const img = new Image()
    img.onload = () => {
      const ctx = maskCanvas.getContext('2d')!
      ctx.clearRect(0, 0, MASK_W, MASK_H)
      ctx.drawImage(img, 0, 0, MASK_W, MASK_H)
      setMaskSource('hand')
      setSavedMask(false)
      setMaskDirty(false)
      setMaskTexVersion((v) => v + 1)
      setSession({ startedFrom: staged.seed.startedFrom, parent: staged.seed.parent, painted: true })
    }
    img.src = staged.png
  }, [staged, maskCanvas])

  // The conflict check, run whenever a staged session is on screen rather than
  // only at submit — a contributor should learn that upstream moved BEFORE they
  // spend another hour on top of it.
  useEffect(() => {
    if (staged === null) {
      setConflict(null)
      return
    }
    let cancelled = false
    void foilApi.probeMask(staged.cardId, staged.variantId, staged.seed.prior.scope).then((probe) => {
      if (cancelled) return
      setConflict(
        detectMaskConflict(
          staged,
          probe === null
            ? { sha256: null, resolvedFrom: null, savedAt: null, method: null }
            : { sha256: probe.sha256, resolvedFrom: probe.resolvedFrom, savedAt: probe.savedAt, method: probe.method },
        ),
      )
    })
    return () => {
      cancelled = true
    }
  }, [staged])

  const handActive = maskSource === 'hand' || editMode
  const settingsRef = useRef<ViewerSettings>({
    uniforms,
    maskRect: mask.rect,
    maskRadius: mask.radius,
    maskFeather,
    maskInvert: mask.invert,
    maskView,
    maskTexOn: handActive,
    maskTexVersion,
    maxTiltDeg,
  })
  useEffect(() => {
    settingsRef.current = {
      uniforms,
      maskRect: mask.rect,
      maskRadius: mask.radius,
      maskFeather,
      maskInvert: mask.invert,
      maskView,
      maskTexOn: handActive,
      maskTexVersion,
      maxTiltDeg: editMode || adjustMode ? 0 : maxTiltDeg,
    }
  }, [uniforms, mask, maskFeather, maskView, maxTiltDeg, handActive, maskTexVersion, editMode, adjustMode])

  const setU = (k: string, v: number) => setUniforms((u) => ({ ...u, [k]: v }))

  const onStrokeEnd = useCallback(() => {
    setMaskDirty(true)
    setMaskSource('hand')
    setMaskTexVersion((v) => v + 1)
    // Human pixels touched this canvas — the save is no longer a pure bake.
    setSession((s) => (s.painted ? s : { ...s, painted: true }))
    setProvisionalStale(true)
  }, [])

  /**
   * A pinch/pan interrupted a stroke and the editor rolled those pixels back.
   * Refresh the shader's mask texture, but do NOT mark the mask dirty or the
   * session painted — nothing was actually drawn.
   */
  const onStrokeCancel = useCallback(() => {
    setMaskTexVersion((v) => v + 1)
  }, [])

  const registerEditor = useCallback((h: MaskEditorHandle) => {
    editorRef.current = h
  }, [])

  const startEdit = () => {
    setEditMode(true)
    // Editing starts from the current mask: saved hand mask if loaded,
    // otherwise rasterize the current window (adjusted geometry if present,
    // era rule otherwise) so he refines, not restarts.
    if (maskSource === 'layout') {
      // defer until the editor registered its handle
      requestAnimationFrame(() => {
        editorRef.current?.loadLayoutRect(mask.rect, mask.invert, mask.radius)
        setMaskSource('hand')
        setMaskTexVersion((v) => v + 1)
        seedFromGeometry()
      })
    }
  }

  /** The canvas was re-seeded from geometry — no parent, nothing painted yet. */
  const seedFromGeometry = () => {
    setSession({ startedFrom: windowScoped && winDiffers ? 'window-bake' : 'layout', parent: null, painted: false })
  }

  /**
   * The deterministic era-rule prior for the current selection.
   *
   * ALWAYS the rule’s own numbers, in every generation of the sidecar, so
   * `diff.agreement` never stops scoring the RULE against the saved mask — the
   * codify ritual depends on that. An adjusted window is the HUMAN’s
   * correction and rides along as `prior.window` provenance; it never replaces
   * the rule’s rect.
   */
  const currentPrior = () => ({
    source: 'layout' as const,
    eraId: resolved.eraId,
    scope: effectiveScope,
    rect: layoutMask.rect,
    radius: layoutMask.radius,
    invert: layoutMask.invert,
    feather: maskFeather,
    resolverVersion: RESOLVER_VERSION,
    ...(windowScoped && winGeom && winDiffers ? { window: { rect: winGeom.rect, radius: winGeom.radius } } : {}),
  })

  /**
   * Stage the current canvas.
   *
   * The seed is written ONCE, when the session is created, and every later
   * stage is an update that cannot reach it — which is what collapses ten saves
   * into one correction record. `updateMaskSession` has no path to the seed at
   * all, so that is structural rather than a rule somebody has to keep.
   */
  const stageMask = async () => {
    if (!detail || sel.variantId == null) return
    setStageStatus('saving')
    try {
      const png = maskCanvas.toDataURL('image/png')
      const now = new Date().toISOString()
      const next =
        staged === null
          ? seedMaskSession({
              cardId: detail.card.cardId,
              variantId: sel.variantId,
              card: {
                setId: detail.card.set.setId,
                seriesSlug: detail.card.series.slug,
                name: detail.card.name,
                number: detail.card.number,
              },
              artworkUrl: detail.card.images.high,
              startedFrom: session.startedFrom,
              parent: session.parent,
              resolvedFrom: session.parent
                ? { cardId: session.parent.cardId, variantId: maskMeta?.aliasOf ?? session.parent.variantId }
                : null,
              parentSha256: maskMeta?.sha256 ?? null,
              prior: currentPrior(),
              width: MASK_W,
              height: MASK_H,
              png,
              patternId: pattern.id,
              now,
            })
          : updateMaskSession(
              staged,
              {
                png,
                window:
                  windowScoped && winGeom && winDiffers
                    ? {
                        scope: effectiveScope,
                        eraId: resolved.eraId,
                        rect: winGeom.rect,
                        radius: winGeom.radius,
                        invert: layoutMask.invert,
                        base: {
                          rect: layoutMask.rect,
                          radius: layoutMask.radius,
                          resolverVersion: RESOLVER_VERSION,
                        },
                      }
                    : null,
                uniforms: overrideDiff,
                patternOverride: patternOverride === 'auto' ? null : canonicalPatternId(patternOverride),
                patternId: pattern.id,
                comment: commentText.trim().length > 0 ? commentText.trim() : staged.comment,
              },
              now,
            )
      // `staging.save` re-reads the store, so `staged` (a memo over that list)
      // already carries `next` by the time this resolves. Nothing to set.
      await staging.save(next)
      // The canvas holds exactly what was just staged, so the restore effect
      // must not repaint it from the round-tripped PNG.
      restoredFor.current = next.id
      setMaskDirty(false)
      setStageStatus('saved')
      setTimeout(() => setStageStatus('idle'), 1500)
    } catch {
      setStageStatus('error')
    }
  }

  /**
   * The PROVISIONAL local diff.
   *
   * The server decides `derivation_method` and `agreement` by diffing the saved
   * pixels against what the declared seed rasterizes to, and the client must
   * never label a mask. But the client OWNS the rasterizer, so the same number
   * is computable offline — and editing blind for a whole session is a poor
   * experience. Computed here, shown as provisional, never persisted.
   */
  const computeProvisional = () => {
    const ctx = maskCanvas.getContext('2d')
    if (ctx === null) return
    const img = ctx.getImageData(0, 0, MASK_W, MASK_H)
    setProvisionalStale(false)
    setProvisional(
      provisionalReport(
        alphaOfRgba(img.data, MASK_W * MASK_H),
        { rect: layoutMask.rect, radius: layoutMask.radius, invert: layoutMask.invert },
        MASK_W,
        MASK_H,
        null,
      ),
    )
  }

  // `override` exists because setSession is async: Flatten seeds and saves in
  // the same tick, so it passes the seed it just installed rather than racing.
  const saveMask = async (override?: typeof session) => {
    if (!detail || sel.variantId == null) return
    // THE FORK. A writer-capability holder writes straight through, exactly as
    // this workbench always did — routing his own work through
    // submit-and-review would put a queue between him and his own repository
    // for no gain. Everybody else stages, and never reaches the PUT at all.
    if (!canWrite) {
      await stageMask()
      return
    }
    const s = override ?? session
    setMaskSaveStatus('saving')
    setMaskSaveError(null)
    try {
      // Sidecar v3: every save records the starting prior — the deterministic
      // layout-rule output for this card/variant — so the server can persist
      // the prior render + mask-vs-prior diff next to the mask (the corpus
      // carries what the rule got wrong, not just the human's answer). An
      // adjusted window is the HUMAN's correction, so it rides along as
      // prior.window provenance and never replaces the rule's rect.
      //
      // `derivation` reports the SEED, not a label: the api recomputes the
      // honest derivation_method from the pixels (and, when the seed was an
      // existing mask, writes the correction record — parent PNG + change map
      // + metrics, which is the training signal for the generator lane).
      const saved = await foilApi.putMask(
        detail.card.cardId,
        sel.variantId,
        maskCanvas.toDataURL('image/png'),
        MASK_W,
        MASK_H,
        currentPrior(),
        { startedFrom: s.startedFrom, parent: s.parent },
        {
          artworkUrl: detail.card.images.high,
          card: {
            setId: detail.card.set.setId,
            seriesSlug: detail.card.series.slug,
            name: detail.card.name,
            number: detail.card.number,
          },
        },
      )
      setSavedMask(true)
      setMaskDirty(false)
      setMaskSidecar(saved)
      setMaskMeta({
        file: `data/foil-masks/${detail.card.cardId}/${sel.variantId}.png`,
        savedAt: saved.savedAt,
        aliasOf: null,
        hasPrior: true,
        hasDiff: true,
        method: saved.derivation_method,
        reviewStatus: saved.reviewStatus,
        sha256: null,
      })
      // What was just written becomes the parent of the next save.
      setSession({
        startedFrom: 'mask',
        parent: { cardId: detail.card.cardId, variantId: sel.variantId },
        painted: false,
      })
      setCorpusKey((k) => k + 1)
      setMaskSaveStatus('saved')
      setTimeout(() => setMaskSaveStatus('idle'), 1500)
    } catch (err) {
      // A SILENT FAILED SAVE LOSES WORK. `api.ts` already parses the server's
      // own error text out of the response and throws it; discarding that here
      // left a writer looking at a button that behaved exactly as it does on
      // success. So it is shown, in the server's words.
      //
      // AND THE PIXELS ARE NEVER TOUCHED. Nothing in this branch clears the
      // canvas, resets the session or drops the mask source — the drawing on
      // screen is the only copy of it, and the dirty flag is re-asserted so the
      // surface keeps saying there is unsaved work.
      setMaskSaveStatus('error')
      setMaskSaveError(err instanceof Error ? err.message : String(err))
      setMaskDirty(true)
    }
  }

  /**
   * OPEN AS PR INSTEAD — the writer's route through the contribution pipeline.
   *
   * WHY A WRITER GETS THIS AT ALL. The direct write exists because routing
   * Chey's own work through submit-and-review would put a queue between him and
   * his own repository for no gain, and that is still true for a mask he is
   * confident about. It stops being true the moment a change wants a second
   * look — a re-trace of somebody else's window, a supersede, anything he wants
   * the render evidence for before it lands on `main`. So the affordance is a
   * SECOND button rather than a mode: same session, same rails as every
   * contributor's, and the choice is per-save.
   *
   * The second reason is less noble and more important: it makes the pipeline
   * LIVE-TESTABLE by the one person who can fix it. A contribution path only
   * the maintainer cannot exercise is a contribution path nobody notices has
   * broken.
   *
   * The conflict is PROBED here rather than assumed fresh. A lab tab left open
   * for an hour has a seed that may no longer match upstream, and submitting it
   * as `fresh` would put a sentence in the pull request that is not true.
   */
  const openAsPr = async () => {
    if (!detail || sel.variantId == null) return
    setPrBusy(true)
    setPrResult(null)
    try {
      // Stage first, unconditionally: the pipeline submits a SESSION, and the
      // session is also what survives if the submission fails.
      await stageMask()
      const s = await staging.store.get(`mask:${detail.card.cardId}:${sel.variantId}`)
      if (s === null || s.kind !== 'mask') throw new Error('the session was not staged')
      const probe = await foilApi.probeMask(s.cardId, s.variantId, s.seed.prior.scope)
      const conflict = detectMaskConflict(
        s,
        probe === null
          ? { sha256: null, resolvedFrom: null, savedAt: null, method: null }
          : { sha256: probe.sha256, resolvedFrom: probe.resolvedFrom, savedAt: probe.savedAt, method: probe.method },
      )
      setPrResult(await foilApi.submitContribution(buildMaskContribution(s, conflict, await provisionalOf(s))))
    } catch (err) {
      setPrResult({
        ok: false,
        kind: 'failed',
        message: err instanceof Error ? err.message : String(err),
        checks: [],
        failures: [],
        missing: [],
      })
    } finally {
      setPrBusy(false)
    }
  }

  // ── Adjusted-window actions (handles → save/flatten) ──

  const startAdjust = () => {
    setAdjustMode(true)
    // Start from the saved/live geometry if any, else the era rule.
    if (!winGeom) setWinGeom({ rect: layoutMask.rect, radius: layoutMask.radius })
    // Show the coverage overlay while dragging — the whole point is aligning
    // the rect to the printed window; restored on Done.
    preAdjustMaskView.current = maskView
    setMaskView(true)
  }

  const endAdjust = () => {
    setAdjustMode(false)
    setMaskView(preAdjustMaskView.current)
  }

  const saveWindow = async (): Promise<boolean> => {
    if (!detail || sel.variantId == null || !winGeom) return false
    // Geometry rides along inside the staged session rather than becoming its
    // own write — one session, one card, one eventual PR.
    if (!canWrite) {
      await stageMask()
      return true
    }
    setWinStatus('saving')
    setWinError(null)
    try {
      if (!winDiffers) {
        // Geometry matches the era rule — a file would say nothing; remove it.
        if (winSaved) await foilApi.deleteWindow(detail.card.cardId, sel.variantId)
        setWinSaved(null)
      } else {
        const e = await foilApi.putWindow(detail.card.cardId, sel.variantId, {
          scope: effectiveScope,
          eraId: resolved.eraId,
          rect: winGeom.rect,
          radius: winGeom.radius,
          invert: layoutMask.invert,
          base: { rect: layoutMask.rect, radius: layoutMask.radius, resolverVersion: RESOLVER_VERSION },
        })
        setWinSaved({ savedAt: e.savedAt, aliasOf: null })
      }
      setWinDirty(false)
      setWinStatus('saved')
      setTimeout(() => setWinStatus('idle'), 1500)
      return true
    } catch (err) {
      setWinStatus('error')
      setWinError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  const resetWindow = () => {
    setWinGeom({ rect: layoutMask.rect, radius: layoutMask.radius })
    setWinDirty(true)
  }

  /**
   * Flatten: persist the geometry, bake it into a raster mask through the
   * STANDARD save path (sidecar v3 — prior = era rule, prior.window = the
   * adjustment), then open the existing paint tooling to refine it. From the
   * save on, the card behaves exactly like any hand-masked card (artwork-keyed
   * aliasing included).
   *
   * PROVENANCE: the bake is MACHINE geometry — no stroke has been painted yet —
   * so it lands as `layout-flatten`, not `hand`. The first stroke on top of it
   * promotes the next save to `hand-refined`. (Before sidecar v3 this path
   * stamped 'hand' and quietly claimed a rect as human work.)
   */
  const flattenWindow = async () => {
    if (!detail || sel.variantId == null || !winGeom) return
    await saveWindow() // pre-flatten state survives even if the mask save fails
    rasterizeWindowRect(maskCanvas, mask.rect, mask.invert, mask.radius, MASK_TINT)
    setMaskSource('hand')
    setMaskDirty(true) // cleared by the save below; stays visible if it fails
    setMaskTexVersion((v) => v + 1)
    setSession({ startedFrom: 'window-bake', parent: null, painted: false })
    await saveMask({ startedFrom: 'window-bake', parent: null, painted: false })
    endAdjust()
    setEditMode(true)
  }

  /**
   * DELETIONS ARE NOT STAGEABLE IN v1.
   *
   * This stays a live affordance for a writer-capability holder and is absent
   * for everyone else — a contributor’s first available action should not be
   * removing ground truth, and a deletion has no diff to review: the PR would
   * be an empty file and a claim.
   */
  const deleteMask = async () => {
    if (!detail || sel.variantId == null || !canWrite) return
    setMaskSaveStatus('saving')
    setMaskSaveError(null)
    try {
      await foilApi.deleteMask(detail.card.cardId, sel.variantId)
    } catch (err) {
      // The delete was REFUSED, so the mask is still there. Clearing the
      // surface anyway — which is what this used to do — reported a success the
      // repository never granted, and the next reload silently contradicted it.
      setMaskSaveStatus('error')
      setMaskSaveError(err instanceof Error ? err.message : String(err))
      return
    }
    setMaskSaveStatus('idle')
    setSavedMask(false)
    setMaskDirty(false)
    setMaskMeta(null)
    setMaskSidecar(null)
    setSession({ startedFrom: 'layout', parent: null, painted: false })
    setMaskSource('layout')
    setEditMode(false)
    setCorpusKey((k) => k + 1)
  }

  /**
   * Resolve a conflict.
   *
   * `keep-mine` changes NOTHING about the payload, and that is the point:
   * `writeMaskRecord` reads the parent from disk at write time, so the
   * correction is recorded against current upstream automatically. The staging
   * layer defers the write; it does not reinterpret it. So this only dismisses
   * the banner.
   *
   * `take-theirs` and `re-trace` are the same re-seed with a different answer
   * to "what happens to the pixels" — dropped, or kept as a ghost to redraw
   * against deliberately. Nothing is ever merged.
   */
  const resolveConflict = async (choice: 'keep-mine' | 'take-theirs' | 're-trace') => {
    if (staged === null || detail === undefined || sel.variantId == null) return
    if (choice === 'keep-mine') {
      setConflict(null)
      return
    }
    const fresh = await foilApi.getMask(staged.cardId, staged.variantId, staged.seed.prior.scope)
    const now = new Date().toISOString()
    const reseeded = reseedMaskSession(
      staged,
      {
        cardId: staged.cardId,
        variantId: staged.variantId,
        startedFrom: fresh === null ? 'layout' : 'mask',
        parent: fresh === null ? null : { cardId: staged.cardId, variantId: fresh.meta.aliasOf ?? staged.variantId },
        resolvedFrom:
          fresh === null ? null : { cardId: staged.cardId, variantId: fresh.meta.aliasOf ?? staged.variantId },
        parentSha256: fresh?.meta.sha256 ?? null,
        prior: currentPrior(),
        width: MASK_W,
        height: MASK_H,
        png: null,
        now,
      },
      choice,
    )
    // Repaint the canvas from upstream (or from the era rule when upstream has
    // nothing), then hand the old pixels back as a ghost if they were kept.
    const ctx = maskCanvas.getContext('2d')!
    ctx.clearRect(0, 0, MASK_W, MASK_H)
    if (fresh !== null) ctx.drawImage(fresh.bitmap, 0, 0, MASK_W, MASK_H)
    else editorRef.current?.loadLayoutRect(mask.rect, mask.invert, mask.radius)
    setMaskTexVersion((v) => v + 1)
    setGhostPng(reseeded.ghostPng)
    restoredFor.current = reseeded.session.id // the canvas is already correct
    await staging.save({ ...reseeded.session, png: null })
    setConflict(null)
    setMaskDirty(false)
  }

  /**
   * What the NEXT save will be stamped as, so the badge never surprises him.
   * The api recomputes this from pixels — this is a faithful preview of the
   * same rules (foil/provenance.ts deriveMethod).
   */
  const pendingMethod = (): FoilDerivationMethod => {
    const parentMethod = session.parent ? (maskSidecar?.derivation_method ?? 'hand') : null
    if (!session.painted) return parentMethod ?? 'layout-flatten'
    if (parentMethod === 'ai' || parentMethod === 'ai-corrected') return 'ai-corrected'
    return parentMethod ? 'hand-refined' : 'hand'
  }

  const commentContext = (): Record<string, unknown> => ({
    surface: 'card-adjust',
    cardId: detail?.card.cardId,
    variantId: sel.variantId,
    // Canon/override linkage: which canon save the sliders were baselined on,
    // and whether saved card overrides were active.
    canonSavedAt: canon?.savedAt ?? null,
    overrideSavedAt: override?.savedAt ?? null,
    overrideDirtyKeys: overrideDiffKeys,
    variantKind: variant?.kind,
    pattern: effectivePatternId,
    patternOverride,
    scope: effectiveScope,
    era: resolved.eraId,
    maskSource,
    maskEditActive: editMode,
    maskDirty,
    savedMask,
    // Adjusted-window linkage (foil/mask-refine): the geometry state this
    // comment describes — live rect, save state, alias source.
    windowAdjustActive: adjustMode,
    windowAdjusted: winDiffers,
    ...(winGeom && winDiffers ? { windowRect: winGeom.rect, windowRadius: winGeom.radius } : {}),
    ...(winSaved ? { windowSavedAt: winSaved.savedAt, windowAliasOf: winSaved.aliasOf } : {}),
    // Comment↔mask linkage (automatic): the exact saved mask state this
    // comment describes — file, savedAt, alias source, prior/diff presence.
    ...(maskMeta
      ? {
          maskFile: maskMeta.file,
          maskSavedAt: maskMeta.savedAt,
          maskAliasOf: maskMeta.aliasOf,
          maskHasPriorDiff: maskMeta.hasPrior && maskMeta.hasDiff,
        }
      : {}),
    tiltMode: tilt.mode,
    uniforms,
    maskFeather,
    maxTiltDeg,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    ts: new Date().toISOString(),
  })

  /**
   * A contributor’s note about their own change belongs in the REVIEW, not in
   * the tree. The old route wrote `issues/foil/<id>/report.md` + `context.json`
   * into the repository; a stranger’s note about their own work is PR body
   * text, and that is now literally where it goes: `composePrBody` puts it at
   * the top of the pull request, under “What the contributor said”.
   *
   * It is stored in the staged session and carried in the export — stored,
   * exported and submitted, never committed into the tree. The captured
   * context travels with it, which is why the pull request body can be
   * assembled without re-deriving anything.
   */
  const submitComment = async () => {
    const text = commentText.trim()
    if (!text) return
    setCommentStatus('saving')
    try {
      if (staged !== null) {
        await staging.save(updateMaskSession(staged, { comment: text }, new Date().toISOString()))
      } else {
        // Nothing staged yet: staging the canvas is what creates the session
        // the comment lives on, so the note is never orphaned.
        await stageMask()
      }
      void commentContext()
      setCommentStatus('saved')
      setCommentText('')
      setTimeout(() => {
        setCommentStatus('idle')
        setCommentOpen(false)
      }, 900)
    } catch {
      setCommentStatus('error')
    }
  }

  const copyRecipe = async () => {
    const recipe = {
      pattern: effectivePatternId,
      scope: effectiveScope,
      era: resolved.eraId,
      card: detail?.card.cardId,
      variant: variant?.kind,
      maskSource,
      uniforms,
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(recipe, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (http LAN) — no-op */
    }
  }

  const imageUrl = detail?.card.images.high ? proxied(detail.card.images.high) : null
  const cardRect = cardScreenRect(hostSize.w, hostSize.h)

  // A HEAD, not a second GET: `/api/image` answers every header and no body for
  // one, which is exactly the "does this scan exist" question. Only asked of
  // OUR proxy — a cross-origin url's status is not readable, and guessing at one
  // would put a wrong explanation under a card that renders fine.
  useEffect(() => {
    setScan('unknown')
    if (imageUrl === null || !imageUrl.startsWith('/api/image')) return
    const ac = new AbortController()
    void fetch(imageUrl, { method: 'HEAD', signal: ac.signal })
      .then((r) => setScan(r.ok ? 'ok' : r.status === 404 ? 'missing' : 'upstream-error'))
      // Aborted, offline, or a deployment with no functions at all. Say nothing
      // rather than blame upstream for something that never reached it.
      .catch(() => undefined)
    return () => ac.abort()
  }, [imageUrl])

  // Era-grouped picker: series bucketed by frame generation. Series with no
  // era-layouts.json mapping get an honest "other" bucket rather than being
  // silently lumped under the SV header (the resolver still falls back to
  // modern-sv rects for them — that's the layout prior, not the grouping).
  const mappedSlugs = useMemo(() => new Set(Object.values(ERAS).flatMap((e) => e.seriesSlugs)), [])
  const eraGroups = useMemo(() => {
    const groups: { eraId: string; label: string; series: NonNullable<typeof seriesQ.data> }[] = []
    for (const s of seriesQ.data ?? []) {
      const mapped = mappedSlugs.has(s.slug)
      const eraId = mapped ? resolveFoil({ seriesSlug: s.slug, rarity: null, variantKind: null }).eraId : 'other'
      let g = groups.find((x) => x.eraId === eraId)
      if (!g) {
        g = {
          eraId,
          label: mapped ? ERAS[eraId as keyof typeof ERAS].label : 'Other eras (no layout spec yet — SV rects)',
          series: [],
        }
        groups.push(g)
      }
      g.series.push(s)
    }
    return groups
  }, [seriesQ.data, mappedSlugs])

  return (
    <div className="flex min-h-screen flex-col bg-surface-primary text-text-primary min-[700px]:h-screen min-[700px]:flex-row min-[700px]:overflow-hidden">
      {/* ── Viewer column ── */}
      <div
        ref={viewerWrapRef}
        className="relative h-[52vh] shrink-0 select-none bg-[#0b0d12] [-webkit-touch-callout:none] min-[700px]:h-full min-[700px]:flex-1"
        onDragStart={(e) => e.preventDefault()}
      >
        <CardViewer
          imageUrl={imageUrl}
          pattern={pattern}
          settingsRef={settingsRef}
          tiltTarget={editMode || adjustMode ? zeroTilt : tilt.target}
          maskCanvas={handActive ? maskCanvas : null}
          view={viewCtl}
          onPointerMove={editMode || adjustMode ? undefined : tilt.onPointerMove}
          onPointerLeave={editMode || adjustMode ? undefined : tilt.onPointerLeave}
          className="h-full w-full"
        >
          {editMode && cardRect.width > 0 && (
            <MaskEditor
              canvas={maskCanvas}
              rect={cardRect}
              mode={brushMode}
              brushSize={brushSize}
              allowTouch={allowTouch}
              view={viewCtl}
              onStrokeEnd={onStrokeEnd}
              onStrokeCancel={onStrokeCancel}
              registerHandle={registerEditor}
            />
          )}
          {adjustMode && !editMode && cardRect.width > 0 && winGeom && (
            <WindowEditor
              rect={cardRect}
              value={winGeom}
              view={viewCtl}
              onChange={(v) => {
                setWinGeom(v)
                setWinDirty(true)
              }}
            />
          )}
        </CardViewer>
        {(editMode || adjustMode) && (
          <ZoomHud ctl={viewCtl} className="absolute bottom-[52px] right-[12px]" />
        )}
        <div className="pointer-events-none absolute left-[12px] top-[10px] text-[12px]">
          <div className="font-semibold">{detail ? detail.card.name : 'Foil workbench'}</div>
          <div className="text-text-muted">
            {detail ? `${detail.card.set.name} · #${detail.card.number}` : 'pick a card below'}
            {variant ? ` · ${variant.displayName}` : ''}
          </div>
        </div>
        {(scan === 'missing' || scan === 'upstream-error') && (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 max-w-[280px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-amber-500/50 bg-surface-secondary/90 p-[10px] text-center text-[12px] leading-[1.5] text-amber-200"
            data-testid="scan-unavailable"
          >
            {scan === 'missing'
              ? 'Scan unavailable upstream — this printing has no image at the catalog’s path. The foil renders over an empty base; the mask work is still valid.'
              : 'Upstream answered, but not with a scan. The CDN is erroring rather than reporting a missing card — try again later.'}
          </div>
        )}
        <div className="pointer-events-none absolute right-[12px] top-[10px] rounded-full bg-surface-secondary/70 px-[8px] py-[2px] text-[11px] text-text-muted">
          {editMode ? 'mask edit' : adjustMode ? 'window adjust' : tilt.mode}
          {handActive && !editMode ? ' · hand mask' : ''}
          {!handActive && !adjustMode && windowScoped && winDiffers ? ' · window adjusted' : ''}
        </div>
        {(
          <button
            onClick={() => setCommentOpen(true)}
            className="absolute bottom-[12px] left-[12px] rounded-full border border-border-default bg-surface-secondary/85 px-[12px] py-[7px] text-[12px] text-text-primary hover:border-action-primary"
          >
            + Comment
          </button>
        )}
        {editMode && (
          <div className="absolute bottom-[12px] right-[12px] flex gap-[6px]">
            <ActionBtn active={brushMode === 'brush'} onClick={() => setBrushMode('brush')}>
              Brush
            </ActionBtn>
            <ActionBtn active={brushMode === 'erase'} onClick={() => setBrushMode('erase')}>
              Erase
            </ActionBtn>
            <ActionBtn onClick={() => editorRef.current?.undo()}>Undo</ActionBtn>
          </div>
        )}
      </div>

      {/* ── Controls column ── */}
      <div className="flex-1 space-y-[12px] overflow-y-auto p-[12px] min-[700px]:w-[360px] min-[700px]:flex-none min-[700px]:shrink-0 min-[1200px]:w-[400px]">
        <SurfaceTabs active="card" />

        {/*
          A deep link the catalog cannot answer for. The auto-select chain takes
          over from here — that is the right fallback — but doing it SILENTLY is
          what made "Work this sent me to Base Set Machamp" a mystery rather than
          a message.
        */}
        {detailQ.isError && sel.cardId !== undefined && (
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-[10px] text-[13px] text-amber-200">
            No catalog entry for <code>{sel.cardId}</code> in this bake, so the picker fell back to its
            default card. Either the id is wrong, or this deploy&rsquo;s catalog is older than the link.
          </p>
        )}

        <Section title="Card (full catalog, by era)">
          <div className="mb-[8px] flex items-center gap-[8px]">
            <input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search all cards…"
              className="min-w-0 flex-1 rounded-md border border-border-default bg-surface-tertiary px-[8px] py-[6px] text-[13px] text-text-primary placeholder:text-text-muted"
            />
          </div>
          {/*
            The replacement for the owned-only chip. Contribution-shaped, not
            collection-shaped: what a contributor wants to narrow to is work
            that is or is not done, and the manifest is what knows.
          */}
          <div className="mb-[8px] flex flex-wrap gap-[6px]">
            {(['all', 'no-mask', 'has-mask', 'has-window'] as const).map((f) => (
              <Chip key={f} active={filter === f} onClick={() => setFilter(f)} disabled={corpus === null}>
                {FILTER_LABEL[f]}
              </Chip>
            ))}
          </div>
          {searching ? (
            <div>
              <div className="max-h-[300px] space-y-[2px] overflow-y-auto">
                {searchHits.map((h) => (
                  <button
                    key={h.cardId}
                    onClick={() => {
                      setSel((p) => ({ ...p, cardId: h.cardId, variantId: undefined }))
                      setSearchText('')
                    }}
                    className={`flex w-full items-center gap-[8px] rounded-md px-[4px] py-[3px] text-left hover:bg-surface-tertiary ${
                      h.cardId === sel.cardId ? 'bg-action-primary/10' : ''
                    }`}
                  >
                    <img
                      src={h.images.low === '' ? undefined : proxied(h.images.low)}
                      alt=""
                      loading="lazy"
                      className="w-[30px] shrink-0 rounded-[2px]"
                      style={{ aspectRatio: '245 / 337' }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-text-primary">{h.name}</span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {h.set.name} · #{h.number}
                        {h.rarity ? ` · ${h.rarity}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
                {searchResultsQ.isLoading && <p className="py-[6px] text-[12px] text-text-muted">searching…</p>}
                {!searchResultsQ.isLoading && searchHits.length === 0 && (
                  <p className="py-[6px] text-[12px] text-text-muted">No catalog match for “{searchQ}”.</p>
                )}
                {searchResultsQ.hasNextPage && (
                  <button
                    onClick={() => void searchResultsQ.fetchNextPage()}
                    className="w-full rounded-md border border-border-default py-[6px] text-[12px] text-text-muted hover:border-action-primary"
                  >
                    {searchResultsQ.isFetchingNextPage ? 'loading…' : `More (${searchTotal - searchHits.length} left)`}
                  </button>
                )}
              </div>
              {searchHits.length > 0 && (
                <p className="mt-[6px] text-[11px] text-text-muted">
                  {searchTotal} match{searchTotal === 1 ? '' : 'es'} in the whole catalog (ignores the filter)
                </p>
              )}
            </div>
          ) : (
            <>
              {eraGroups.map((g) => (
                <div key={g.eraId} className="mb-[6px]">
                  <div className="mb-[4px] text-[10px] uppercase tracking-[0.06em] text-text-muted">{g.label}</div>
                  <div className="flex gap-[6px] overflow-x-auto pb-[2px]">
                    {g.series.map((s) => (
                      <Chip
                        key={s.slug}
                        active={s.slug === sel.seriesSlug}
                        onClick={() =>
                          setSel({ seriesSlug: s.slug, setId: undefined, cardId: undefined, variantId: undefined })
                        }
                      >
                        {s.name}
                        <span className="ml-[4px] opacity-60">{s.setCount}</span>
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}
              {setsQ.data && (
                <Select
                  value={sel.setId ?? ''}
                  onChange={(v) => setSel((p) => ({ ...p, setId: v, cardId: undefined, variantId: undefined }))}
                >
                  {sel.setId && !setsQ.data.some((s) => s.setId === sel.setId) && (
                    <option value={sel.setId}>{detail?.card.set.name ?? sel.setId} (outside filter)</option>
                  )}
                  {setsQ.data.map((s) => (
                    <option key={s.setId} value={s.setId}>
                      {s.name} ({s.cardCountTotal} cards)
                    </option>
                  ))}
                </Select>
              )}
              <div className="mt-[8px] flex gap-[8px] overflow-x-auto pb-[4px]">
                {cards.map((c) => (
                  <button
                    key={c.cardId}
                    onClick={() => setSel((p) => ({ ...p, cardId: c.cardId, variantId: undefined }))}
                    className={`relative w-[64px] shrink-0 overflow-hidden rounded-[5px] border-2 ${
                      c.cardId === sel.cardId ? 'border-action-primary' : 'border-transparent'
                    }`}
                    title={`${c.name} #${c.number}`}
                  >
                    <img
                      src={proxied(c.images.low)}
                      alt={c.name}
                      loading="lazy"
                      className="block w-full"
                      style={{ aspectRatio: '245 / 337' }}
                    />
                    {corpus?.hasAnyMask(c.cardId) === true && (
                      <span
                        className="absolute right-[3px] top-[3px] h-[8px] w-[8px] rounded-full bg-action-primary ring-1 ring-black/40"
                        title="a hand mask exists for this card"
                      />
                    )}
                  </button>
                ))}
                {cardsQ.hasNextPage && (
                  <button
                    onClick={() => void cardsQ.fetchNextPage()}
                    className="flex w-[64px] shrink-0 items-center justify-center rounded-[5px] border border-border-default text-[12px] text-text-muted hover:border-action-primary"
                    style={{ aspectRatio: '245 / 337' }}
                  >
                    {cardsQ.isFetchingNextPage ? '…' : `+${cardsTotal - cards.length}`}
                  </button>
                )}
                {cardsQ.isLoading && <span className="text-[12px] text-text-muted">loading…</span>}
              </div>
            </>
          )}
          {detail && (
            <div className="mt-[8px] flex flex-wrap gap-[6px]">
              {detail.variants.map((v) => (
                <Chip
                  key={v.variantId}
                  active={v.variantId === sel.variantId}
                  onClick={() => setSel((p) => ({ ...p, variantId: v.variantId }))}
                >
                  {v.displayName}
                </Chip>
              ))}
            </div>
          )}
        </Section>

        <Section title="Pattern">
          <Select value={patternOverride} onChange={setPatternOverride}>
            <option value="auto">Auto — {patternById(resolved.patternId).label}</option>
            <optgroup label="Implemented recipes">
              {PATTERNS.filter((p) => p.implemented).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Recipe gap — nearest-recipe fallback">
              {PATTERNS.filter((p) => !p.implemented).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — approx via {p.approxVia}
                </option>
              ))}
            </optgroup>
          </Select>
          <p className="mt-[6px] text-[11px] leading-[15px] text-text-muted">
            {pattern.taxonomy} — {pattern.usedOn}
          </p>
          {!pattern.implemented && (
            <p className="mt-[4px] text-[11px] leading-[15px] text-amber-500/90">
              No faithful recipe yet — rendering an approximation via {pattern.approxVia}.
            </p>
          )}
          {patternOverride === 'auto' && resolved.patternId !== 'none' && (
            <p className="mt-[4px] text-[11px] leading-[15px] text-text-muted">
              {resolved.guess.confidence
                ? `Guess: ${resolved.guess.match}-level citation, ${resolved.guess.confidence} confidence (${resolved.guess.sources.join(', ')})${
                    resolved.guess.era ? ` — ${resolved.guess.era}${resolved.guess.years ? ` ${resolved.guess.years}` : ''}` : ''
                  }`
                : 'Guess: era heuristic — no cited usage row for this set/class.'}
            </p>
          )}
          <p className="mt-[4px] text-[11px] leading-[15px] text-text-muted">
            {canon
              ? `Canon: locked ${new Date(canon.savedAt).toLocaleDateString()} — data/foil-canon/${pattern.id}.json`
              : 'Canon: none saved — recipe code defaults. Lock this pattern on the Canon patterns tab.'}
          </p>
        </Section>

        <Section title="Mask">
          <div className="mb-[8px] flex flex-wrap items-center gap-[6px]">
            {(['auto', 'window', 'sheet', 'full'] as const).map((s) => (
              <Chip
                key={s}
                active={!handActive && scopeOverride === s}
                onClick={() => {
                  setScopeOverride(s)
                  setMaskSource('layout')
                  setEditMode(false)
                  if (adjustMode) endAdjust()
                }}
              >
                {s === 'auto' ? `auto (${resolved.scope})` : s}
              </Chip>
            ))}
            <Chip
              active={handActive}
              disabled={!savedMask && !maskDirty && !editMode}
              onClick={() => {
                setMaskSource('hand')
                if (adjustMode) endAdjust()
              }}
            >
              hand
            </Chip>
          </div>
          <label className="mb-[6px] flex items-center gap-[8px] text-[13px]">
            <input type="checkbox" checked={maskView} onChange={(e) => setMaskView(e.target.checked)} />
            Show mask overlay
          </label>
          {!handActive && (
            <Slider label="Mask feather" value={maskFeather} min={0} max={0.06} step={0.001} onChange={setMaskFeather} />
          )}

          {(
            adjustMode && winGeom ? (
              <div className="space-y-[8px]">
                <p className="text-[11px] leading-[15px] text-text-muted">
                  Drag the corners/edges to fit the printed foil window; drag inside the box to move it. Pinch (or
                  wheel / Space-drag) to zoom and pan — handles stay finger-sized at any zoom.
                  {effectiveScope === 'sheet' ? ' Sheet scope: foil covers everything OUTSIDE this box.' : ''}
                </p>
                <Slider
                  label="Window corner radius"
                  value={winGeom.radius}
                  min={0}
                  max={0.08}
                  step={0.001}
                  onChange={(v) => {
                    setWinGeom({ ...winGeom, radius: v })
                    setWinDirty(true)
                  }}
                />
                <p className="text-[11px] tabular-nums text-text-muted">
                  window x/y/w/h {fmtRect(winGeom.rect)} {winDiffers ? '· adjusted vs era rule' : '· = era rule'}
                </p>
                <div className="flex flex-wrap gap-[6px]">
                  <ActionBtn onClick={() => void saveWindow()}>
                    {winStatus === 'saving'
                      ? 'Saving…'
                      : winStatus === 'saved'
                        ? 'Saved ✓'
                        : `Save window${winDirty ? ' ●' : ''}`}
                  </ActionBtn>
                  <ActionBtn onClick={resetWindow}>Reset to era rect</ActionBtn>
                  <ActionBtn active onClick={() => void flattenWindow()}>
                    Flatten → refine by hand
                  </ActionBtn>
                  <ActionBtn onClick={endAdjust}>Done</ActionBtn>
                </div>
                {winStatus === 'error' && (
                  <p className="text-[12px] text-red-400">
                    {winError ?? 'Window save failed.'} Nothing was discarded — the geometry on screen is
                    still yours.
                  </p>
                )}
              </div>
            ) : !editMode ? (
              <div className="mb-[6px] flex flex-wrap gap-[6px]">
                <ActionBtn onClick={startEdit}>✏️ Edit mask (Pencil)</ActionBtn>
                {maskSource === 'layout' && windowScoped && (
                  <ActionBtn onClick={startAdjust}>⤡ Adjust window</ActionBtn>
                )}
                {canWrite && savedMask && (
                  <ActionBtn onClick={deleteMask}>
                    {maskSaveStatus === 'saving' ? 'Deleting…' : 'Delete saved'}
                  </ActionBtn>
                )}
              </div>
            ) : (
              <div className="space-y-[8px]">
                <div className="flex flex-wrap gap-[6px]">
                  <ActionBtn active={brushMode === 'brush'} onClick={() => setBrushMode('brush')}>
                    Brush
                  </ActionBtn>
                  <ActionBtn active={brushMode === 'erase'} onClick={() => setBrushMode('erase')}>
                    Erase
                  </ActionBtn>
                  <ActionBtn onClick={() => editorRef.current?.undo()}>Undo</ActionBtn>
                  <ActionBtn onClick={() => editorRef.current?.clear()}>Clear</ActionBtn>
                  <ActionBtn onClick={() => editorRef.current?.fill()}>Fill</ActionBtn>
                  <ActionBtn
                    onClick={() => {
                      editorRef.current?.loadLayoutRect(mask.rect, mask.invert, mask.radius)
                      // Re-seeded from geometry: the canvas is a bare rect again,
                      // so the next save must not inherit the old mask's label.
                      seedFromGeometry()
                    }}
                  >
                    {winDiffers ? 'Reset to window' : 'Reset to layout'}
                  </ActionBtn>
                </div>
                <Slider label="Brush size" value={brushSize} min={4} max={120} step={1} onChange={setBrushSize} />
                <label className="flex items-center gap-[8px] text-[13px]">
                  <input type="checkbox" checked={allowTouch} onChange={(e) => setAllowTouch(e.target.checked)} />
                  Allow finger drawing (Pencil + mouse only by default)
                </label>
                <p className="text-[11px] leading-[15px] text-text-muted">
                  Zoom: pinch, or wheel / +− keys. Pan: two fingers
                  {allowTouch ? '' : ' (or one — fingers pan while “allow finger drawing” is off)'}, middle-drag, or
                  hold Space and drag. ⤢ (or 0) fits. The brush stays the same size on SCREEN as you zoom, so zooming
                  in buys finer control — the saved mask is always full resolution.
                </p>
                <div className="flex flex-wrap gap-[6px]">
                  {/* Wrapped, NOT passed by reference: ActionBtn forwards the
                      click event as the first argument, which would land in
                      saveMask's `override` slot and blank out `derivation`. */}
                  <ActionBtn onClick={() => void saveMask()}>
                    {maskSaveStatus === 'saving'
                      ? 'Saving…'
                      : maskSaveStatus === 'saved'
                        ? 'Saved ✓'
                        : maskDirty
                          ? 'Save mask ●'
                          : 'Save mask'}
                  </ActionBtn>
                  {canWrite && (
                    <ActionBtn onClick={() => void openAsPr()} disabled={prBusy}>
                      {prBusy ? 'Opening a pull request…' : 'Open as PR instead'}
                    </ActionBtn>
                  )}
                  <ActionBtn onClick={() => setEditMode(false)}>Done</ActionBtn>
                </div>
              </div>
            )
          )}
          {/*
            A refused write, in the server's own words. It used to be an empty
            catch: the strokes stayed on screen and nothing said the save had
            not landed, which is how a writer closes a tab on work that was
            never committed.
          */}
          {maskSaveStatus === 'error' && (
            <p className="mt-[6px] text-[12px] leading-[1.5] text-red-400" data-testid="mask-save-error">
              Save refused: {maskSaveError ?? 'the server gave no reason'}. Your strokes are still on the
              canvas — nothing was discarded.
            </p>
          )}
          {maskSaveStatus === 'saved' && (
            <p className="mt-[6px] text-[12px] text-action-primary">Committed to the repository ✓</p>
          )}
          <SubmitOutcome state={{ busy: prBusy, result: prResult }} viewer={viewer} />
          <p className="mt-[6px] text-[11px] text-text-muted">
            {handActive
              ? `Hand mask ${savedMask ? '(saved)' : '(unsaved)'}${maskDirty ? ' — unsaved strokes' : ''}${
                  maskMeta?.aliasOf != null ? ` — same-artwork alias of variant ${maskMeta.aliasOf}` : ''
                } → data/foil-masks/`
              : `Era: ${ERAS[resolved.eraId].label} (rects from era-layouts.json)${
                  windowScoped && winDiffers
                    ? ` — window adjusted ${
                        winSaved
                          ? winSaved.aliasOf != null
                            ? `(saved — same-artwork alias of variant ${winSaved.aliasOf})`
                            : '(saved)'
                          : '(unsaved)'
                      } → data/foil-windows/`
                    : ''
                }`}
          </p>
          {detail && sel.variantId != null && (
            <MaskProvenanceLine
              sidecar={maskSidecar}
              aliasOf={maskMeta?.aliasOf ?? null}
              cardId={detail.card.cardId}
              variantId={sel.variantId}
              scope={resolved.scope}
              pendingNote={
                maskDirty
                  ? `unsaved edits — this will save as “${pendingMethod()}”`
                  : maskSidecar?.derivation_method === 'ai'
                    ? 'AI proposal — nobody has reviewed it. Edit it to turn it into training signal.'
                    : null
              }
            />
          )}
        </Section>

        {/* ── Staged work, the conflict choice, and the provisional numbers ── */}
        <Section title={canWrite ? 'Direct write' : 'Your session'}>
          {canWrite ? (
            <p className="text-[12px] leading-[1.5] text-text-muted">
              You hold the writer capability, so Save writes straight to the repository — one PUT, the same
              path this workbench always used. The staging layer never engages for you.
            </p>
          ) : (
            <>
              <p className="mb-[8px] text-[12px] leading-[1.5] text-text-muted">
                Save stages this card locally. No account needed, and it survives a reload, a tab close, and
                days of gap. One card is one session, and one session becomes one pull request — submit it
                from Staged work, and your name goes on it as a co-author.
              </p>
              {staged === null ? (
                <p className="text-[12px] text-text-muted">Nothing staged for this printing yet.</p>
              ) : (
                <p className="text-[12px] text-text-primary">
                  Staged {new Date(staged.updatedAt).toLocaleString()} · seeded from {staged.seed.startedFrom}
                  {staged.seed.parent ? ` (${staged.seed.parent.cardId}/${staged.seed.parent.variantId})` : ''}
                </p>
              )}
              <div className="mt-[8px] flex flex-wrap gap-[6px]">
                <ActionBtn onClick={() => void stageMask()} active>
                  {stageStatus === 'saving'
                    ? 'Staging…'
                    : stageStatus === 'saved'
                      ? 'Staged ✓'
                      : maskDirty
                        ? 'Save to session ●'
                        : 'Save to session'}
                </ActionBtn>
                <ActionBtn onClick={() => navigate('/staged')}>Staged work ({staging.sessions.length})</ActionBtn>
              </div>
              {stageStatus === 'error' && (
                <p className="mt-[6px] text-[12px] text-red-400">Could not stage — the browser refused to store it.</p>
              )}
            </>
          )}

          {conflict?.conflicted === true && (
            <div className="mt-[10px] rounded-md border border-amber-500/50 bg-amber-500/10 p-[8px]">
              <p className="text-[12px] leading-[1.5] text-amber-200">
                <strong className="font-semibold">{conflict.kind}</strong> — {conflict.detail}
              </p>
              <div className="mt-[8px] flex flex-wrap gap-[6px]">
                {conflict.choices.map((c) => (
                  <ActionBtn key={c} onClick={() => void resolveConflict(c)}>
                    {c === 'keep-mine' ? 'Keep mine' : c === 'take-theirs' ? 'Take theirs' : 'Re-trace'}
                  </ActionBtn>
                ))}
              </div>
              <p className="mt-[6px] text-[11px] text-amber-200/80">
                Nothing is merged automatically. Two people painting the same alpha channel have no lines to
                merge, so any automatic result would be plausible-looking garbage nobody drew.
              </p>
            </div>
          )}
          {ghostPng !== null && (
            <p className="mt-[8px] text-[11px] text-text-muted">
              Your previous strokes are kept as a ghost for this re-trace. They are not submitted — they are
              there to draw against.
            </p>
          )}

          <div className="mt-[10px] border-t border-border-default pt-[8px]">
            <div className="flex items-center gap-[8px]">
              <ActionBtn onClick={computeProvisional}>Provisional diff</ActionBtn>
              {provisionalStale && provisional !== null && (
                <span className="text-[11px] text-text-muted">stale — strokes since</span>
              )}
            </div>
            {provisional === null ? (
              <p className="mt-[6px] text-[11px] leading-[15px] text-text-muted">
                The server decides <code>derivation_method</code> and the agreement number by diffing your
                pixels against what your declared seed rasterizes to — the client never labels a mask. But the
                client owns the same rasterizer, so the number is computable here. It is provisional until the
                server confirms.
              </p>
            ) : (
              <p
                className="mt-[6px] text-[11px] leading-[15px] text-text-muted tabular-nums"
                data-testid="provisional-diff"
              >
                vs the era rule: agreement {(provisional.vsRule.agreement * 100).toFixed(1)}% · +
                {provisional.vsRule.addedPx.toLocaleString()} / −{provisional.vsRule.removedPx.toLocaleString()}px.{' '}
                <span className="text-amber-200/80">Provisional</span> — the server recomputes it at save.
              </p>
            )}
          </div>
        </Section>

        <MaskCorpusPanel
          available
          refreshKey={corpusKey}
          onPick={(cardId, variantId) => setSel((p) => ({ ...p, cardId, variantId }))}
        />

        <Section title="Tilt">
          <div className="mb-[8px] flex gap-[6px]">
            {(['pointer', 'gyro', 'manual'] as const).map((m) => (
              <Chip
                key={m}
                active={tilt.mode === m}
                onClick={() => {
                  if (m === 'gyro') void tilt.requestGyro()
                  else tilt.setMode(m)
                }}
              >
                {m}
              </Chip>
            ))}
            {tilt.mode === 'gyro' && (
              <Chip active={false} onClick={tilt.recenterGyro}>
                recenter
              </Chip>
            )}
          </div>
          {tilt.gyroPermission === 'denied' && (
            <p className="mb-[6px] text-[11px] text-text-muted">Motion permission denied — use manual sliders.</p>
          )}
          {tilt.reducedMotion && (
            <p className="mb-[6px] text-[11px] text-text-muted">
              Reduced motion is on — manual tilt is the default; nothing animates on its own.
            </p>
          )}
          {tilt.mode === 'manual' && (
            <>
              <Slider label="Tilt X" value={tilt.manual.x} min={-1} max={1} step={0.01} onChange={(v) => tilt.setManual(v, tilt.manual.y)} />
              <Slider label="Tilt Y" value={tilt.manual.y} min={-1} max={1} step={0.01} onChange={(v) => tilt.setManual(tilt.manual.x, v)} />
            </>
          )}
          <Slider label="Max card tilt (deg)" value={maxTiltDeg} min={0} max={35} step={1} onChange={setMaxTiltDeg} />
        </Section>

        <Section title="Foil uniforms (this card vs canon)">
          <CoreSliders uniforms={uniforms} dirty={overrideDiffKeys} onChange={setU} />
          {pattern.params.length > 0 && <div className="my-[8px] border-t border-border-default" />}
          {pattern.params.map((p) => (
            <Slider
              key={p.key}
              label={p.label}
              value={uniforms[p.key] ?? p.default}
              min={p.min}
              max={p.max}
              step={p.step}
              marked={overrideDiffKeys.includes(p.key)}
              onChange={(v) => setU(p.key, v)}
            />
          ))}
          <div className="my-[8px] border-t border-border-default" />
          <p className="mb-[6px] text-[11px] leading-[15px] text-text-muted">
            {overrideDiffKeys.length > 0
              ? `${overrideDiffKeys.length} uniform${overrideDiffKeys.length === 1 ? '' : 's'} differ${overrideDiffKeys.length === 1 ? 's' : ''} from canon (dotted)`
              : 'Sliders match the canon baseline.'}
            {override
              ? ` · saved overrides ${new Date(override.savedAt).toLocaleDateString()} (${Object.keys(override.uniforms).length}) → data/foil-overrides/`
              : ''}
          </p>
          <div className="mb-[6px] flex flex-wrap gap-[6px]">
            <ActionBtn onClick={() => setUniforms({ ...baseline })}>Reset to canon</ActionBtn>
          </div>
          {overrideDiffKeys.length > 0 && (
            <p className="mb-[6px] text-[12px] text-text-muted">
              {canWrite
                ? `These ${overrideDiffKeys.length} adjusted uniform(s) are not committed by Save — the direct write puts mask pixels, not sliders. Copy the recipe JSON below, or lock them for the whole pattern on the Canon tab.`
                : `These ${overrideDiffKeys.length} adjusted uniform(s) ride along in the staged session when you press Save.`}{' '}
              There is no per-card override file to write to — <code>data/foil-overrides/</code> has never
              held a record and no <code>/api/override</code> route exists — so a card&rsquo;s uniforms are
              session contents until the contribution pipeline can open a PR for one.
            </p>
          )}
          <button
            onClick={copyRecipe}
            className="mt-[6px] w-full rounded-md border border-border-default bg-surface-tertiary py-[8px] text-[13px] text-text-primary hover:border-action-primary"
          >
            {copied ? 'Copied!' : 'Copy recipe JSON'}
          </button>
        </Section>

        <p className="pb-[16px] text-center text-[10px] text-text-muted">
          card adjustment surface — per-card masks + overrides; canon patterns live on the Canon tab.
        </p>
      </div>

      {/* ── Comment modal ── */}
      {commentOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-[16px] min-[700px]:items-center">
          <div className="w-full max-w-[440px] rounded-lg border border-border-default bg-surface-secondary p-[14px]">
            <h2 className="mb-[8px] text-[13px] font-semibold">
              Workbench comment
              <span className="ml-[8px] font-normal text-text-muted">
                {detail?.card.cardId} · {variant?.displayName ?? ''} · {effectivePatternId}
              </span>
            </h2>
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              rows={4}
              placeholder="What's off / what to try — card, pattern, sliders and mask state are captured automatically."
              className="w-full rounded-md border border-border-default bg-surface-tertiary p-[8px] text-[13px] text-text-primary"
            />
            <div className="mt-[10px] flex items-center justify-end gap-[8px]">
              {commentStatus === 'error' && (
                <span className="mr-auto text-[12px] text-red-400">
                  Could not store the note — the browser refused to write the session.
                </span>
              )}
              {commentStatus === 'saved' && (
                <span className="mr-auto text-[12px] text-action-primary">Saved to your staged session ✓</span>
              )}
              <ActionBtn onClick={() => setCommentOpen(false)}>Cancel</ActionBtn>
              <ActionBtn onClick={submitComment} active>
                {commentStatus === 'saving' ? 'Saving…' : 'Save comment'}
              </ActionBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

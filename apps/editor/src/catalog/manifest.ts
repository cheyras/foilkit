// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The corpus manifest, read.
//
// This is where the REPLACEMENT FILTERS get their data. Every catalog route in
// the old workbench was user-scoped — an owned-only chip in localStorage,
// per-series owned counts, per-set "N owned", a per-card ownership badge. None
// of it survives: there is no DeckPal account behind this site, so an
// owned-only filter has nothing to filter against.
//
// The replacement is CONTRIBUTION-SHAPED rather than collection-shaped: has a
// mask / has a canon / uncanon'd pattern. Those questions are not answerable
// from the catalog at all — "which cards have a mask" is a fact about
// `data/foil-masks/` and "which patterns have a canon" is a fact about
// `data/foil-canon/`, and neither has ever been in a database. So they come out
// of a local file walk that runs on every build, and this module is the reader.
//
// ABSENCE IS THE POINT for canon: the patterns with no canon file are recorded
// as absent rather than papered over with code defaults, because that absence
// is exactly what #11's queue is built from.

import { getJson } from './artifacts.ts'

export interface ManifestMaskRecord {
  variantId: number
  scope: string
  eraId: string
  method: string
  reviewStatus: string
  agreement: number | null
  savedAt: string | null
  frame: string
  width: number
  height: number
  sha256: string
}

export interface CorpusManifest {
  version: number
  /** The corpus's own newest `savedAt` — see docs/HOSTED-EDITOR.md §3. */
  generatedAt: string
  counts: {
    maskRecords: number
    maskCards: number
    maskUnits: number
    windowFiles: number
    windowCards: number
    canonFiles: number
    patterns: number
    uncanonedPatterns: number
  }
  masks: Record<string, Record<string, ManifestMaskRecord>>
  /** `"<cardId>|<scope>"` → the variantId that ANSWERS for that unit. */
  maskUnits: Record<string, number>
  windows: Record<string, number[]>
  canon: Record<string, { exists: boolean; contract: number | null; savedAt: string | null; uniforms: number }>
  uncanoned: string[]
  patterns: string[]
}

/** The three contribution-shaped filters. Not a collection in sight. */
export type ContributionFilter = 'all' | 'has-mask' | 'no-mask' | 'has-window'

export const FILTER_LABEL: Record<ContributionFilter, string> = {
  all: 'All cards',
  'has-mask': 'Has a mask',
  'no-mask': 'No mask yet',
  'has-window': 'Has window geometry',
}

export class CorpusView {
  constructor(readonly manifest: CorpusManifest | null) {}

  static async load(signal?: AbortSignal): Promise<CorpusView> {
    return new CorpusView(await getJson<CorpusManifest>('/corpus-manifest.json', signal))
  }

  get ready(): boolean {
    return this.manifest !== null
  }

  /**
   * Which record answers for `(cardId, scope)`.
   *
   * Masks alias by `(cardId, scope)`: all variants of one cardId render the
   * same scan — imagery is keyed per card and `card_variant` carries none of
   * its own — so one mask serves every sibling variant whose `prior.scope`
   * matches. A holo (window) and a reverse (sheet) of the same card must never
   * share one, which is why scope is half the key. The old server did this
   * resolution and reported it in `X-Foil-Mask-Alias-Of`; on a static site the
   * client does it, from this table.
   */
  maskFor(cardId: string, scope: string): ManifestMaskRecord | null {
    const m = this.manifest
    if (m === null) return null
    const variantId = m.maskUnits[`${cardId}|${scope}`]
    if (variantId === undefined) return null
    return m.masks[cardId]?.[String(variantId)] ?? null
  }

  /** Does this card carry a mask at ANY scope? The filter's question. */
  hasAnyMask(cardId: string): boolean {
    const m = this.manifest
    return m !== null && m.masks[cardId] !== undefined
  }

  /** Window geometry aliases scope-agnostically — a sheet is the box inverted. */
  hasWindow(cardId: string): boolean {
    const m = this.manifest
    return m !== null && Array.isArray(m.windows[cardId]) && m.windows[cardId]!.length > 0
  }

  windowVariantFor(cardId: string): number | null {
    return this.manifest?.windows[cardId]?.[0] ?? null
  }

  hasCanon(patternId: string): boolean {
    return this.manifest?.canon[patternId]?.exists === true
  }

  canonContract(patternId: string): number | null {
    return this.manifest?.canon[patternId]?.contract ?? null
  }

  /** The patterns nobody has ever canon'd. Absence, recorded, on purpose. */
  get uncanoned(): string[] {
    return this.manifest?.uncanoned ?? []
  }

  /**
   * Apply a contribution filter to a page of cards.
   *
   * Note what this is NOT: a query parameter. `ownedOnly` used to be threaded
   * through four `useQuery` calls and into the server; these filters are a
   * predicate over a page the client already has, because the manifest is
   * small and already loaded. A filter with no round trip is also a filter that
   * cannot be stale relative to the list it filters.
   */
  filter<T extends { cardId: string }>(cards: T[], filter: ContributionFilter): T[] {
    if (filter === 'all' || this.manifest === null) return cards
    switch (filter) {
      case 'has-mask':
        return cards.filter((c) => this.hasAnyMask(c.cardId))
      case 'no-mask':
        return cards.filter((c) => !this.hasAnyMask(c.cardId))
      case 'has-window':
        return cards.filter((c) => this.hasWindow(c.cardId))
    }
  }
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The baked catalog, read.
//
// The shard tier structure deliberately mirrors the walk the workbench already
// did — series list → sets in a series → paged set cards → card detail — so the
// client barely changes. What DID change is that ownership came out. Not
// hardcoded to false: OUT. A dead `ownedOnly` parameter threaded through four
// `useQuery` calls is worse than its absence, because the next person has to
// work out whether it does anything.
//
// CARD DETAIL COMES OUT OF THE SET SHARD. The old api had a per-card route, and
// mirroring that here would mean ~20,500 single-card files in git. A set shard
// already carries every field a detail view needs, and the setId is the cardId
// before its last `-`, so a detail lookup is a shard load and an index.
//
// Everything served here is public. Anyone can fetch a shard directly, which is
// fine — after ownership came out these are catalog facts with nothing of
// anyone's in them — but it is why the bake must never carry a user column, a
// collection count, or an internal id "just because it was in the query".

import { getJson } from './artifacts.ts'

export interface CatalogIndex {
  version: number
  generatedAt: string
  source: string
  resolverVersion: number
  counts: { series: number; sets: number; cards: number; printings: number }
  series: { slug: string; name: string; tcgdexId: string; setCount: number; cardCount: number }[]
}

export interface CatalogSetRef {
  setId: string
  name: string
  releasedOn: string | null
  cardCountTotal: number
}

export interface CatalogSeriesShard {
  /** Bake stamp — optional, because shards baked before it exist in the wild. */
  version?: number
  generatedAt?: string
  source?: string
  resolverVersion?: number
  seriesSlug: string
  sets: CatalogSetRef[]
}

export interface CatalogVariant {
  variantId: number
  kind: string
  displayName: string
  /** Derived from the variant kind by the bake ('standard' | 'holo' | 'reverse' | 'special' | …). */
  tier: string
}

export interface CatalogCard {
  cardId: string
  number: string
  name: string
  rarity: string | null
  images: { low: string; high: string }
  variants: CatalogVariant[]
}

export interface CatalogSetShard {
  /** Bake stamp — optional, because shards baked before it exist in the wild. */
  version?: number
  generatedAt?: string
  source?: string
  resolverVersion?: number
  setId: string
  set: {
    setId: string
    name: string
    slug: string
    seriesName: string
    seriesTcgdexId: string
    releasedOn: string | null
  }
  page: number
  pageCount: number
  total: number
  pageSize: number
  cards: CatalogCard[]
}

/** Page 1 is `<setId>.json`; later pages are `<setId>.p<N>.json`. */
export function setShardPath(setId: string, page: number): string {
  const safe = encodeURIComponent(setId)
  return page <= 1 ? `/catalog/sets/${safe}.json` : `/catalog/sets/${safe}.p${page}.json`
}

export class Catalog {
  private index: CatalogIndex | null = null
  private indexLoaded = false
  private readonly series = new Map<string, CatalogSeriesShard | null>()
  private readonly sets = new Map<string, CatalogSetShard | null>()

  async loadIndex(signal?: AbortSignal): Promise<CatalogIndex | null> {
    if (!this.indexLoaded) {
      this.index = await getJson<CatalogIndex>('/catalog/index.json', signal)
      this.indexLoaded = true
    }
    return this.index
  }

  async seriesShard(slug: string, signal?: AbortSignal): Promise<CatalogSeriesShard | null> {
    if (!this.series.has(slug)) {
      this.series.set(slug, await getJson<CatalogSeriesShard>(`/catalog/series/${encodeURIComponent(slug)}.json`, signal))
    }
    return this.series.get(slug) ?? null
  }

  async setShard(setId: string, page: number, signal?: AbortSignal): Promise<CatalogSetShard | null> {
    const key = `${setId}#${page}`
    if (!this.sets.has(key)) {
      this.sets.set(key, await getJson<CatalogSetShard>(setShardPath(setId, page), signal))
    }
    return this.sets.get(key) ?? null
  }

  /**
   * A card's detail, out of its own set's shards.
   *
   * Walks pages until it finds the card, because a promo set runs past one page
   * and a caller only has a cardId. Page 1 answers for every set but the big
   * promo ones, so this is one request in the overwhelming majority of cases —
   * and the shards are cached, so scrubbing a set costs nothing after the first.
   *
   * AND IT WALKS HYPHENS, not only pages — see `setIdCandidates`.
   */
  async card(cardId: string, signal?: AbortSignal): Promise<{ card: CatalogCard; shard: CatalogSetShard } | null> {
    for (const setId of setIdCandidates(cardId)) {
      let page = 1
      let pageCount = 1
      do {
        const shard = await this.setShard(setId, page, signal)
        // No shard under this candidate: try the next hyphen rather than giving
        // up, because the candidate is only a guess about where the split falls.
        if (shard === null) break
        pageCount = shard.pageCount
        const card = shard.cards.find((c) => c.cardId === cardId)
        if (card) return { card, shard }
        page++
      } while (page <= pageCount)
    }
    return null
  }
}

/**
 * The set shards a cardId might live in, most likely first.
 *
 * The rule is "setId is everything before the LAST hyphen", and the bake
 * ASSERTS that round trip for every search row it writes — but deliberately
 * does not ENFORCE it: a promo whose NUMBER contains a hyphen (`fxsp-FX-254`)
 * breaks it, and failing a whole catalog bake over one malformed id would trade
 * a slightly-wrong search result for no site at all. The bake counts and prints
 * those instead.
 *
 * So the reader has to be exactly as forgiving as the writer. When it was not,
 * such a card was UNOPENABLE: the derived shard 404'd, the detail query failed,
 * and the picker's auto-select quietly filled the empty slots with Base Set
 * Machamp — which is precisely what pressing "Work this" on one of these looked
 * like from the outside. Four candidates is a bound rather than a search: a
 * card number carrying four hyphens is a catalog problem, not a routing one.
 */
export function setIdCandidates(cardId: string): string[] {
  const out: string[] = []
  let i = cardId.lastIndexOf('-')
  while (i > 0 && out.length < 4) {
    out.push(cardId.slice(0, i))
    i = cardId.lastIndexOf('-', i - 1)
  }
  return out
}

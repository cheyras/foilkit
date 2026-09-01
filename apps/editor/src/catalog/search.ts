// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Client-side catalog search.
//
// `/search` was a Postgres full-text query. Static means an index over the
// whole English catalog — name, number, set id — that runs in the browser.
// This was flagged as the one place in the read path with real size
// implications, so the number was measured rather than guessed: at catalog
// scale (≈20,500 cards) the whole index is ≈700 KB raw and ≈200 KB gzipped.
// Small enough to ship whole; partitioned anyway, by normalized first letter,
// so a first keystroke does not pay for the twenty-five buckets it excluded.
// `data/search/index.json` carries the measured byte totals so that decision
// stays answerable against a number instead of a memory.
//
// THE ROW IS SHORT ON PURPOSE. `["sv01-26","Charizard ex"]` — the setId is the
// cardId before its last `-` and the number is what follows, so both are
// derived here rather than stored twice. The bake emits an explicit third
// element only for the ids where that derivation does not round-trip, and it
// asserts the round-trip for every row it writes. That is the whole reason the
// index is 700 KB rather than 1.2 MB.

import { getJson } from './artifacts.ts'

export interface SearchIndexHeader {
  version: number
  generatedAt: string
  source: string
  resolverVersion: number
  total: number
  buckets: string[]
  bytes?: { index: number; buckets: number; gzipped?: number }
}

export type SearchRow = [cardId: string, name: string, number?: string]

export interface SearchBucket {
  bucket: string
  rows: SearchRow[]
}

export interface SearchHit {
  cardId: string
  name: string
  number: string
  setId: string
  /** Lower is better. Exact > prefix > word-prefix > substring. */
  rank: number
}

/** The bucket a query or a name belongs to. Must match the bake's rule exactly. */
export function bucketFor(name: string): string {
  const c = normalize(name).charAt(0)
  if (c >= 'a' && c <= 'z') return c
  if (c >= '0' && c <= '9') return '0'
  return '_'
}

/**
 * Fold to a comparable form: lower case, accents stripped, punctuation gone.
 *
 * The catalog is full of names a keyboard cannot reproduce literally — `Pokémon`,
 * `Farfetch'd`, `Ho-Oh`, `Type: Null`, `Mr. Mime`. Somebody typing "farfetchd"
 * or "ho oh" means the card, and a search that refuses them is a search nobody
 * uses twice.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** setId = the cardId before its last `-`. `sv03.5-1` → `sv03.5`. */
export function setIdOf(cardId: string): string {
  const i = cardId.lastIndexOf('-')
  return i < 0 ? cardId : cardId.slice(0, i)
}

/** number = the cardId after its last `-`, unless the row overrides it. */
export function numberOf(row: SearchRow): string {
  if (row[2] !== undefined) return row[2]
  const i = row[0].lastIndexOf('-')
  return i < 0 ? row[0] : row[0].slice(i + 1)
}

export class SearchIndex {
  private header: SearchIndexHeader | null = null
  private readonly buckets = new Map<string, SearchRow[]>()
  private readonly inflight = new Map<string, Promise<SearchRow[]>>()

  async load(signal?: AbortSignal): Promise<SearchIndexHeader | null> {
    if (this.header === null) {
      this.header = await getJson<SearchIndexHeader>('/search/index.json', signal)
    }
    return this.header
  }

  /** Fetch one bucket, at most once, even under a fast typist. */
  private async bucket(key: string, signal?: AbortSignal): Promise<SearchRow[]> {
    const hit = this.buckets.get(key)
    if (hit) return hit
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = getJson<SearchBucket>(`/search/b/${encodeURIComponent(key)}.json`, signal)
      .then((b) => {
        const rows = b?.rows ?? []
        this.buckets.set(key, rows)
        return rows
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  /**
   * Which buckets a query has to look in.
   *
   * A name query only ever matches its own first letter's bucket for the
   * prefix cases — but a SUBSTRING match ("char" inside "Mega Charizard") can
   * live anywhere, and so can a pure number or set-id query. So: one bucket for
   * a cheap prefix search, all of them when the query cannot be localised. The
   * expensive path is deliberate and bounded — the whole index is 700 KB.
   */
  private bucketsFor(query: string, header: SearchIndexHeader): string[] {
    const q = normalize(query)
    if (q.length === 0) return []
    // A query that is entirely digits/punctuation is a number or a set id.
    if (!/[a-z]/.test(q)) return header.buckets
    return q.length < 3 ? [bucketFor(q)] : header.buckets
  }

  async search(query: string, limit = 60, signal?: AbortSignal): Promise<SearchHit[]> {
    const header = await this.load(signal)
    if (header === null) return []
    const q = normalize(query)
    if (q.length === 0) return []
    const qCompact = q.replace(/ /g, '')

    const keys = this.bucketsFor(query, header)
    const rowSets = await Promise.all(keys.map((k) => this.bucket(k, signal)))

    const hits: SearchHit[] = []
    for (const rows of rowSets) {
      for (const row of rows) {
        const name = normalize(row[1])
        const nameCompact = name.replace(/ /g, '')
        const number = numberOf(row)
        const setId = setIdOf(row[0])
        let rank = -1
        if (name === q) rank = 0
        else if (nameCompact.startsWith(qCompact)) rank = 1
        else if (name.split(' ').some((w) => w.startsWith(q))) rank = 2
        else if (normalize(number) === q) rank = 3
        else if (normalize(setId) === q) rank = 4
        else if (nameCompact.includes(qCompact)) rank = 5
        else if (normalize(`${setId} ${number}`) === q) rank = 3
        if (rank < 0) continue
        hits.push({ cardId: row[0], name: row[1], number, setId, rank })
        // A bounded scan: 20× the page is plenty to sort a good page out of,
        // and it keeps a one-letter query from building a 20,000-entry array.
        if (hits.length > limit * 20) break
      }
    }
    hits.sort((a, b) => a.rank - b.rank || (a.cardId < b.cardId ? -1 : 1))
    return hits.slice(0, limit)
  }
}

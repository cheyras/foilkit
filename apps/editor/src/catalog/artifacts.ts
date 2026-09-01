// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE SEAM.
//
// The whole hosted read path turned on one constant. `apps/api/src/routes/
// foil-lab.ts` was DB-free by design and `api.ts` was a self-contained read
// client that deliberately did not import the app's own api module, so
// `BASE = '/deckscout/api'` was the entire coupling to a server. This file is
// what replaced it: a fetcher that reads FILES, from the same origin, with no
// database anywhere behind it.
//
// Everything here answers 404 by returning null rather than throwing, which is
// not laziness — it is the behaviour the surfaces were already written against.
// `api.ts` treated a 404 from the foil-lab endpoints as "this feature is not
// available here" and hid the affordance. Keeping that shape is what let the
// read path and the write path ship as one deploy without a rewrite in
// between: an artifact that has not been baked yet reads exactly like a
// feature that is not mounted, and both are honest.

/**
 * Where the artifacts are. Empty string = this site's own origin, which is the
 * only value production uses; it exists as a variable so a test harness can
 * point the editor at a fixture tree without patching a module.
 */
export const ARTIFACT_BASE = ''

export interface ArtifactStamp {
  generatedAt: string | null
  source: string | null
  resolverVersion: number | null
}

/** GET a JSON artifact. `null` means "not there", which is a real answer. */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(`${ARTIFACT_BASE}${path}`, { signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch (err) {
    // An aborted request is the caller changing their mind, not a failure.
    if ((err as { name?: string }).name === 'AbortError') throw err
    return null
  }
}

/** GET raw bytes (a mask PNG). Null on absence, same contract as getJson. */
export async function getBytes(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; etag: string | null } | null> {
  try {
    const res = await fetch(`${ARTIFACT_BASE}${path}`, { signal })
    if (!res.ok) return null
    return { bytes: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get('etag') }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err
    return null
  }
}

/** The url of a committed corpus artifact. One place, so nothing guesses a path. */
export const artifactUrl = {
  maskPng: (cardId: string, variantId: number): string => `${ARTIFACT_BASE}/foil-masks/${cardId}/${variantId}.png`,
  maskSidecar: (cardId: string, variantId: number): string => `${ARTIFACT_BASE}/foil-masks/${cardId}/${variantId}.json`,
  maskArtifact: (cardId: string, variantId: number, kind: 'prior' | 'diff' | 'parent' | 'parent-diff'): string => {
    const suffix = kind === 'parent-diff' ? 'parent.diff' : kind
    return `${ARTIFACT_BASE}/foil-masks/${cardId}/${variantId}.${suffix}.png`
  },
  window: (cardId: string, variantId: number): string => `${ARTIFACT_BASE}/foil-windows/${cardId}/${variantId}.json`,
  canon: (patternId: string): string => `${ARTIFACT_BASE}/foil-canon/${patternId}.json`,
} as const

// ── Staleness, made visible ────────────────────────────────────────────────
//
// "A stale bake must be VISIBLE, never silent." The catalog moves on
// set-release cadence rather than daily, and the bake is a manual job on a
// machine with a database — so the site WILL at times be serving a catalog
// older than the resolver it was built with. That is fine, and it is not fine
// to hide it.

export interface BakeReceipt {
  source: string
  copiedAt: string
  artifacts: Record<string, { present: boolean; bytes?: number }>
}

export interface StalenessReport {
  /** Nothing baked at all — the state a fresh clone builds in. */
  unbaked: boolean
  /** The bake was built from synthetic rows, not a catalog. */
  fixture: boolean
  /** The bake's resolver version disagrees with the one this build ships. */
  resolverDrift: { baked: number | null; running: number } | null
  generatedAt: string | null
  /** Whole days since the bake, or null when it never happened. */
  ageDays: number | null
  /** Present when there is something a human should see. Null when all is well. */
  banner: string | null
}

export function assessStaleness(
  stamp: ArtifactStamp | null,
  runningResolverVersion: number,
  now: Date = new Date(),
): StalenessReport {
  if (stamp === null) {
    return {
      unbaked: true,
      fixture: false,
      resolverDrift: null,
      generatedAt: null,
      ageDays: null,
      banner: 'No catalog has been baked for this site yet. Browsing is unavailable; see RUN-BAKE.md.',
    }
  }
  const fixture = typeof stamp.source === 'string' && stamp.source.startsWith('fixture:')
  const ageDays =
    stamp.generatedAt === null ? null : Math.floor((now.getTime() - Date.parse(stamp.generatedAt)) / 86_400_000)
  const drift =
    stamp.resolverVersion !== null && stamp.resolverVersion !== runningResolverVersion
      ? { baked: stamp.resolverVersion, running: runningResolverVersion }
      : null

  let banner: string | null = null
  if (fixture) {
    banner = `Fixture data — this catalog is synthetic (${stamp.source}). Nothing here describes a real printing.`
  } else if (drift) {
    // The serious one. The pattern a card resolves to may differ from what the
    // bake recorded, which means the queue is ranking the wrong groups.
    banner =
      `This catalog was baked against resolver v${drift.baked}; the site is running v${drift.running}. ` +
      'Pattern assignments may have moved since. Re-run the bake.'
  } else if (ageDays !== null && ageDays >= 90) {
    banner = `This catalog was baked ${ageDays} days ago. New sets released since then are not here.`
  }
  return { unbaked: false, fixture, resolverDrift: drift, generatedAt: stamp.generatedAt, ageDays, banner }
}

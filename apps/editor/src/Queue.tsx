// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The home screen is a QUEUE, not a card picker.
//
// That is a measurement, not a taste. 3a grouped the whole corpus by the unit a
// human decision actually improves — `(eraId, scope, patternId, guess.match)` —
// and ranked the groups by leverage, `printings ÷ (exemplars + 1)`. The top of
// that list is a rule governing two thousand printings with zero human
// exemplars. A card picker asks "which card did you come for"; most of the time
// the honest answer is "the one that teaches the rule the most", and only a
// ranking can say which that is.
//
// THE MODEL THIS RENDERS, because the UI is meaningless without it:
//
//   Nothing in this corpus is ever blank. The resolver assigns a pattern to
//   every foiled printing, the era layout gives it a footprint, and the
//   composite law renders it. A card with no human attention is not missing —
//   it is GUESSED, and the guess is good enough to ship. Human attention does
//   not fill a hole; it upgrades a guess to a DECISION, and that decision
//   becomes evidence the next generative pass uses on everything else.
//
//   So the queue never shows a completion bar. There is no completion state and
//   no backlog with a bottom, and a progress bar would be a lie about both.

import { useEffect, useMemo, useState } from 'react'
import { ActionBtn, Chip, Section, SurfaceTabs } from './ui.tsx'
import { foilApi } from './api.ts'
import { CorpusView } from './catalog/manifest.ts'
import { assessStaleness, getJson } from './catalog/artifacts.ts'
import { navigate } from './router.ts'
import { RESOLVER_VERSION } from '@foilkit/resolver'
import type { Staging } from './staging/useStaging.ts'

export interface VerificationGroup {
  key: string
  eraId: string
  scope: string
  patternId: string
  match: string
  printings: number
  distinctCards: number
  confidence: Record<string, number>
  exemplars: number
  exemplarWeight: number
  exemplarsInGroup: number
  maskCoveredCards: number
  windowGeometryCards: number
  leverage: number
}

export interface VerificationMapFile {
  version: number
  generatedAt: string
  source: string
  resolverVersion: number
  catalog: { variantsScanned: number; variantsAssigned: number; cardsAssigned: number; groups: number }
  corpus: {
    maskRecords: number
    maskCards: number
    maskCoverageUnits: number
    exemplarUnits: number
    windowGeometryFiles: number
    windowGeometryCards: number
  }
  groups: VerificationGroup[]
}

/**
 * The one work item that is not a card.
 *
 * Where a group's leverage is high, the work item is a REGENERATION PASS over
 * the whole group rather than a card: verify a handful, refit the generator
 * against the new exemplars, re-run it over every remaining guess in the group
 * through the `supersedes` path. The whole group improves at once. That path
 * archives every replaced mask byte-for-byte with sha256 verification before
 * deleting anything, and throws if a machine write lands on an existing mask
 * without an explicit `supersede: { runId }` — which is F4, the ratchet, made
 * structural.
 *
 * It is named here and NOT offered as a button, because a regeneration pass is
 * a tool run against the corpus, not a thing a browser does.
 */
const REGEN_LEVERAGE_FLOOR = 200

export function Queue({ staging }: { staging: Staging }): React.ReactElement {
  const [map, setMap] = useState<VerificationMapFile | null>(null)
  const [corpus, setCorpus] = useState<CorpusView | null>(null)
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<'all' | 'window' | 'sheet' | 'full'>('all')
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const [m, c] = await Promise.all([
        getJson<VerificationMapFile>('/foil-verification-map.json', ac.signal),
        CorpusView.load(ac.signal),
      ])
      setMap(m)
      setCorpus(c)
      setLoading(false)
    })()
    return () => ac.abort()
  }, [])

  const stale = useMemo(
    () =>
      assessStaleness(
        map === null ? null : { generatedAt: map.generatedAt, source: map.source, resolverVersion: map.resolverVersion },
        RESOLVER_VERSION,
      ),
    [map],
  )

  const groups = useMemo(() => {
    const all = map?.groups ?? []
    return scope === 'all' ? all : all.filter((g) => g.scope === scope)
  }, [map, scope])

  /**
   * Open a card from a group.
   *
   * The map ranks rules; a rule is not a thing you can draw on. So this samples
   * a printing the resolver actually assigns this pattern to, at this group's
   * scope, out of the baked inversion file — the same pool the canon lab's card
   * preview draws from. Re-pressing re-samples, because "some card in this
   * group" is the honest request and any particular one is arbitrary.
   */
  const openGroup = async (g: VerificationGroup) => {
    setOpening(g.key)
    try {
      const pool = await foilApi.patternCards(g.patternId, 60)
      const candidates = (pool?.sample ?? []).filter((s) => s.scope === g.scope)
      const pick = candidates[Math.floor(Math.random() * candidates.length)] ?? pool?.sample[0]
      if (!pick) return
      navigate(`/card?id=${encodeURIComponent(pick.cardId)}&v=${pick.variantId}`)
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-[12px] p-[12px]">
      <SurfaceTabs active="queue" />

      {stale.banner && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-[10px] text-[13px] text-amber-200">
          {stale.banner}
        </p>
      )}

      <Section title="Where an hour moves the most pixels">
        <p className="mb-[10px] text-[13px] leading-[1.5] text-text-muted">
          Every printing already has an answer — the resolver assigns a pattern, the era layout gives it a
          footprint, and the composite law renders it. A card nobody has looked at is <em>guessed</em>, not
          missing. Looking at one upgrades a guess to a decision, and that decision becomes evidence the next
          generative pass uses on everything else in its group. Ranked by{' '}
          <span className="text-text-primary">printings ÷ (exemplars + 1)</span>.
        </p>

        <div className="mb-[10px] flex flex-wrap gap-[6px]">
          {(['all', 'window', 'sheet', 'full'] as const).map((s) => (
            <Chip key={s} active={scope === s} onClick={() => setScope(s)}>
              {s === 'all' ? 'Every scope' : s}
            </Chip>
          ))}
        </div>

        {loading && <p className="text-[12px] text-text-muted">Reading the verification map…</p>}
        {!loading && map === null && (
          <p className="text-[13px] text-text-muted">
            No verification map has been baked. It is an output of <code>tools/bake-catalog.mts</code> — see
            RUN-BAKE.md.
          </p>
        )}

        {map !== null && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[12px]">
                <thead>
                  <tr className="text-left text-text-muted">
                    <th className="py-[6px] pr-[8px] font-medium">Rule</th>
                    <th className="py-[6px] pr-[8px] text-right font-medium">Printings</th>
                    <th className="py-[6px] pr-[8px] text-right font-medium">Cards</th>
                    <th className="py-[6px] pr-[8px] text-right font-medium">Exemplars</th>
                    <th className="py-[6px] pr-[8px] text-right font-medium">Leverage</th>
                    <th className="py-[6px]" />
                  </tr>
                </thead>
                <tbody>
                  {groups.slice(0, 40).map((g) => (
                    <tr key={g.key} className="border-t border-border-default align-top">
                      <td className="py-[8px] pr-[8px]">
                        <div className="text-text-primary">{g.patternId}</div>
                        <div className="text-[11px] text-text-muted">
                          {g.eraId} · {g.scope} · matched by {g.match}
                          {g.leverage >= REGEN_LEVERAGE_FLOOR && (
                            <span className="ml-[6px] rounded border border-action-primary/50 px-[4px] text-action-primary">
                              regeneration pass
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-[8px] pr-[8px] text-right tabular-nums text-text-primary">
                        {g.printings.toLocaleString()}
                      </td>
                      <td className="py-[8px] pr-[8px] text-right tabular-nums text-text-muted">
                        {g.distinctCards.toLocaleString()}
                      </td>
                      <td className="py-[8px] pr-[8px] text-right tabular-nums text-text-muted">
                        {g.exemplars}
                        {g.maskCoveredCards > g.exemplarsInGroup && (
                          <span
                            className="ml-[4px] opacity-60"
                            title="Masks exist on these cards that selectExemplars rejects — coverage is not evidence."
                          >
                            (+{g.maskCoveredCards - g.exemplarsInGroup})
                          </span>
                        )}
                      </td>
                      <td className="py-[8px] pr-[8px] text-right tabular-nums text-text-primary">
                        {Math.round(g.leverage).toLocaleString()}
                      </td>
                      <td className="py-[8px] text-right">
                        <ActionBtn onClick={() => void openGroup(g)} disabled={opening === g.key}>
                          {opening === g.key ? 'Picking…' : 'Work this'}
                        </ActionBtn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-[10px] text-[11px] text-text-muted">
              {map.groups.length} rule groups over {map.catalog.variantsAssigned.toLocaleString()} assigned
              printings / {map.catalog.cardsAssigned.toLocaleString()} cards. Corpus:{' '}
              {map.corpus.maskRecords} mask record(s) across {map.corpus.maskCoverageUnits} (cardId, scope)
              unit(s), {map.corpus.exemplarUnits} of them admissible as evidence. Map generated{' '}
              {new Date(map.generatedAt).toLocaleString()} against resolver v{map.resolverVersion}.
            </p>
          </>
        )}
      </Section>

      <Section title="Patterns nobody has canon'd">
        <p className="mb-[8px] text-[13px] text-text-muted">
          A pattern with no canon file inherits whatever the code defaults say at read time. That absence is
          recorded rather than papered over, because it is exactly what makes these worth doing.
        </p>
        <div className="flex flex-wrap gap-[6px]">
          {(corpus?.uncanoned ?? []).map((id) => (
            <Chip key={id} active={false} onClick={() => navigate(`/canon?pattern=${encodeURIComponent(id)}`)}>
              {id}
            </Chip>
          ))}
          {corpus !== null && corpus.uncanoned.length === 0 && (
            <span className="text-[12px] text-text-muted">Every implemented pattern carries a canon file.</span>
          )}
        </div>
      </Section>

      {staging.sessions.length > 0 && (
        <Section title="Your staged work">
          <p className="mb-[8px] text-[12px] text-text-muted">
            {staging.sessions.length} session(s) waiting in this browser.
          </p>
          <ActionBtn onClick={() => navigate('/staged')}>Open staged work</ActionBtn>
        </Section>
      )}
    </div>
  )
}

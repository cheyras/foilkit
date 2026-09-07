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
//
// ── WHAT #11 ADDED, AND WHY THE TABLE STAYED ───────────────────────────────
//
// The leverage ranking answers one question exactly — where does an hour move
// the most pixels — and it is still the impact spine of this page. What it
// could not do was be a LIST. Five other kinds of contribution were recorded
// in this repository and invisible from here: an approximated recipe, a
// canon-less pattern, a standing verification nay, a machine mask nobody
// corrected, an untargeted research residual, an empty resolver pool. A
// contributor who could not do a mask had nothing to read.
//
// So the table became one section of a laundry list. `data/task-queue.json`
// (tools/build-task-queue.mts, every build, no database) carries every one of
// those as a task card that says what is needed, roughly how long, which skill
// it wants, how many printings it moves and which file it came from. This
// surface renders it and filters it; it computes NOTHING, so the page and the
// generator can never disagree about what the queue says.

import { useEffect, useMemo, useState } from 'react'
import { ActionBtn, Chip, Section, SurfaceTabs } from './ui.tsx'
import { foilApi } from './api.ts'
import { CorpusView } from './catalog/manifest.ts'
import { assessStaleness, getJson } from './catalog/artifacts.ts'
import type { CatalogIndex } from './catalog/shards.ts'
import { navigate } from './router.ts'
import { RESOLVER_VERSION } from '@foilkit/resolver'
import type { Staging } from './staging/useStaging.ts'
import { EmptyPools, TaskCard, TaskFilters } from './queue/TaskCards.tsx'
import { filterTasks, type Filters, type TaskQueueFile } from './queue/taskQueue.ts'

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

/**
 * How many cards the list shows before "show the rest".
 *
 * A hundred-odd cards is the honest length of this backlog and hiding it would
 * be the same lie a progress bar tells. But a first screen that is one long
 * scroll is a first screen nobody reads, so the tail is one press away and the
 * button says how many are behind it.
 */
const FIRST_SCREEN = 20

export function Queue({ staging }: { staging: Staging }): React.ReactElement {
  const [map, setMap] = useState<VerificationMapFile | null>(null)
  const [queue, setQueue] = useState<TaskQueueFile | null>(null)
  const [filters, setFilters] = useState<Filters>({ skill: null, type: null })
  const [showAll, setShowAll] = useState(false)
  const [corpus, setCorpus] = useState<CorpusView | null>(null)
  /**
   * The catalog index is checked separately from the map, because they are
   * baked together but committed independently and the failure they produce is
   * different. A missing MAP means no queue; a missing CATALOG means the queue
   * ranks correctly and every card it offers is a 404. The second is the more
   * confusing one, so it gets its own banner rather than being inferred.
   */
  const [catalogIndex, setCatalogIndex] = useState<CatalogIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<'all' | 'window' | 'sheet' | 'full'>('all')
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const [m, c, idx, q] = await Promise.all([
        getJson<VerificationMapFile>('/foil-verification-map.json', ac.signal),
        CorpusView.load(ac.signal),
        getJson<CatalogIndex>('/catalog/index.json', ac.signal),
        getJson<TaskQueueFile>('/task-queue.json', ac.signal),
      ])
      setMap(m)
      setCorpus(c)
      setCatalogIndex(idx)
      setQueue(q)
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

  const visible = useMemo(() => filterTasks(queue?.tasks ?? [], filters), [queue, filters])
  const shown = showAll ? visible : visible.slice(0, FIRST_SCREEN)

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
      {!loading && catalogIndex === null && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-[10px] text-[13px] text-amber-200">
          No catalog has been baked for this site. The ranking below is real, but every card it points at is a
          missing file — run <code>tools/bake-catalog.mts</code> and commit its output (see RUN-BAKE.md).
        </p>
      )}

      {!loading && queue === null && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-[10px] text-[13px] text-amber-200">
          No task queue has been generated for this site. It is a build step —{' '}
          <code>tools/build-task-queue.mts</code> — so its absence means the build did not finish, not that there
          is no work.
        </p>
      )}

      {queue !== null && (
        <Section title="Everything that needs doing">
          <p className="mb-[10px] text-[13px] leading-[1.5] text-text-muted">
            {queue.counts.tasks} things, generated from six committed artifacts and sorted by{' '}
            <span className="text-text-primary">impact</span> — printings the resolver assigns to the rule each one
            teaches. Nothing here is a wish list: every card names the file it came from, and a card that would
            need a resolver winner flipped is marked as research rather than as drawing. Filter by what you can
            do.
          </p>

          <TaskFilters tasks={queue.tasks} filters={filters} onChange={setFilters} />

          {visible.length === 0 ? (
            <p className="text-[12px] text-text-muted">
              Nothing matches those two filters together. Loosen one — the counts on each chip say what is behind
              it.
            </p>
          ) : (
            <>
              <ul data-testid="task-list" className="flex flex-col gap-[8px]">
                {shown.map((t) => (
                  <TaskCard key={t.id} task={t} guardText={queue.guards} />
                ))}
              </ul>
              {visible.length > shown.length && (
                <div className="mt-[10px]">
                  <ActionBtn onClick={() => setShowAll(true)}>
                    Show the other {visible.length - shown.length}
                  </ActionBtn>
                </div>
              )}
            </>
          )}

          <p className="mt-[10px] text-[11px] leading-[1.5] text-text-muted">
            {queue.counts.impactTotal.toLocaleString()} printings governed across every card that could be sized;{' '}
            {queue.counts.unsized} could not be, and say so rather than showing a zero. Generated from data as of{' '}
            {new Date(queue.generatedAt).toLocaleString()}
            {queue.resolverVersion === null ? '' : ` against resolver v${queue.resolverVersion}`}.
          </p>
        </Section>
      )}

      <Section title="Where an hour moves the most pixels">
        <p className="mb-[10px] text-[13px] leading-[1.5] text-text-muted">
          The impact spine of the list above, in its own units. Every printing already has an answer — the
          resolver assigns a pattern, the era layout gives it a footprint, and the composite law renders it. A card
          nobody has looked at is <em>guessed</em>, not missing. Looking at one upgrades a guess to a decision, and
          that decision becomes evidence the next generative pass uses on everything else in its group. Ranked by{' '}
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
                        <ActionBtn
                          onClick={() => void openGroup(g)}
                          disabled={opening === g.key || catalogIndex === null}
                        >
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

      {/*
        The canon-less patterns used to be a row of bare chips here. They are
        now `canon` task cards in the list above, with an impact number, an
        estimate and the same deep link — which is strictly more than a chip
        said. The chips stay as a fast jump-off, because "I know which pattern
        I came for" is a real way to arrive and the list is sorted for the
        other one.
      */}
      <Section title="Patterns nobody has canon'd">
        <p className="mb-[8px] text-[13px] text-text-muted">
          A pattern with no canon file inherits whatever the code defaults say at read time. That absence is
          recorded rather than papered over, because it is exactly what makes these worth doing. Each is also a
          card above, ranked by the printings it moves.
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

      {queue !== null && queue.emptyPools.length > 0 && (
        <Section title="Recipes the resolver never picks">
          <p className="mb-[10px] text-[13px] leading-[1.5] text-text-muted">
            {queue.emptyPools.length} implemented recipes have an empty pool — no printing in this catalog resolves
            to them. The bake distinguishes <em>four causes</em>, and they are four different contributions rather
            than one backlog. The diagnosis sentence under each is the bake's own, printed unchanged.
          </p>
          <EmptyPools pools={queue.emptyPools} guardText={queue.guards} />
        </Section>
      )}

      {queue !== null && queue.reconciliation.length > 0 && (
        <Section title="What the documents say, and what the data says">
          <p className="mb-[10px] text-[13px] leading-[1.5] text-text-muted">
            This queue is generated from the corpus, not from the prose about it. Where a document states a count,
            the generator checks it and prints the disagreement rather than resolving it silently — a stale
            sentence is a finding, and the measurement wins.
          </p>
          <ul className="flex flex-col gap-[8px]">
            {queue.reconciliation.map((r) => (
              <li
                key={r.key}
                data-testid="reconciliation"
                className={`rounded-md border p-[10px] ${
                  r.agrees ? 'border-border-default bg-surface-tertiary' : 'border-amber-500/40 bg-amber-500/10'
                }`}
              >
                <div className="mb-[4px] flex items-baseline justify-between gap-[8px]">
                  <span className="text-[13px] text-text-primary">{r.key}</span>
                  <span className={`text-[10px] uppercase tracking-[0.06em] ${r.agrees ? 'text-text-muted' : 'text-amber-200'}`}>
                    {r.agrees ? 'agrees' : 'stale'}
                  </span>
                </div>
                <p className="mb-[4px] text-[12px] leading-[1.5] text-text-muted">
                  <span className="text-text-primary">The doc says:</span> “{r.claim}” — {r.claimedAt}
                </p>
                <p className="mb-[4px] text-[12px] leading-[1.5] text-text-muted">
                  <span className="text-text-primary">The data says:</span> {r.measured}
                </p>
                <p className="text-[11px] leading-[1.5] text-text-muted">{r.note}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

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

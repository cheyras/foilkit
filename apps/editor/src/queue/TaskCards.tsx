// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The task card, the filter chips, and the empty-pool diagnosis.
//
// WHAT A CARD SAYS, and the order it says it in:
//
//   Charizard                                            [mask]  400 printings
//   Draw the foil zone on Charizard
//   A machine put a window-scope mask on this printing and nobody corrected it…
//   Mask drawing · about half an hour · the AI proposal is already on the canvas
//   ⚠ <guard, when one applies>
//   Open the card ›                          from data/corpus-manifest.json — …
//
// The title is an INSTRUCTION naming the actual thing ("Draw the foil zone on
// this Charizard"), never a category ("tune the cracked-ice canon"). That
// distinction is the whole design brief for this surface: a contributor should
// be able to read one line and know whether they can do it in the next half
// hour.
//
// EVERY CARD SHOWS ITS SOURCE, in small type at the bottom. Not decoration:
// this queue is generated, and a generated list that cannot be traced back to
// the file it came from is indistinguishable from one somebody made up.

import { ActionBtn, Chip } from '../ui.tsx'
import { navigate } from '../router.ts'
// NOTHING HERE INDEXES A LABEL MAP DIRECTLY. Reading a badge straight out of
// the type table, for a type this build had not heard of, threw during render
// and unmounted the whole app — see taskQueue.ts, "the artifact can be newer
// than this client"; a unit test reads this file and fails on a bare `[`. Every
// lookup goes through the degrading helpers, and the chip rows come from
// `typeOrderFor` / `skillOrderFor` so a new kind gets a control rather than
// having its cards hidden behind one that does not exist.
import {
  chipCounts,
  estimateLabel,
  skillLabel,
  skillOrderFor,
  typeLabel,
  typeOrderFor,
  type EmptyPool,
  type Filters,
  type Task,
} from './taskQueue.ts'

/** The impact number, or an honest admission that this bake cannot size it. */
function Impact({ task }: { task: Task }): React.ReactElement {
  if (task.impact === null) {
    return (
      <span className="shrink-0 text-[11px] text-text-muted" title={task.impactWhy}>
        not sizeable
      </span>
    )
  }
  return (
    <span className="shrink-0 tabular-nums text-[12px] text-text-primary" title={task.impactWhy}>
      {task.impact.toLocaleString()} <span className="text-text-muted">printings</span>
    </span>
  )
}

export function TaskCard({ task, guardText }: { task: Task; guardText: Record<string, string> }): React.ReactElement {
  const type = typeLabel(task.type)
  return (
    <li className="rounded-md border border-border-default bg-surface-tertiary p-[10px]">
      <div className="mb-[4px] flex items-start justify-between gap-[8px]">
        <span className="flex flex-wrap items-center gap-[6px]">
          <span
            className="rounded border border-border-default px-[5px] py-[1px] text-[10px] uppercase tracking-[0.06em] text-text-muted"
            title={type.what}
          >
            {type.badge}
          </span>
          <span className="text-[13px] text-text-primary">{task.title}</span>
        </span>
        <Impact task={task} />
      </div>

      <p className="mb-[6px] text-[12px] leading-[1.5] text-text-muted">{task.need}</p>

      <p className="mb-[6px] text-[11px] text-text-muted">
        <span className="text-text-primary">{skillLabel(task.skill)}</span>
        {' · '}
        <span className="text-text-primary">{estimateLabel(task.estimate)}</span>
        {' — '}
        {task.estimateWhy}
      </p>

      {task.guards.map((g) => (
        <p
          key={g}
          data-testid="task-guard"
          className="mb-[6px] rounded border border-amber-500/40 bg-amber-500/10 p-[6px] text-[11px] leading-[1.5] text-amber-200"
        >
          {guardText[g] ?? g}
        </p>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-[6px]">
        {task.link === null ? (
          <span className="text-[11px] text-text-muted">No single card addresses this one.</span>
        ) : (
          <ActionBtn onClick={() => navigate(task.link!)}>Open it</ActionBtn>
        )}
        <span className="text-[10px] text-text-muted">{task.source}</span>
      </div>
    </li>
  )
}

/**
 * The two filter rows.
 *
 * SKILL first, because "what can I do" is the question a contributor arrives
 * with; type second, because it is a way to browse rather than a way to
 * choose. Both show their card count, and a chip with none is disabled rather
 * than hidden — a control that disappears when you change another control is
 * how a filter stops being legible.
 */
export function TaskFilters({
  tasks,
  filters,
  onChange,
}: {
  tasks: Task[]
  filters: Filters
  onChange: (f: Filters) => void
}): React.ReactElement {
  const counts = chipCounts(tasks, filters)
  return (
    <div className="mb-[10px] flex flex-col gap-[6px]">
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="mr-[2px] text-[11px] uppercase tracking-[0.06em] text-text-muted">Skill</span>
        <Chip active={filters.skill === null} onClick={() => onChange({ ...filters, skill: null })}>
          Anything ({tasks.filter((t) => filters.type === null || t.type === filters.type).length})
        </Chip>
        {skillOrderFor(tasks).map((s) => (
          <Chip
            key={s}
            active={filters.skill === s}
            disabled={(counts.skills[s] ?? 0) === 0 && filters.skill !== s}
            onClick={() => onChange({ ...filters, skill: filters.skill === s ? null : s })}
          >
            {skillLabel(s)} ({counts.skills[s] ?? 0})
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="mr-[2px] text-[11px] uppercase tracking-[0.06em] text-text-muted">Kind</span>
        <Chip active={filters.type === null} onClick={() => onChange({ ...filters, type: null })}>
          Everything
        </Chip>
        {typeOrderFor(tasks).map((t) => (
          <Chip
            key={t}
            active={filters.type === t}
            disabled={(counts.types[t] ?? 0) === 0 && filters.type !== t}
            onClick={() => onChange({ ...filters, type: filters.type === t ? null : t })}
          >
            {typeLabel(t).badge} ({counts.types[t] ?? 0})
          </Chip>
        ))}
      </div>
    </div>
  )
}

/**
 * The empty-pool diagnosis, rendered VERBATIM.
 *
 * `detail` is the bake's own sentence and it is printed exactly as written —
 * paraphrasing a diagnosis is how a diagnosis stops being one. `implies` is
 * this queue's addition and is visually separated from it, because the four
 * causes imply four different contributions and a reader has to be able to
 * tell which half is measurement and which half is advice.
 */
export function EmptyPools({ pools, guardText }: { pools: EmptyPool[]; guardText: Record<string, string> }): React.ReactElement {
  return (
    <ul className="flex flex-col gap-[8px]">
      {pools.map((p) => (
        <li key={p.patternId} className="rounded-md border border-border-default bg-surface-tertiary p-[10px]">
          <div className="mb-[4px] flex flex-wrap items-baseline justify-between gap-[6px]">
            <span className="text-[13px] text-text-primary">{p.patternId}</span>
            <span className="rounded border border-border-default px-[5px] py-[1px] text-[10px] uppercase tracking-[0.06em] text-text-muted">
              {p.reason}
            </span>
          </div>
          <p data-testid="diagnosis-verbatim" className="mb-[6px] text-[12px] leading-[1.5] text-text-muted">
            {p.detail}
          </p>
          {p.outrankedBy.length > 0 && (
            <p className="mb-[6px] text-[11px] text-text-muted">
              Outranked by{' '}
              {p.outrankedBy.map((o, i) => (
                <span key={o.patternId}>
                  {i > 0 && ', '}
                  <span className="text-text-primary">{o.patternId}</span> ({o.printings.toLocaleString()})
                </span>
              ))}
              .
            </p>
          )}
          <p className="text-[11px] leading-[1.5] text-text-primary">{p.implies}</p>
          {p.reason === 'outranked' && (
            <p className="mt-[6px] rounded border border-amber-500/40 bg-amber-500/10 p-[6px] text-[11px] leading-[1.5] text-amber-200">
              {guardText['do-not-flip-winners']}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

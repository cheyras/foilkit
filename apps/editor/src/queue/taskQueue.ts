// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The contribution queue, client side: the artifact's shape and the two pure
// functions that turn it into what the page shows.
//
// Everything here is PURE and separate from the rendering on purpose. "Does
// the skill filter show the right cards" and "does the type filter compose
// with it" are questions about a list, and answering them in a unit test is
// cheaper and more exact than answering them in a browser — the E2E run then
// only has to prove the control is wired to the function, not that the
// function is right.
//
// NOTHING IS COMPUTED HERE. Impact, estimate, skill, guards and the sort order
// are all decided by tools/task-queue/build.ts and baked into the artifact, so
// the page and the CLI can never disagree about what the queue says. This file
// filters and counts; it does not rank.

/** The tiers, in the order a contributor scans them. Matches build.ts. */
export type Estimate = 'minutes' | 'half-hour' | 'hours'

export type Skill = 'mask' | 'slider' | 'glsl' | 'research' | 'live-tilt'

export type TaskType =
  | 'approximation'
  | 'canon'
  | 'verdict'
  | 'mask'
  | 'window-mask'
  | 'residual'
  | 'empty-pool'

export interface Task {
  id: string
  type: TaskType
  title: string
  need: string
  skill: Skill
  estimate: Estimate
  estimateWhy: string
  impact: number | null
  impactWhy: string
  link: string | null
  source: string
  guards: string[]
  tieBreak: number
  detail: Record<string, string | number | boolean | null>
}

export interface EmptyPool {
  patternId: string
  reason: string
  detail: string
  citedPrintings: number
  alternates: number
  outrankedBy: { patternId: string; printings: number }[]
  implies: string
}

export interface Reconciliation {
  key: string
  claim: string
  claimedAt: string
  measured: string
  agrees: boolean
  note: string
}

export interface TaskQueueFile {
  version: number
  generatedAt: string
  source: string | null
  resolverVersion: number | null
  skills: Record<string, string>
  guards: Record<string, string>
  estimateTiers: Record<string, string>
  bakedInputs: Record<string, boolean>
  counts: {
    tasks: number
    byType: Record<string, number>
    bySkill: Record<string, number>
    impactTotal: number
    unsized: number
  }
  reconciliation: Reconciliation[]
  emptyPools: EmptyPool[]
  tasks: Task[]
}

/**
 * The badge each type wears, and the one-line answer to "what IS this".
 *
 * A type badge that only repeated the slug would be decoration. The second
 * string is what a contributor who has never seen this queue needs in order to
 * decide whether the card is for them.
 */
export const TYPE_LABEL: Record<TaskType, { badge: string; what: string }> = {
  mask: {
    badge: 'mask',
    what: 'A machine drew this mask and nobody checked it, so it carries no exemplar weight.',
  },
  'window-mask': {
    badge: 'first mask',
    what: 'A rule with no admissible exemplar anywhere. The first hand mask here seeds a whole group.',
  },
  canon: {
    badge: 'canon',
    what: 'No saved uniform snapshot, so this pattern renders whatever the code defaults happen to be.',
  },
  approximation: {
    badge: 'recipe',
    what: 'No faithful GLSL — this type renders through another recipe and says so.',
  },
  verdict: {
    badge: 'verdict',
    what: 'A judging round returned a nay that nothing has closed.',
  },
  residual: {
    badge: 'residual',
    what: 'The research recorded a claim it could not target down to specific cards.',
  },
  'empty-pool': {
    badge: 'empty pool',
    what: 'An implemented recipe the resolver never picks. The bake says which of four causes.',
  },
}

/** How long, in words a contributor can plan around. */
export const ESTIMATE_LABEL: Record<Estimate, string> = {
  minutes: 'minutes',
  'half-hour': 'about half an hour',
  hours: 'hours',
}

export const SKILL_ORDER: Skill[] = ['mask', 'slider', 'glsl', 'research', 'live-tilt']

export const SKILL_LABEL: Record<Skill, string> = {
  mask: 'Mask drawing',
  slider: 'Slider tuning',
  glsl: 'GLSL',
  research: 'Research / citation',
  'live-tilt': 'Live tilt',
}

export const TYPE_ORDER: TaskType[] = [
  'mask',
  'window-mask',
  'canon',
  'approximation',
  'verdict',
  'residual',
  'empty-pool',
]

export interface Filters {
  /** null = every skill. */
  skill: Skill | null
  /** null = every type. */
  type: TaskType | null
}

/**
 * Apply the filters. The artifact is already sorted by impact, so this
 * PRESERVES ORDER rather than re-sorting — a filtered list that re-ranked
 * itself would show a different "most valuable next thing" depending on which
 * chip happened to be pressed, which is the opposite of what a ranking is for.
 */
export function filterTasks(tasks: Task[], f: Filters): Task[] {
  return tasks.filter((t) => (f.skill === null || t.skill === f.skill) && (f.type === null || t.type === f.type))
}

/**
 * How many cards each chip would show, given the OTHER filter.
 *
 * Counted against the co-filter rather than against everything, so a chip that
 * would produce an empty list can be shown as empty before it is pressed. A
 * dead-end control that only reveals itself after a click is worse than one
 * that says so.
 */
export function chipCounts(tasks: Task[], f: Filters): { skills: Record<string, number>; types: Record<string, number> } {
  const skills: Record<string, number> = {}
  const types: Record<string, number> = {}
  for (const t of tasks) {
    if (f.type === null || t.type === f.type) skills[t.skill] = (skills[t.skill] ?? 0) + 1
    if (f.skill === null || t.skill === f.skill) types[t.type] = (types[t.type] ?? 0) + 1
  }
  return { skills, types }
}

/** Printings governed by a list of cards; unsizeable cards contribute nothing. */
export function impactOf(tasks: Task[]): number {
  return tasks.reduce((n, t) => n + (t.impact ?? 0), 0)
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The queue page's pure half. The E2E run proves the chips are wired to these
// functions; this proves the functions are right, which is the half a browser
// is a bad instrument for.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  chipCounts,
  ESTIMATE_LABEL,
  estimateLabel,
  filterTasks,
  impactOf,
  SKILL_LABEL,
  SKILL_ORDER,
  skillLabel,
  skillOrderFor,
  TYPE_LABEL,
  TYPE_ORDER,
  typeLabel,
  typeOrderFor,
  type Task,
} from './taskQueue.ts'

const HERE = join(fileURLToPath(import.meta.url), '..')

const task = (over: Partial<Task> & Pick<Task, 'id' | 'type' | 'skill'>): Task => ({
  title: 'x',
  need: 'x',
  estimate: 'hours',
  estimateWhy: 'x',
  impact: null,
  impactWhy: 'x',
  link: null,
  source: 'x',
  guards: [],
  tieBreak: 0,
  detail: {},
  ...over,
})

const TASKS: Task[] = [
  task({ id: 'a', type: 'window-mask', skill: 'mask', impact: 1600 }),
  task({ id: 'b', type: 'canon', skill: 'slider', impact: 900 }),
  task({ id: 'c', type: 'mask', skill: 'mask', impact: 400 }),
  task({ id: 'd', type: 'verdict', skill: 'live-tilt', impact: 12 }),
  task({ id: 'e', type: 'residual', skill: 'research', impact: null }),
]

test('no filter shows everything, in the artifact order', () => {
  assert.deepEqual(
    filterTasks(TASKS, { skill: null, type: null }).map((t) => t.id),
    ['a', 'b', 'c', 'd', 'e'],
  )
})

test('a skill filter shows exactly that skill', () => {
  assert.deepEqual(filterTasks(TASKS, { skill: 'mask', type: null }).map((t) => t.id), ['a', 'c'])
  assert.deepEqual(filterTasks(TASKS, { skill: 'live-tilt', type: null }).map((t) => t.id), ['d'])
})

test('skill and type compose rather than replacing each other', () => {
  assert.deepEqual(filterTasks(TASKS, { skill: 'mask', type: 'mask' }).map((t) => t.id), ['c'])
  assert.deepEqual(filterTasks(TASKS, { skill: 'mask', type: 'canon' }), [])
})

test('filtering never re-ranks — the most valuable next thing does not depend on which chip is pressed', () => {
  const filtered = filterTasks(TASKS, { skill: 'mask', type: null })
  const positions = filtered.map((t) => TASKS.indexOf(t))
  assert.deepEqual([...positions].sort((x, y) => x - y), positions)
})

test('chip counts are computed against the OTHER filter, so a dead chip reads as dead before it is pressed', () => {
  const all = chipCounts(TASKS, { skill: null, type: null })
  assert.equal(all.skills.mask, 2)
  assert.equal(all.types.canon, 1)

  // With type=canon selected, only the slider skill has anything behind it.
  const underCanon = chipCounts(TASKS, { skill: null, type: 'canon' })
  assert.equal(underCanon.skills.slider, 1)
  assert.equal(underCanon.skills.mask, undefined)
  // …and the TYPE counts still ignore the type filter, or every other type
  // would read as zero the moment one was chosen.
  assert.equal(underCanon.types.mask, 1)
})

test('impact sums printings and treats unsizeable cards as unknown, not zero', () => {
  assert.equal(impactOf(TASKS), 1600 + 900 + 400 + 12)
  assert.equal(impactOf([task({ id: 'z', type: 'residual', skill: 'research' })]), 0)
})

test('every type and skill the artifact can emit has a label, or the badge renders a slug', () => {
  for (const t of TYPE_ORDER) {
    assert.ok(TYPE_LABEL[t], `no badge for ${t}`)
    assert.ok(TYPE_LABEL[t].what.length > 20, `${t}'s badge explains nothing`)
  }
  assert.equal(TYPE_ORDER.length, Object.keys(TYPE_LABEL).length, 'a type is labelled but not ordered, or vice versa')
  assert.equal(SKILL_ORDER.length, Object.keys(SKILL_LABEL).length, 'a skill is labelled but not ordered, or vice versa')
  // The seventh source (R8-INK) put an `ink-tile` card in the artifact and a
  // new `art` skill under it. The client that did not know them white-screened
  // in production, so both are pinned here by NAME rather than by count.
  assert.ok(TYPE_ORDER.includes('ink-tile'), 'the ink-tile kind is not in the type order')
  assert.equal(TYPE_LABEL['ink-tile'].badge, 'ink tile')
  assert.ok(SKILL_ORDER.includes('art'), 'the art skill is not in the skill order')
  assert.equal(SKILL_LABEL.art, 'Original geometry')
})

// ── THE WHITE SCREEN ────────────────────────────────────────────────────────
//
// `data/task-queue.json` is fetched at runtime and the builder that writes it
// ships separately from this bundle. When the builder gained a seventh source,
// `TYPE_LABEL[task.type].what` threw on the first card carrying the new type,
// React unmounted the tree, and the editor's LANDING PAGE went white — while
// every test passed, because the fixture ranked those cards off the first
// screen and the real queue put them at positions 10 and 11.
//
// The invariant, forever: a queue datum this build has never heard of renders
// DEGRADED BUT ALIVE. These tests use ids no builder will ever emit, because a
// test that used the next real id would only prove the last mistake.

test('an alien task type renders as itself instead of throwing', () => {
  const label = typeLabel('quantum-mask')
  assert.equal(label.badge, 'quantum-mask')
  assert.ok(label.what.length > 20, 'the unknown-type explanation says nothing')
  assert.match(label.what, /newer build/i)
})

test('an alien skill and an alien estimate render as themselves', () => {
  assert.equal(skillLabel('haruspicy'), 'haruspicy')
  assert.equal(estimateLabel('a fortnight'), 'a fortnight')
  // …and the known ones are untouched.
  assert.equal(skillLabel('mask'), SKILL_LABEL.mask)
  assert.equal(estimateLabel('half-hour'), ESTIMATE_LABEL['half-hour'])
})

test('a prototype key is a slug, not an inherited member — the adversarial white screen', () => {
  // `SKILL_LABEL['toString']` inherits a FUNCTION off Object.prototype, and
  // React throws on a function child: a plain `map[id] ?? fallback` guard would
  // have turned this one slug straight back into the white screen. Every lookup
  // is own-property only.
  for (const evil of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.equal(skillLabel(evil), evil, `skillLabel leaked a prototype member for ${evil}`)
    assert.equal(estimateLabel(evil), evil, `estimateLabel leaked a prototype member for ${evil}`)
    const t = typeLabel(evil)
    assert.equal(t.badge, evil, `typeLabel leaked a prototype member for ${evil}`)
    assert.equal(typeof t.what, 'string')
  }
})

test('an alien type and skill still get a filter chip, so their cards can be isolated', () => {
  const alien = [...TASKS, task({ id: 'x', type: 'quantum-mask', skill: 'haruspicy', impact: 7 })]
  const types = typeOrderFor(alien)
  const skills = skillOrderFor(alien)
  // Known ids keep their scan order, and the unknown one is APPENDED rather
  // than dropped — a chip that is not there is a filter that cannot express
  // part of the list it filters.
  assert.deepEqual(types.slice(0, TYPE_ORDER.length), TYPE_ORDER)
  assert.deepEqual(skills.slice(0, SKILL_ORDER.length), SKILL_ORDER)
  assert.equal(types.at(-1), 'quantum-mask')
  assert.equal(skills.at(-1), 'haruspicy')
  // And the counts behind those chips are real, so the chip is not disabled.
  const counts = chipCounts(alien, { skill: null, type: null })
  assert.equal(counts.types['quantum-mask'], 1)
  assert.equal(counts.skills.haruspicy, 1)
  // Filtering to the alien kind works like any other.
  assert.deepEqual(filterTasks(alien, { skill: null, type: 'quantum-mask' }).map((t) => t.id), ['x'])
})

test('the card component never indexes a label map directly — the guard cannot be walked back', () => {
  // The functions above are only worth having if the renderer uses them. This
  // reads the component's SOURCE, because the alternative — rendering TSX in
  // node:test — needs a JSX transform this suite deliberately does not carry.
  const src = readFileSync(join(HERE, 'TaskCards.tsx'), 'utf8')
  for (const map of ['TYPE_LABEL', 'SKILL_LABEL', 'ESTIMATE_LABEL']) {
    assert.ok(!src.includes(`${map}[`), `TaskCards.tsx indexes ${map} directly — that is the white screen`)
  }
  // …and it builds its chip rows from the task list rather than from the
  // build-time order, or a new kind would have no chip.
  assert.match(src, /typeOrderFor\(tasks\)/)
  assert.match(src, /skillOrderFor\(tasks\)/)
})

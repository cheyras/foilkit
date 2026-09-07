// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The queue page's pure half. The E2E run proves the chips are wired to these
// functions; this proves the functions are right, which is the half a browser
// is a bad instrument for.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chipCounts,
  filterTasks,
  impactOf,
  SKILL_ORDER,
  TYPE_LABEL,
  TYPE_ORDER,
  type Task,
} from './taskQueue.ts'

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
  assert.equal(SKILL_ORDER.length, 5)
})

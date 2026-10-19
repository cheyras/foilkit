// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFoil } from '../resolver.ts'

const ball = (variantKind: string) =>
  resolveFoil({ seriesSlug: 'scarlet-violet', setId: 'sv10.5w', setName: 'White Flare', rarity: 'Common', variantKind, cardName: 'Snivy', cardId: 'sv10.5w-001' })

test('a row may pin recipe dials: the Master Ball reverse is the ball recipe with uP2 1', () => {
  const mb = ball('reverse-foil-masterball')
  assert.equal(mb.patternId, 'pokeball-masterball')
  assert.deepEqual(mb.params, { uP2: 1 })
})

test('rows without params return none, so every other printing is unchanged', () => {
  const pb = ball('reverse-foil-pokeball')
  assert.equal(pb.patternId, 'pokeball-masterball')
  assert.equal(pb.params, undefined)
  assert.equal(ball('reverse').params, undefined)
})

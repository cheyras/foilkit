// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/task-queue/build.test.ts — the contribution queue's generator, driven
// against synthetic corpora in a temp dir, and then against the real one.
//
// Two halves, and they check different things:
//
//  * SYNTHETIC. A hand-built root where every input is four lines long, so the
//    assertions can name exact task ids and exact impact numbers. This is
//    where the sort, the guards, the skills, the estimates and every loud
//    failure are pinned.
//  * REAL. The repository itself. This half asserts SHAPE rather than
//    numbers — every card names a source, every guard is a declared guard,
//    every link is a route the editor has — plus the composition snapshot,
//    which is allowed to change and says so when it does.
//
// The committed artifact is checked by CI's `--check`, not here: a test that
// re-derived the file and compared it would be the same assertion twice, and
// the CLI's version is the one that fails at the right moment.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildTaskQueue, serializeQueue, GUARDS, SKILLS, TaskQueueError, type Task } from './build.ts'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

// ── The synthetic corpus ────────────────────────────────────────────────────
//
// Real pattern ids throughout, because the builder cross-checks every id
// against PATTERNS and a made-up slug would fail for the wrong reason. The
// NUMBERS are invented, which is the point: nothing here is a measurement.

interface Overrides {
  manifest?: Record<string, unknown>
  verdicts?: Record<string, unknown>
  assignments?: Record<string, unknown>
  map?: Record<string, unknown> | null
  patternCards?: Record<string, unknown> | null
  catalog?: boolean
}

async function makeCorpus(over: Overrides = {}): Promise<{ root: string; bake: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'foilkit-tq-'))
  const bake = join(root, 'data')
  await mkdir(bake, { recursive: true })

  const manifest = over.manifest ?? {
    version: 1,
    generatedAt: '2026-01-02T00:00:00.000Z',
    masks: {
      'base1-4': {
        '15': {
          variantId: 15,
          scope: 'window',
          eraId: 'wotc',
          method: 'ai',
          reviewStatus: 'unreviewed',
          tier: 'unattributed',
          agreement: 0.4,
          savedAt: '2026-01-02T00:00:00.000Z',
        },
      },
      'base1-2': {
        '7': {
          variantId: 7,
          scope: 'window',
          eraId: 'wotc',
          method: 'ai',
          reviewStatus: 'unreviewed',
          tier: 'unattributed',
          agreement: 0.9,
          savedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      'base1-7': {
        '27': {
          variantId: 27,
          scope: 'window',
          eraId: 'wotc',
          method: 'hand',
          reviewStatus: 'human-authored',
          tier: 'owner-verified',
          agreement: 0.73,
          savedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
    maskUnits: { 'base1-4|window': 15, 'base1-2|window': 7, 'base1-7|window': 27 },
    uncanoned: ['acid-wash'],
  }

  const verdicts = over.verdicts ?? {
    version: 1,
    source: { doc: 'docs/VERIFICATION.md' },
    verdicts: [
      {
        patternId: 'radiant',
        verdict: 'nay',
        standing: true,
        wave: 'R3-MOTION',
        judgedOn: '2026-08-03',
        score: '13/20',
        docLines: 'docs/VERIFICATION.md:680',
        judgeNote: 'judge-blind',
        residual: 'crossfade reads as a slide in stills',
        stillFrameBlind: true,
        stillFrameNote: 'the frames pixel-refute the claim',
        ask: 'live-tilt',
        askDetail: 'Tilt it and say what you see.',
      },
      {
        patternId: 'energy-symbols',
        verdict: 'nay',
        standing: true,
        wave: 'R3-GLYPH',
        judgedOn: '2026-08-03',
        docLines: 'docs/VERIFICATION.md:755',
        judgeNote: 'placeholder icons',
        residual: 'needs the 9-icon atlas',
        stillFrameBlind: false,
        stillFrameNote: null,
        ask: 'glsl',
        askDetail: 'Ship the atlas.',
      },
      {
        patternId: 'starlight',
        verdict: 'yay',
        standing: false,
        wave: 'R3-MOTION',
        judgedOn: '2026-08-03',
        docLines: 'docs/VERIFICATION.md:677',
        judgeNote: 'the standing parallax nay is broken',
        residual: null,
        stillFrameBlind: false,
        stillFrameNote: null,
        ask: null,
        askDetail: null,
      },
    ],
  }

  const assignments = over.assignments ?? {
    known_residuals: [
      { lane: 'wotc', setId: 'base1', cls: 'holo', reason: 'the card list is missing' },
      { lane: 'wotc', setId: 'base1', cls: 'reverse', reason: 'closed already', resolved: '2026-01-01' },
    ],
    rows: [
      {
        pattern: 'vertical-sheen-rainbow',
        sel: { setIds: ['ex13'], cls: 'holo', cardIds: ['ex13-105'] },
      },
      {
        pattern: 'vertical-sheen-rainbow',
        sel: { setIds: ['ex16'], cls: 'holo', cardIds: ['ex16-103'] },
      },
    ],
  }

  await writeFile(join(bake, 'corpus-manifest.json'), JSON.stringify(manifest))
  await writeFile(join(bake, 'verification-verdicts.json'), JSON.stringify(verdicts))
  await writeFile(join(bake, 'foil-card-assignments.json'), JSON.stringify(assignments))

  const map =
    over.map === undefined
      ? {
          version: 1,
          generatedAt: '2026-02-01T00:00:00.000Z',
          source: 'synthetic',
          resolverVersion: 5,
          groups: [
            {
              key: 'wotc|window|starlight|set',
              eraId: 'wotc',
              scope: 'window',
              patternId: 'starlight',
              match: 'set',
              printings: 900,
              distinctCards: 800,
              exemplars: 1,
              maskCoveredCards: 3,
              leverage: 450,
            },
            {
              key: 'modern-sv|window|cosmos|set',
              eraId: 'modern-sv',
              scope: 'window',
              patternId: 'cosmos',
              match: 'set',
              printings: 1600,
              distinctCards: 1500,
              exemplars: 0,
              maskCoveredCards: 0,
              leverage: 1600,
            },
            {
              key: 'modern-sv|sheet|acid-wash|set',
              eraId: 'modern-sv',
              scope: 'sheet',
              patternId: 'acid-wash',
              match: 'set',
              printings: 40,
              distinctCards: 40,
              exemplars: 0,
              maskCoveredCards: 0,
              leverage: 40,
            },
            {
              key: 'modern-sv|window|radiant|set',
              eraId: 'modern-sv',
              scope: 'window',
              patternId: 'radiant',
              match: 'set',
              printings: 12,
              distinctCards: 12,
              exemplars: 2,
              maskCoveredCards: 2,
              leverage: 4,
            },
          ],
        }
      : over.map
  if (map !== null) await writeFile(join(bake, 'foil-verification-map.json'), JSON.stringify(map))

  const patternCards =
    over.patternCards === undefined
      ? {
          version: 3,
          generatedAt: '2026-02-01T00:00:00.000Z',
          diagnosis: {
            'tcg-classic': {
              reason: 'outranked',
              detail: '1,035 catalog printings are named by a cited row for this pattern.',
              alternates: 240,
              citedPrintings: 1035,
              outrankedBy: [['horizontal-sheen', 188]],
            },
            disco: { reason: 'sets-absent', detail: 'Cited on 1 set name(s) that do not exist.', alternates: 0, citedPrintings: 0 },
          },
        }
      : over.patternCards
  if (patternCards !== null) await writeFile(join(bake, 'foil-pattern-cards.json'), JSON.stringify(patternCards))

  if (over.catalog !== false) {
    await mkdir(join(bake, 'catalog', 'series'), { recursive: true })
    await mkdir(join(bake, 'catalog', 'sets'), { recursive: true })
    await writeFile(
      join(bake, 'catalog', 'series', 'base.json'),
      JSON.stringify({ seriesSlug: 'base', sets: [{ setId: 'base1', name: 'Base Set' }] }),
    )
    await writeFile(
      join(bake, 'catalog', 'sets', 'base1.json'),
      JSON.stringify({
        setId: 'base1',
        set: { name: 'Base Set' },
        page: 1,
        pageCount: 1,
        cards: [
          { cardId: 'base1-4', number: '4', name: 'Charizard', rarity: 'Rare', variants: [{ variantId: 15, kind: 'holo' }] },
          { cardId: 'base1-2', number: '2', name: 'Blastoise', rarity: 'Rare', variants: [{ variantId: 7, kind: 'holo' }] },
          { cardId: 'base1-7', number: '7', name: 'Hitmonchan', rarity: 'Rare', variants: [{ variantId: 27, kind: 'holo' }] },
        ],
      }),
    )
  }

  return { root, bake, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const byId = (tasks: Task[], id: string): Task => {
  const t = tasks.find((x) => x.id === id)
  assert.ok(t !== undefined, `no task ${id} — got ${tasks.map((x) => x.id).join(', ')}`)
  return t
}

// ── The composition ─────────────────────────────────────────────────────────

test('the six sources become one list, and every card names where it came from', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)

    // One card per input row, and nothing invented.
    assert.deepEqual(queue.counts.byType, {
      approximation: 1, // big-glitter, the only PATTERNS entry with implemented: false
      canon: 1, // acid-wash, from manifest.uncanoned
      verdict: 2, // the two standing nays; the yay is NOT a task
      mask: 2, // the two unreviewed units; the human-authored one is NOT a task
      'window-mask': 1, // only the cosmos group has exemplars === 0 at window scope
      residual: 1, // the closed one is NOT a task
      'empty-pool': 2,
    })
    assert.equal(queue.counts.tasks, 10)

    for (const t of queue.tasks) {
      assert.ok(t.source.length > 0, `${t.id} has no source`)
      assert.ok(t.title.length > 0 && t.need.length > 0, `${t.id} has no title or need`)
      assert.ok(t.estimateWhy.length > 0, `${t.id} has an estimate with no rationale`)
      assert.ok(t.impactWhy.length > 0, `${t.id} has an impact with no explanation`)
      assert.ok(Object.hasOwn(SKILLS, t.skill), `${t.id} wants an undeclared skill ${t.skill}`)
      for (const g of t.guards) assert.ok(Object.hasOwn(GUARDS, g), `${t.id} carries an undeclared guard ${g}`)
    }
  } finally {
    await cleanup()
  }
})

test('a card that is already done is not a card', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const ids = queue.tasks.map((t) => t.id)
    // base1-7 has a human-authored mask; the residual carries `resolved`;
    // starlight's nay was broken. None of the three is work.
    assert.ok(!ids.some((id) => id.includes('base1-7')), 'a human-authored mask became a task')
    assert.ok(!ids.includes('verdict:starlight'), 'a broken nay became a task')
    assert.equal(queue.tasks.filter((t) => t.type === 'residual').length, 1, 'a closed residual became a task')
  } finally {
    await cleanup()
  }
})

// ── Impact, and the order it produces ───────────────────────────────────────

test('tasks sort by impact, with unsizeable ones last rather than pretending to be zero', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const sized = queue.tasks.filter((t) => t.impact !== null).map((t) => t.impact!)
    assert.deepEqual([...sized].sort((a, b) => b - a), sized, 'sized tasks are not in descending impact order')
    const firstNull = queue.tasks.findIndex((t) => t.impact === null)
    if (firstNull >= 0) {
      assert.ok(
        queue.tasks.slice(firstNull).every((t) => t.impact === null),
        'a sized task sorted below an unsizeable one',
      )
    }
    // The cosmos window group, 1,600 printings, leads.
    assert.equal(queue.tasks[0]?.id, 'window-mask:modern-sv|window|cosmos|set')
  } finally {
    await cleanup()
  }
})

test('a mask is sized by the rule group its card resolves into, not by the card', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const charizard = byId(queue.tasks, 'mask:base1-4|window')
    assert.equal(charizard.detail.patternId, 'starlight', 'the resolver was not consulted for this printing')
    assert.equal(charizard.impact, 900, 'the mask was not sized by its wotc|window|starlight group')
    assert.equal(charizard.detail.setName, 'Base Set')
    assert.match(charizard.title, /Charizard/, 'the card card does not name the card')
  } finally {
    await cleanup()
  }
})

test('equal-impact masks are ordered by divergence — the era rule it disagrees with most, first', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const masks = queue.tasks.filter((t) => t.type === 'mask')
    assert.equal(masks[0]?.id, 'mask:base1-4|window', 'the 0.4-agreement mask did not lead')
    assert.equal(masks[0]?.detail.divergence, 0.6)
    assert.equal(masks[1]?.detail.divergence, 0.1)
    assert.equal(masks[0]?.impact, masks[1]?.impact, 'this test is meaningless unless the impacts tie')
  } finally {
    await cleanup()
  }
})

test('an outranked pool is NOT ranked by the printings it loses', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const outranked = byId(queue.tasks, 'empty-pool:tcg-classic')
    assert.equal(outranked.impact, null, '1,035 outranked printings were counted as impact')
    assert.equal(outranked.detail.citedPrintings, 1035, 'the real number was dropped instead of demoted')
    assert.match(outranked.impactWhy, /1,035/)
    const absent = byId(queue.tasks, 'empty-pool:disco')
    assert.equal(absent.impact, 0, 'a genuinely unreachable pattern should be zero, not unsizeable')
  } finally {
    await cleanup()
  }
})

// ── Skills, estimates and guards ────────────────────────────────────────────

test('a still-frame-blind nay asks for a live tilt, and says so on the card', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const radiant = byId(queue.tasks, 'verdict:radiant')
    assert.equal(radiant.skill, 'live-tilt')
    assert.equal(radiant.estimate, 'minutes')
    assert.deepEqual(radiant.guards, ['live-tilt-not-glsl'])
    assert.match(GUARDS['live-tilt-not-glsl'], /not another GLSL round/)
    assert.equal(radiant.detail.stillFrameBlind, true)

    // …and one whose residual is an ASSET is not turned into a tilt request.
    const energy = byId(queue.tasks, 'verdict:energy-symbols')
    assert.equal(energy.skill, 'glsl')
    assert.deepEqual(energy.guards, [])
  } finally {
    await cleanup()
  }
})

test('an outranked pool carries the do-not-flip-winners guard; an absent one does not', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    assert.deepEqual(byId(queue.tasks, 'empty-pool:tcg-classic').guards, ['do-not-flip-winners'])
    assert.deepEqual(byId(queue.tasks, 'empty-pool:disco').guards, [])
    assert.match(GUARDS['do-not-flip-winners'], /different physical layers/)
  } finally {
    await cleanup()
  }
})

test('a residual is research work and warns that closing it needs a bake', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    const r = byId(queue.tasks, 'residual:wotc:base1:holo')
    assert.equal(r.skill, 'research')
    assert.deepEqual(r.guards, ['needs-a-bake'])
    assert.equal(r.impact, 3, 'the residual was not sized against the catalog')
    assert.equal(r.link, '/card?id=base1-4&v=15', 'a residual with catalog rows should deep-link to one of them')
  } finally {
    await cleanup()
  }
})

test('the four empty-pool causes render verbatim, each with its own contribution', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue } = await buildTaskQueue(root, bake)
    assert.equal(queue.emptyPools.length, 2)
    const tcg = queue.emptyPools.find((p) => p.patternId === 'tcg-classic')!
    assert.equal(tcg.detail, '1,035 catalog printings are named by a cited row for this pattern.', 'the bake sentence was rewritten')
    assert.match(tcg.implies, /citation/)
    const disco = queue.emptyPools.find((p) => p.patternId === 'disco')!
    assert.notEqual(disco.implies, tcg.implies, 'two different causes implied the same contribution')
  } finally {
    await cleanup()
  }
})

// ── Reconciliation: a doc's count is a claim, not a measurement ──────────────

test('a doc count that disagrees with the data is emitted as a finding, not resolved silently', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const { queue, findings } = await buildTaskQueue(root, bake)
    const nays = queue.reconciliation.find((r) => r.key === 'standing-nays')!
    assert.equal(nays.agrees, false)
    assert.match(nays.claim, /4 standing nays/)
    assert.match(nays.measured, /energy-symbols, radiant/)
    assert.ok(findings.includes(nays), 'a disagreeing row was not reported as a finding')

    // The residual row AGREES in this corpus: two vertical-sheen-rainbow rows exist.
    const residuals = queue.reconciliation.find((r) => r.key === 'residuals')!
    assert.equal(residuals.agrees, true)
    assert.ok(!findings.includes(residuals))
  } finally {
    await cleanup()
  }
})

// ── Loud failures ───────────────────────────────────────────────────────────

test('a verdict for a pattern that does not exist fails the build by name', async () => {
  const { root, bake, cleanup } = await makeCorpus({
    verdicts: {
      version: 1,
      source: { doc: 'docs/VERIFICATION.md' },
      verdicts: [{ patternId: 'not-a-pattern', verdict: 'nay', standing: true, wave: 'R9', judgedOn: '2026-01-01', docLines: 'x', judgeNote: 'n', residual: null, stillFrameBlind: false, stillFrameNote: null, ask: null, askDetail: null }],
    },
  })
  try {
    await assert.rejects(() => buildTaskQueue(root, bake), (err: Error) => {
      assert.ok(err instanceof TaskQueueError)
      assert.match(err.message, /not-a-pattern/)
      return true
    })
  } finally {
    await cleanup()
  }
})

test('a diagnosis cause this builder has no contribution for fails rather than rendering a bare label', async () => {
  const { root, bake, cleanup } = await makeCorpus({
    patternCards: {
      version: 3,
      generatedAt: '2026-02-01T00:00:00.000Z',
      diagnosis: { disco: { reason: 'brand-new-cause', detail: 'x', alternates: 0, citedPrintings: 0 } },
    },
  })
  try {
    await assert.rejects(() => buildTaskQueue(root, bake), (err: Error) => {
      assert.match(err.message, /brand-new-cause/)
      return true
    })
  } finally {
    await cleanup()
  }
})

test('a manifest whose maskUnits point at a record it does not carry fails loudly', async () => {
  const { root, bake, cleanup } = await makeCorpus({
    manifest: {
      version: 1,
      generatedAt: '2026-01-02T00:00:00.000Z',
      masks: {},
      maskUnits: { 'base1-4|window': 15 },
      uncanoned: [],
    },
  })
  try {
    await assert.rejects(() => buildTaskQueue(root, bake), (err: Error) => {
      assert.match(err.message, /internally inconsistent/)
      return true
    })
  } finally {
    await cleanup()
  }
})

test('a missing committed input is fatal — that is a broken checkout, not an unrun job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foilkit-tq-empty-'))
  try {
    await assert.rejects(() => buildTaskQueue(root, join(root, 'data')), (err: Error) => {
      assert.match(err.message, /corpus-manifest\.json/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing BAKE is tolerated and recorded — the build must not need a database', async () => {
  const { root, bake, cleanup } = await makeCorpus({ map: null, patternCards: null, catalog: false })
  try {
    const { queue } = await buildTaskQueue(root, bake)
    assert.deepEqual(queue.bakedInputs, {
      'foil-verification-map.json': false,
      'foil-pattern-cards.json': false,
      catalog: false,
    })
    // The committed corpus still produces work; it just cannot be sized.
    assert.ok(queue.counts.tasks > 0)
    assert.equal(queue.counts.unsized, queue.counts.tasks)
    assert.equal(queue.emptyPools.length, 0)
    assert.equal(queue.source, null)
  } finally {
    await cleanup()
  }
})

// ── Determinism, because --check is CI's only proof ─────────────────────────

test('the same inputs serialize to the same bytes, and generatedAt is derived not clocked', async () => {
  const { root, bake, cleanup } = await makeCorpus()
  try {
    const a = await buildTaskQueue(root, bake)
    const b = await buildTaskQueue(root, bake)
    assert.equal(serializeQueue(a.queue), serializeQueue(b.queue))
    // The newest stamp any input carries — the map's, here.
    assert.equal(a.queue.generatedAt, '2026-02-01T00:00:00.000Z')
  } finally {
    await cleanup()
  }
})

// ── The real corpus ─────────────────────────────────────────────────────────

test('the real repository produces a queue whose every card is addressable', async () => {
  const { queue } = await buildTaskQueue(REPO, join(REPO, 'data'))

  assert.ok(queue.counts.tasks > 50, `only ${queue.counts.tasks} tasks — the real corpus has more work than that`)
  const ids = new Set(queue.tasks.map((t) => t.id))
  assert.equal(ids.size, queue.tasks.length, 'two task cards share an id')

  for (const t of queue.tasks) {
    if (t.link === null) continue
    assert.match(
      t.link,
      /^\/(card\?id=[^&]+&v=\d+|canon\?pattern=[^&]+)$/,
      `${t.id} deep-links to ${t.link}, which is not a route this editor has`,
    )
  }

  // Every skill chip the page can offer has at least one card behind it, or
  // the filter is a dead control.
  for (const skill of Object.keys(SKILLS)) {
    assert.ok((queue.counts.bySkill[skill] ?? 0) > 0, `no task wants the ${skill} skill, so its filter chip is dead`)
  }
})

test('the composition snapshot — change this deliberately, never to make a test pass', async () => {
  const { queue } = await buildTaskQueue(REPO, join(REPO, 'data'))
  // If this fails, the CORPUS moved. Read the diff, decide whether the move is
  // the one you meant, then update the numbers. Do not relax the assertion.
  assert.deepEqual(queue.counts.byType, {
    approximation: 1,
    canon: 12,
    verdict: 5,
    mask: 5,
    'window-mask': 34,
    residual: 43,
    'empty-pool': 8,
  })
  assert.deepEqual(queue.counts.bySkill, {
    glsl: 2,
    slider: 12,
    'live-tilt': 4,
    mask: 39,
    research: 51,
  })
})

test('the three doc counts this queue checks itself against are all currently stale', async () => {
  const { queue, findings } = await buildTaskQueue(REPO, join(REPO, 'data'))
  assert.deepEqual(
    findings.map((f) => f.key).sort(),
    ['approximations', 'standing-nays', 'uncanoned'],
    'the set of stale doc claims moved — a fixed doc is good news, but say so in the same commit',
  )
  // The one that is NOT stale: the ex13/ex16 residual closure already landed.
  const residuals = queue.reconciliation.find((r) => r.key === 'residuals')!
  assert.equal(residuals.agrees, true, 'the committed vertical-sheen-rainbow rows went missing')
  assert.match(residuals.measured, /12 closed/)
})

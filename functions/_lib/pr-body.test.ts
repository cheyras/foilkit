// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE DEDICATION IS VERBATIM, AND THIS FILE IS WHAT KEEPS IT THAT WAY.
//
// `CONTRIBUTING.md` publishes the CC0 dedication text and explains at length
// why a sign-off is not a dedication. `pr-body.ts` inserts that text into every
// data pull request automatically, which is the thing `CONTRIBUTING.md`
// promised would happen ("This will become automatic"). The two must be the
// same STRING, not the same idea: a dedication that differs from the published
// one by a word is a dedication somebody has to litigate years later, and the
// person it would fall on is a contributor who trusted the checkbox.
//
// So the first test reads `CONTRIBUTING.md` off disk and looks for the constant
// in it. If either moves without the other, the suite fails.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const {
  CC0_DEDICATION,
  SIGN_OFF_CAVEAT,
  coAuthoredBy,
  composeCommitMessage,
  composePrBody,
  displayName,
  noreplyAddress,
  prTitle,
  signedOffBy,
  touchesData,
} = await import('./pr-body.ts')

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONTRIBUTING = readFileSync(`${ROOT}/CONTRIBUTING.md`, 'utf8')
const TEMPLATE = readFileSync(`${ROOT}/.github/PULL_REQUEST_TEMPLATE.md`, 'utf8')

const CONTRIBUTOR = { login: 'octocat', name: 'Mona Lisa Octocat', id: 583231 }
const ANONYMOUS = { login: 'nonamehere', name: null, id: 99 }

// ── The licence acts ───────────────────────────────────────────────────────

test('the dedication constant is the text CONTRIBUTING.md publishes, byte for byte', () => {
  assert.ok(
    CONTRIBUTING.includes(CC0_DEDICATION),
    'CONTRIBUTING.md no longer contains the exact dedication string this module inserts.\n' +
      'One of the two moved. They are the same act and must be the same text.',
  )
})

test('the dedication names CC0 1.0 Universal and performs a waiver, not a licence grant', () => {
  assert.ok(CC0_DEDICATION.startsWith('CC0-Dedication:'), 'the trailer form is what a scanner looks for')
  assert.ok(CC0_DEDICATION.includes('CC0 1.0 Universal'))
  assert.ok(CC0_DEDICATION.includes('waiving all copyright'))
  assert.ok(CC0_DEDICATION.includes('to the extent permitted by law'))
})

test('the manual pull request template still exists — CONTRIBUTING.md said it would stay', () => {
  // The App composes contributions from the editor. Pull requests opened by
  // hand still need the checkbox, and `CONTRIBUTING.md` promised the template
  // would remain for exactly that.
  assert.ok(TEMPLATE.includes('CC0 dedication'))
  assert.ok(TEMPLATE.includes('creativecommons.org/publicdomain/zero/1.0'))
})

test('touchesData is true for anything under data/ and for any *.canon.json', () => {
  assert.equal(touchesData(['data/foil-masks/base1-4/15.png']), true)
  assert.equal(touchesData(['data/foil-canon/cosmos.json']), true)
  assert.equal(touchesData(['packages/patterns/src/patterns.ts', 'somewhere/else/x.canon.json']), true)
  assert.equal(touchesData(['packages/core/src/shader.ts', 'docs/TAXONOMY.md']), false)
  assert.equal(touchesData([]), false)
})

// ── Attribution ────────────────────────────────────────────────────────────

test('the noreply address is GitHub’s id+login form, which links to the profile', () => {
  assert.equal(noreplyAddress(CONTRIBUTOR), '583231+octocat@users.noreply.github.com')
})

test('a contributor with no display name is attributed by login rather than by "null"', () => {
  assert.equal(displayName(ANONYMOUS), 'nonamehere')
  assert.ok(!coAuthoredBy(ANONYMOUS).includes('null'))
})

test('Co-authored-by is the exact trailer GitHub reads', () => {
  assert.equal(coAuthoredBy(CONTRIBUTOR), 'Co-authored-by: Mona Lisa Octocat <583231+octocat@users.noreply.github.com>')
})

test('Signed-off-by is the exact trailer a DCO check reads', () => {
  assert.equal(signedOffBy(CONTRIBUTOR), 'Signed-off-by: Mona Lisa Octocat <583231+octocat@users.noreply.github.com>')
})

test('the sign-off caveat says out loud that the address is the noreply form', () => {
  assert.ok(SIGN_OFF_CAVEAT.includes('user:email'))
  assert.ok(SIGN_OFF_CAVEAT.includes('noreply'))
})

// ── The commit message ─────────────────────────────────────────────────────

test('a data commit carries the dedication AND both trailers, trailers last', () => {
  const msg = composeCommitMessage({
    subject: 'Mask: base1-4/15 — hand',
    detail: 'Agreement against the era rule: 0.8123.',
    contributor: CONTRIBUTOR,
    data: true,
  })
  assert.ok(msg.startsWith('Mask: base1-4/15 — hand\n\n'))
  assert.ok(msg.includes(CC0_DEDICATION))
  const lines = msg.trimEnd().split('\n')
  assert.equal(lines[lines.length - 2], signedOffBy(CONTRIBUTOR))
  assert.equal(lines[lines.length - 1], coAuthoredBy(CONTRIBUTOR))
})

test('a code-only commit signs off but does NOT dedicate — there is nothing to dedicate', () => {
  const msg = composeCommitMessage({ subject: 'Docs: fix a typo', contributor: CONTRIBUTOR, data: false })
  assert.ok(!msg.includes('CC0-Dedication'))
  assert.ok(msg.includes(signedOffBy(CONTRIBUTOR)))
  assert.ok(msg.includes(coAuthoredBy(CONTRIBUTOR)))
})

test('the commit message names the contributor and the site it came from', () => {
  const msg = composeCommitMessage({ subject: 'Canon: cosmos', contributor: CONTRIBUTOR, data: true })
  assert.ok(msg.includes('@octocat'))
  assert.ok(msg.includes('foilkit.deckpal.app'))
})

// ── Titles ─────────────────────────────────────────────────────────────────

test('a mask title names the card and, when known, its name', () => {
  assert.equal(prTitle({ kind: 'mask', cardId: 'base1-4', variantId: 15, cardName: 'Charizard' }), 'Mask: base1-4/15 — Charizard')
  assert.equal(prTitle({ kind: 'mask', cardId: 'base1-4', variantId: 15, cardName: null }), 'Mask: base1-4/15')
})

test('a canon title names the pattern', () => {
  assert.equal(prTitle({ kind: 'canon', patternId: 'cosmos' }), 'Canon: cosmos')
})

// ── The body ───────────────────────────────────────────────────────────────

const CHECKS = [
  { name: 'png-decodes', ok: true, detail: 'PNG decoded (7823 bytes).' },
  { name: 'canonical-raster', ok: true, detail: '504×704, the canonical raster.' },
]

function maskBody(over: Record<string, unknown> = {}) {
  return composePrBody({
    kind: 'mask',
    contributor: CONTRIBUTOR,
    cardId: 'base1-4',
    variantId: 15,
    cardName: 'Charizard',
    paths: ['data/foil-masks/base1-4/15.png', 'data/foil-masks/base1-4/15.json', 'data/foil-masks/base1-4/15.diff.png'],
    comment: 'The holo window is a couple of pixels short at the bottom on this print run.',
    checks: CHECKS,
    coverage: 0.2396,
    provisional: { agreement: 0.8123, addedPx: 4210, removedPx: 980, unchangedPx: 71000 },
    measured: { derivationMethod: 'hand', agreement: 0.8109, correctionAgreement: null },
    seed: {
      startedFrom: 'layout',
      parent: null,
      resolvedFrom: null,
      parentSha256: null,
      seededAt: '2026-09-05T10:00:00.000Z',
    },
    conflict: { kind: 'none', acknowledged: false, detail: '' },
    branch: 'contrib/octocat/base1-4-15-new',
    ...over,
  } as Parameters<typeof composePrBody>[0])
}

test('a data pull request body carries the dedication automatically', () => {
  const body = maskBody()
  assert.ok(body.includes(CC0_DEDICATION))
  assert.ok(body.includes('approving\nthis pull request *is* the contributor’s assent'))
})

test('a pull request touching no data says so instead of dedicating nothing', () => {
  const body = maskBody({ paths: ['docs/MASK-PIPELINE.md'] })
  assert.ok(!body.includes('CC0-Dedication'))
  assert.ok(body.includes('touches no data files'))
})

test('the contributor’s comment becomes the body’s lead, quoted', () => {
  const body = maskBody()
  assert.ok(body.includes('## What the contributor said'))
  assert.ok(body.includes('> The holo window is a couple of pixels short'))
})

test('an empty comment does not leave an empty heading behind', () => {
  assert.ok(!maskBody({ comment: '   ' }).includes('What the contributor said'))
})

test('the body carries the provisional AND the measured agreement, clearly distinguished', () => {
  const body = maskBody()
  assert.ok(body.includes('0.8123'), 'the provisional number')
  assert.ok(body.includes('0.8109'), 'the measured number')
  assert.ok(body.includes('provisional'))
  assert.ok(body.includes('measured'))
  assert.ok(
    body.includes('the client never labels a mask'),
    'the body must explain why there are two numbers, not just print both',
  )
})

test('the body carries the seed and the parent pin', () => {
  const body = maskBody({
    seed: {
      startedFrom: 'mask',
      parent: { cardId: 'base1-4', variantId: 15 },
      resolvedFrom: { cardId: 'base1-4', variantId: 15 },
      parentSha256: 'deadbeef'.repeat(8),
      seededAt: '2026-09-05T10:00:00.000Z',
    },
  })
  assert.ok(body.includes('`base1-4/15`'))
  assert.ok(body.includes('deadbeefdeadbeef'))
  assert.ok(body.includes('2026-09-05T10:00:00.000Z'))
})

test('a fresh session says fresh; a superseding one says supersede and why', () => {
  assert.ok(maskBody().includes('Conflict status: **fresh**'))
  const stale = maskBody({
    conflict: { kind: 'parent-changed', acknowledged: true, detail: 'Upstream changed while you were working.' },
  })
  assert.ok(stale.includes('Conflict status: **supersede**'))
  assert.ok(stale.includes('parent-changed'))
  assert.ok(stale.includes('> Upstream changed while you were working.'))
  assert.ok(stale.includes('**replaces**'))
})

test('the body lists every file the pull request writes', () => {
  const body = maskBody()
  for (const p of ['data/foil-masks/base1-4/15.png', 'data/foil-masks/base1-4/15.json', 'data/foil-masks/base1-4/15.diff.png']) {
    assert.ok(body.includes(`\`${p}\``), `missing ${p}`)
  }
  assert.ok(body.includes('green'), 'the diff legend belongs with the diff file')
  assert.ok(body.includes('red'))
})

test('the body names the branch and says re-submission is idempotent', () => {
  const body = maskBody()
  assert.ok(body.includes('contrib/octocat/base1-4-15-new'))
  assert.ok(body.includes('one session, one pull request'))
})

test('the validation section shows passes and failures with their own marks', () => {
  const body = maskBody({
    checks: [
      { name: 'a', ok: true, detail: 'this one passed.' },
      { name: 'b', ok: false, detail: 'this one did not.' },
    ],
  })
  assert.ok(body.includes('✅ this one passed.'))
  assert.ok(body.includes('❌ this one did not.'))
})

test('a canon body tabulates what moved and stamps the contract', () => {
  const body = composePrBody({
    kind: 'canon',
    contributor: CONTRIBUTOR,
    patternId: 'cosmos',
    paths: ['data/foil-canon/cosmos.json'],
    comment: 'The bubbles were too tight at the top edge.',
    note: 'Loosened the disc stagger.',
    checks: CHECKS,
    moved: [
      { key: 'uScale', from: 1.2, to: 1.35 },
      { key: 'uP0', from: null, to: 0.5 },
    ],
    contract: 2,
    seedContract: 2,
    conflict: { kind: 'none', acknowledged: false, detail: '' },
    branch: 'contrib/octocat/canon-cosmos-abc1234',
  })
  assert.ok(body.includes('| `uScale` | 1.2 | 1.35 |'))
  assert.ok(body.includes('| `uP0` | — | 0.5 | — |'))
  assert.ok(body.includes('full uniform snapshot'))
  assert.ok(body.includes('composite contract **2**'))
  assert.ok(body.includes('> Loosened the disc stagger.'))
})

test('a canon session seeded under an older contract is flagged loudly', () => {
  const body = composePrBody({
    kind: 'canon',
    contributor: CONTRIBUTOR,
    patternId: 'cosmos',
    paths: ['data/foil-canon/cosmos.json'],
    comment: '',
    note: '',
    checks: CHECKS,
    moved: [{ key: 'uScale', from: 1.2, to: 1.35 }],
    contract: 2,
    seedContract: 1,
    conflict: { kind: 'none', acknowledged: false, detail: '' },
    branch: 'contrib/octocat/canon-cosmos-abc1234',
  })
  assert.ok(body.includes('⚠️'))
  assert.ok(body.includes('contract **1**'))
  assert.ok(body.includes('the same numbers under a different law are a different rendering'.slice(0, 30)))
})

test('the body tells the reviewer where the render evidence will appear', () => {
  const body = maskBody()
  assert.ok(body.includes('pr-evidence'))
  assert.ok(body.includes('tilt sweep'))
  assert.ok(body.includes('compile gate'), 'the workflow is the compile gate; the body should say so')
})

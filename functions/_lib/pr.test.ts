// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// BRANCH → COMMIT → PULL REQUEST, against a GitHub that is a function argument.
//
// The four calls this module makes are the only place in the project that can
// write to a branch, and every one of them has a payload detail that is silently
// load-bearing:
//
//   * the commit is parented on `main`, not on the branch's own head — which is
//     what makes a re-submission a REPLACEMENT rather than a second commit,
//   * the ref update is `force: true`, which is correct here and would be a
//     catastrophe in `github.ts`,
//   * the first submission POSTs `refs` and a later one PATCHes `refs/heads/…`,
//     and getting that backwards is a 422 nobody can read,
//   * the pull request head is `owner:branch`, which is what makes the lookup
//     find the existing one instead of opening a second.
//
// So the assertions here are on the EXACT payloads, not on "it resolved".

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  canonBranchName,
  commitToBranch,
  findOpenPr,
  maskBranchName,
  openOrUpdatePr,
  PrError,
  readBranch,
  refSegment,
  seedShort,
  botAuthor,
} = await import('./pr.ts')

const REF = { owner: 'cheyras', repo: 'foilkit', branch: 'main' }

interface Recorded {
  method: string
  path: string
  body: unknown
}

/**
 * A GitHub made of a routing table.
 *
 * Keyed `METHOD path`; the value is either a body or a `{ status, body }`. An
 * unrouted call is a test failure rather than a 404, because a call this suite
 * did not anticipate is exactly the thing worth noticing.
 */
function fakeGithub(routes: Record<string, unknown>): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      const path = url.replace('https://api.github.com', '')
      const method = init?.method ?? 'GET'
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      calls.push({ method, path, body })
      const route = routes[`${method} ${path}`]
      if (route === undefined) {
        return new Response(JSON.stringify({ message: `unrouted ${method} ${path}` }), { status: 599 })
      }
      const r = route as { status?: number; body?: unknown }
      const status = typeof r === 'object' && r !== null && 'status' in r ? (r.status as number) : 200
      const payload = typeof r === 'object' && r !== null && 'body' in r ? r.body : route
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    },
  }
}

// ── Branch naming ──────────────────────────────────────────────────────────

test('a mask branch is contrib/<login>/<cardId>-<variantId>-<short>', () => {
  assert.equal(maskBranchName('octocat', 'base1-4', 15, 'deadbeef'.repeat(8)), 'contrib/octocat/base1-4-15-deadbee')
})

test('a canon branch is contrib/<login>/canon-<patternId>-<short>', () => {
  assert.equal(canonBranchName('octocat', 'cosmos', 'abc1234'.padEnd(64, '0')), 'contrib/octocat/canon-cosmos-abc1234')
})

test('a session with nothing upstream to seed from is discriminated as "new"', () => {
  assert.equal(seedShort(null), 'new')
  assert.equal(maskBranchName('octocat', 'base1-4', 15, null), 'contrib/octocat/base1-4-15-new')
})

test('THE IDEMPOTENCY PROPERTY: the same session always names the same branch', () => {
  // This is what makes re-submission update one pull request instead of opening
  // a second. The seed is immutable within a session (subtask 8), so the name
  // is a function of things that cannot move while the session is open.
  const sha = 'f'.repeat(64)
  assert.equal(maskBranchName('octocat', 'base1-4', 15, sha), maskBranchName('octocat', 'base1-4', 15, sha))
})

test('re-seeding onto different upstream bytes produces a DIFFERENT branch', () => {
  // Correct, and deliberate: take-theirs and re-trace are new work against a
  // new parent, and folding them into the previous pull request would rewrite a
  // review that was about something else.
  assert.notEqual(maskBranchName('octocat', 'base1-4', 15, 'a'.repeat(64)), maskBranchName('octocat', 'base1-4', 15, 'b'.repeat(64)))
})

test('a ref segment cannot climb out of the namespace or start with a dot', () => {
  assert.equal(refSegment('../../main'), 'main')
  assert.equal(refSegment('.hidden'), 'hidden')
  assert.equal(refSegment('a b/c'), 'a-b-c')
  assert.equal(refSegment(''), 'x')
  assert.ok(!refSegment('x'.repeat(200)).includes('/'))
  assert.ok(refSegment('x'.repeat(200)).length <= 60)
})

test('the bot author line uses GitHub’s own [bot] convention', () => {
  assert.deepEqual(botAuthor('foilkit-contribute', '12345'), {
    name: 'foilkit-contribute[bot]',
    email: '12345+foilkit-contribute[bot]@users.noreply.github.com',
  })
})

// ── readBranch ─────────────────────────────────────────────────────────────

test('a first submission sees no branch head and does not treat that as an error', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/git/ref/heads/main': { object: { sha: 'BASE' } },
    'GET /repos/cheyras/foilkit/git/ref/heads/contrib/octocat/base1-4-15-new': { status: 404, body: { message: 'Not Found' } },
  })
  const state = await readBranch(REF, 'contrib/octocat/base1-4-15-new', 'ghs_x', { fetch: gh.fetch })
  assert.deepEqual(state, { headSha: null, baseSha: 'BASE' })
})

test('a re-submission sees the branch head', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/git/ref/heads/main': { object: { sha: 'BASE2' } },
    'GET /repos/cheyras/foilkit/git/ref/heads/contrib/octocat/base1-4-15-new': { object: { sha: 'OLDHEAD' } },
  })
  const state = await readBranch(REF, 'contrib/octocat/base1-4-15-new', 'ghs_x', { fetch: gh.fetch })
  assert.deepEqual(state, { headSha: 'OLDHEAD', baseSha: 'BASE2' })
})

test('a 500 while reading the branch is NOT swallowed as "no branch"', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/git/ref/heads/main': { object: { sha: 'BASE' } },
    'GET /repos/cheyras/foilkit/git/ref/heads/b': { status: 500, body: { message: 'boom' } },
  })
  await assert.rejects(() => readBranch(REF, 'b', 'ghs_x', { fetch: gh.fetch }), PrError)
})

// ── commitToBranch ─────────────────────────────────────────────────────────

const CHANGES = [
  { path: 'data/foil-masks/base1-4/15.png', content: Buffer.from([1, 2, 3]) },
  { path: 'data/foil-masks/base1-4/15.json', content: Buffer.from('{"a":1}', 'utf8') },
]

function commitRoutes(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'GET /repos/cheyras/foilkit/git/commits/BASE': { tree: { sha: 'BASETREE' } },
    'POST /repos/cheyras/foilkit/git/blobs': { sha: 'BLOB' },
    'POST /repos/cheyras/foilkit/git/trees': { sha: 'NEWTREE' },
    'POST /repos/cheyras/foilkit/git/commits': { sha: 'NEWCOMMIT' },
    ...extra,
  }
}

test('a first submission creates the ref with POST /git/refs, and the payload is exact', async () => {
  const gh = fakeGithub(commitRoutes({ 'POST /repos/cheyras/foilkit/git/refs': {} }))
  const out = await commitToBranch(
    REF,
    {
      branch: 'contrib/octocat/base1-4-15-new',
      baseSha: 'BASE',
      changes: CHANGES,
      message: 'Mask: base1-4/15',
      author: { name: 'foilkit-contribute[bot]', email: 'bot@users.noreply.github.com' },
      branchExists: false,
    },
    'ghs_x',
    { fetch: gh.fetch },
  )
  assert.deepEqual(out, { commitSha: 'NEWCOMMIT', treeSha: 'NEWTREE' })

  const refCall = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/refs')!
  assert.equal(refCall.method, 'POST')
  assert.deepEqual(refCall.body, { ref: 'refs/heads/contrib/octocat/base1-4-15-new', sha: 'NEWCOMMIT' })
})

test('every blob is uploaded base64 — a PNG and a JSON go up the same way', async () => {
  const gh = fakeGithub(commitRoutes({ 'POST /repos/cheyras/foilkit/git/refs': {} }))
  await commitToBranch(
    REF,
    { branch: 'b', baseSha: 'BASE', changes: CHANGES, message: 'm', author: { name: 'n', email: 'e' }, branchExists: false },
    'ghs_x',
    { fetch: gh.fetch },
  )
  const blobs = gh.calls.filter((c) => c.path === '/repos/cheyras/foilkit/git/blobs')
  assert.equal(blobs.length, 2)
  assert.deepEqual(blobs[0]!.body, { content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' })
  assert.deepEqual(blobs[1]!.body, { content: Buffer.from('{"a":1}').toString('base64'), encoding: 'base64' })
})

test('THE COMMIT IS PARENTED ON MAIN, not on the branch head', async () => {
  // The property that makes a pull request one commit with one diff however
  // many times the contributor pressed Submit. If this ever regresses, a
  // re-submission stacks commits and the review restarts.
  const gh = fakeGithub(commitRoutes({ 'PATCH /repos/cheyras/foilkit/git/refs/heads/b': {} }))
  await commitToBranch(
    REF,
    { branch: 'b', baseSha: 'BASE', changes: CHANGES, message: 'm', author: { name: 'n', email: 'e' }, branchExists: true },
    'ghs_x',
    { fetch: gh.fetch },
  )
  const commit = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/commits' && c.method === 'POST')!
  assert.deepEqual((commit.body as { parents: string[] }).parents, ['BASE'])
  const tree = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/trees')!
  assert.equal((tree.body as { base_tree: string }).base_tree, 'BASETREE')
})

test('a re-submission force-updates its OWN branch — and only ever its own', async () => {
  const gh = fakeGithub(commitRoutes({ 'PATCH /repos/cheyras/foilkit/git/refs/heads/contrib/octocat/x': {} }))
  await commitToBranch(
    REF,
    {
      branch: 'contrib/octocat/x',
      baseSha: 'BASE',
      changes: CHANGES,
      message: 'm',
      author: { name: 'n', email: 'e' },
      branchExists: true,
    },
    'ghs_x',
    { fetch: gh.fetch },
  )
  const patch = gh.calls.find((c) => c.method === 'PATCH')!
  assert.equal(patch.path, '/repos/cheyras/foilkit/git/refs/heads/contrib/octocat/x')
  assert.deepEqual(patch.body, { sha: 'NEWCOMMIT', force: true })
  assert.ok(
    !gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/heads/main')),
    'nothing here may ever touch main',
  )
})

test('the commit message and author reach GitHub verbatim', async () => {
  const gh = fakeGithub(commitRoutes({ 'POST /repos/cheyras/foilkit/git/refs': {} }))
  const message = 'Mask: base1-4/15 — hand\n\nSigned-off-by: Mona <1+mona@users.noreply.github.com>\n'
  const author = { name: 'foilkit-contribute[bot]', email: '1+foilkit-contribute[bot]@users.noreply.github.com' }
  await commitToBranch(
    REF,
    { branch: 'b', baseSha: 'BASE', changes: CHANGES, message, author, branchExists: false },
    'ghs_x',
    { fetch: gh.fetch },
  )
  const commit = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/commits')!
  assert.equal((commit.body as { message: string }).message, message)
  assert.deepEqual((commit.body as { author: unknown }).author, author)
})

test('a deletion becomes a null-sha tree entry', async () => {
  const gh = fakeGithub(commitRoutes({ 'POST /repos/cheyras/foilkit/git/refs': {} }))
  await commitToBranch(
    REF,
    {
      branch: 'b',
      baseSha: 'BASE',
      changes: [{ path: 'data/foil-canon/gone.json', content: null }],
      message: 'm',
      author: { name: 'n', email: 'e' },
      branchExists: false,
    },
    'ghs_x',
    { fetch: gh.fetch },
  )
  const tree = gh.calls.find((c) => c.path === '/repos/cheyras/foilkit/git/trees')!
  assert.deepEqual((tree.body as { tree: unknown[] }).tree, [
    { path: 'data/foil-canon/gone.json', mode: '100644', type: 'blob', sha: null },
  ])
})

test('an empty change set is refused rather than committed as nothing', async () => {
  const gh = fakeGithub({})
  await assert.rejects(
    () =>
      commitToBranch(
        REF,
        { branch: 'b', baseSha: 'BASE', changes: [], message: 'm', author: { name: 'n', email: 'e' }, branchExists: false },
        'ghs_x',
        { fetch: gh.fetch },
      ),
    /nothing to commit/,
  )
  assert.equal(gh.calls.length, 0, 'it must not have talked to GitHub at all')
})

test('the installation token is what authorises every call — never a fallback', async () => {
  const gh = fakeGithub(commitRoutes({ 'POST /repos/cheyras/foilkit/git/refs': {} }))
  const seen: string[] = []
  const wrapped = async (url: string, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string>).authorization!)
    return gh.fetch(url, init)
  }
  await commitToBranch(
    REF,
    { branch: 'b', baseSha: 'BASE', changes: CHANGES, message: 'm', author: { name: 'n', email: 'e' }, branchExists: false },
    'ghs_installation_token',
    { fetch: wrapped },
  )
  assert.ok(seen.length > 0)
  for (const h of seen) assert.equal(h, 'Bearer ghs_installation_token')
})

// ── openOrUpdatePr ─────────────────────────────────────────────────────────

test('the open-PR lookup is scoped to owner:branch, which is what finds ONE', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/pulls?state=open&head=cheyras%3Acontrib%2Foctocat%2Fx': [],
  })
  assert.equal(await findOpenPr(REF, 'contrib/octocat/x', 'ghs_x', { fetch: gh.fetch }), null)
  assert.ok(gh.calls[0]!.path.includes('head=cheyras%3Acontrib%2Foctocat%2Fx'))
})

test('a first submission opens the pull request with head, base and the composed body', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/pulls?state=open&head=cheyras%3Acontrib%2Foctocat%2Fx': [],
    'POST /repos/cheyras/foilkit/pulls': { number: 42, html_url: 'https://github.com/cheyras/foilkit/pull/42' },
  })
  const pr = await openOrUpdatePr(
    REF,
    { branch: 'contrib/octocat/x', title: 'Mask: base1-4/15', body: 'BODY' },
    'ghs_x',
    { fetch: gh.fetch },
  )
  assert.deepEqual(pr, { number: 42, htmlUrl: 'https://github.com/cheyras/foilkit/pull/42', updated: false })
  const post = gh.calls.find((c) => c.method === 'POST')!
  assert.deepEqual(post.body, {
    title: 'Mask: base1-4/15',
    body: 'BODY',
    head: 'contrib/octocat/x',
    base: 'main',
    maintainer_can_modify: true,
  })
})

test('a re-submission PATCHES the existing pull request — one session, one PR', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/pulls?state=open&head=cheyras%3Acontrib%2Foctocat%2Fx': [
      { number: 42, html_url: 'https://github.com/cheyras/foilkit/pull/42' },
    ],
    'PATCH /repos/cheyras/foilkit/pulls/42': {},
  })
  const pr = await openOrUpdatePr(
    REF,
    { branch: 'contrib/octocat/x', title: 'Mask: base1-4/15', body: 'NEW BODY' },
    'ghs_x',
    { fetch: gh.fetch },
  )
  assert.equal(pr.updated, true)
  assert.equal(pr.number, 42)
  assert.ok(!gh.calls.some((c) => c.method === 'POST'), 'a second pull request must never be opened')
  const patch = gh.calls.find((c) => c.method === 'PATCH')!
  // REWRITTEN, not appended. The body describes the current state of the
  // branch; leaving the previous submission's numbers above the new ones is
  // exactly the stale-but-plausible text a reviewer reads and believes.
  assert.deepEqual(patch.body, { title: 'Mask: base1-4/15', body: 'NEW BODY' })
})

test('a GitHub error carries its status through rather than becoming a generic 500', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/pulls?state=open&head=cheyras%3Ab': { status: 403, body: { message: 'Resource not accessible by integration' } },
  })
  await assert.rejects(
    () => openOrUpdatePr(REF, { branch: 'b', title: 't', body: 'b' }, 'ghs_x', { fetch: gh.fetch }),
    (err: unknown) => {
      assert.ok(err instanceof PrError)
      assert.equal((err as { status: number }).status, 403)
      assert.ok((err as Error).message.includes('not accessible by integration'))
      return true
    },
  )
})

// ── The whole sequence ─────────────────────────────────────────────────────

test('E2E, mocked: branch → commit → pull request, in that order, with no stray calls', async () => {
  const gh = fakeGithub({
    'GET /repos/cheyras/foilkit/git/ref/heads/main': { object: { sha: 'BASE' } },
    'GET /repos/cheyras/foilkit/git/ref/heads/contrib/octocat/base1-4-15-new': { status: 404, body: {} },
    'GET /repos/cheyras/foilkit/git/commits/BASE': { tree: { sha: 'BASETREE' } },
    'POST /repos/cheyras/foilkit/git/blobs': { sha: 'BLOB' },
    'POST /repos/cheyras/foilkit/git/trees': { sha: 'NEWTREE' },
    'POST /repos/cheyras/foilkit/git/commits': { sha: 'NEWCOMMIT' },
    'POST /repos/cheyras/foilkit/git/refs': {},
    'GET /repos/cheyras/foilkit/pulls?state=open&head=cheyras%3Acontrib%2Foctocat%2Fbase1-4-15-new': [],
    'POST /repos/cheyras/foilkit/pulls': { number: 7, html_url: 'https://github.com/cheyras/foilkit/pull/7' },
  })
  const branch = maskBranchName('octocat', 'base1-4', 15, null)
  const state = await readBranch(REF, branch, 'ghs_x', { fetch: gh.fetch })
  await commitToBranch(
    REF,
    {
      branch,
      baseSha: state.baseSha,
      changes: CHANGES,
      message: 'Mask: base1-4/15',
      author: botAuthor('foilkit-contribute', '1'),
      branchExists: state.headSha !== null,
    },
    'ghs_x',
    { fetch: gh.fetch },
  )
  const pr = await openOrUpdatePr(REF, { branch, title: 'Mask: base1-4/15', body: 'BODY' }, 'ghs_x', { fetch: gh.fetch })

  assert.equal(pr.htmlUrl, 'https://github.com/cheyras/foilkit/pull/7')
  assert.deepEqual(
    gh.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`),
    [
      'GET /repos/cheyras/foilkit/git/ref/heads/main',
      'GET /repos/cheyras/foilkit/git/ref/heads/contrib/octocat/base1-4-15-new',
      'GET /repos/cheyras/foilkit/git/commits/BASE',
      'POST /repos/cheyras/foilkit/git/blobs',
      'POST /repos/cheyras/foilkit/git/blobs',
      'POST /repos/cheyras/foilkit/git/trees',
      'POST /repos/cheyras/foilkit/git/commits',
      'POST /repos/cheyras/foilkit/git/refs',
      'GET /repos/cheyras/foilkit/pulls',
      'POST /repos/cheyras/foilkit/pulls',
    ],
  )
})

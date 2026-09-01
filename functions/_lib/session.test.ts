// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The identity layer's invariants.
//
// This is the smallest security-relevant surface in the project, which is
// exactly why it gets tests rather than a careful reading: the cookie decides
// who may commit to the repository, and every failure here is silent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.FOILKIT_SESSION_SECRET ??= 'test-secret-that-is-at-least-32-characters-long'

const {
  COOKIE_NAME,
  clearCookie,
  readCookie,
  safeReturnPath,
  sessionCookie,
  signSession,
  verifySession,
  MissingSecret,
} = await import('./session.ts')
const { isWriter, WRITERS } = await import('./writers.ts')
const { assertCardId, assertVariantId, assertPatternId, pngFromDataUrl, BadRequest } = await import('./corpus.ts')

const CLAIMS = {
  login: 'cheyras',
  id: 4242,
  name: 'Chey Rasmussen',
  avatarUrl: 'https://example.invalid/a.png',
  exp: Math.floor(Date.now() / 1000) + 3600,
}

test('a signed session round-trips', () => {
  const token = signSession(CLAIMS)
  assert.deepEqual(verifySession(token), CLAIMS)
})

test('a browser cannot rewrite its own login', () => {
  const token = signSession({ ...CLAIMS, login: 'somebody-else' })
  const [body, mac] = token.split('.') as [string, string]
  // Re-encode the payload with a different login, keep the old signature.
  const forged =
    Buffer.from(JSON.stringify({ ...CLAIMS, login: 'cheyras' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') + `.${mac}`
  assert.equal(verifySession(forged), null)
  // And the unforged one still verifies, so the guard is not just rejecting all.
  assert.equal(verifySession(`${body}.${mac}`)?.login, 'somebody-else')
})

test('every failure mode is indistinguishable from signed out', () => {
  assert.equal(verifySession(null), null)
  assert.equal(verifySession(''), null)
  assert.equal(verifySession('no-dot'), null)
  assert.equal(verifySession('.onlymac'), null)
  assert.equal(verifySession('notbase64.notamac'), null)
  // Expired.
  assert.equal(verifySession(signSession({ ...CLAIMS, exp: Math.floor(Date.now() / 1000) - 1 })), null)
  // Missing the numeric id the commit author line needs.
  const noId = signSession({ ...CLAIMS, id: undefined as unknown as number })
  assert.equal(verifySession(noId), null)
})

test('a missing signing secret fails loudly rather than degrading', () => {
  const saved = process.env.FOILKIT_SESSION_SECRET
  process.env.FOILKIT_SESSION_SECRET = 'too-short'
  try {
    assert.throws(() => signSession(CLAIMS), MissingSecret)
  } finally {
    process.env.FOILKIT_SESSION_SECRET = saved
  }
})

test('the cookie is HttpOnly, Secure and SameSite=Lax — and Lax is deliberate', () => {
  const c = sessionCookie('abc')
  assert.match(c, /HttpOnly/)
  assert.match(c, /Secure/)
  // Strict would drop the cookie on the top-level navigation back from
  // github.com, which is the one hop the whole flow depends on.
  assert.match(c, /SameSite=Lax/)
  assert.match(clearCookie(), /Max-Age=0/)
  assert.equal(readCookie(`other=1; ${COOKIE_NAME}=xyz; more=2`, COOKIE_NAME), 'xyz')
  assert.equal(readCookie('other=1', COOKIE_NAME), null)
  assert.equal(readCookie(undefined, COOKIE_NAME), null)
})

test('the return path cannot become an open redirect', () => {
  assert.equal(safeReturnPath('/card?id=base1-4'), '/card?id=base1-4')
  assert.equal(safeReturnPath('//evil.example.com'), '/')
  assert.equal(safeReturnPath('https://evil.example.com'), '/')
  assert.equal(safeReturnPath('/\\evil.example.com'), '/')
  assert.equal(safeReturnPath('/ok\r\nSet-Cookie: x=1'), '/')
  assert.equal(safeReturnPath(null), '/')
  assert.equal(safeReturnPath(''), '/')
})

test('the writer capability is a list, matched case-insensitively', () => {
  assert.ok(isWriter('cheyras'))
  assert.ok(isWriter('CheyRas'))
  assert.ok(!isWriter('cheyras2'))
  assert.ok(!isWriter(''))
  assert.ok(!isWriter(null))
  assert.ok(Array.isArray(WRITERS))
})

test('THE TWO WRITER LISTS AGREE — the server check and what the UI offers', () => {
  // A duplicated list that silently diverges is the worst of both worlds: a UI
  // that offers a save the server refuses, or one that hides a save it would
  // have allowed. So the editor's copy is read as source and compared.
  const here = dirname(fileURLToPath(import.meta.url))
  const editor = readFileSync(join(here, '..', '..', 'apps', 'editor', 'src', 'writer', 'capability.ts'), 'utf8')
  const m = /export const WRITERS: readonly string\[\] = \[([^\]]*)\]/.exec(editor)
  assert.ok(m, "could not find WRITERS in the editor's capability.ts")
  const editorList = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.deepEqual(editorList, [...WRITERS], 'the editor and the server disagree about who may write')
})

test('a card id is a path segment, and anything else is refused', () => {
  assert.equal(assertCardId('base1-4'), 'base1-4')
  assert.equal(assertCardId('sv03.5-1'), 'sv03.5-1')
  for (const bad of ['../etc/passwd', 'a/b', '..', '', 'a'.repeat(200), '-leading', null, 42]) {
    assert.throws(() => assertCardId(bad), BadRequest, `accepted ${JSON.stringify(bad)}`)
  }
  assert.equal(assertVariantId('37184'), 37184)
  assert.equal(assertVariantId(1), 1)
  for (const bad of [-1, 1.5, 'x', null]) assert.throws(() => assertVariantId(bad), BadRequest)
  assert.equal(assertPatternId('cosmos-ii-pixel'), 'cosmos-ii-pixel')
  for (const bad of ['Cosmos', '../x', 'a b']) assert.throws(() => assertPatternId(bad), BadRequest)
})

test('a mask upload must actually be a PNG, and a bounded one', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ])
  const url = `data:image/png;base64,${png.toString('base64')}`
  assert.equal(pngFromDataUrl(url).length, png.length)
  // A JPEG renamed in the data URL header is still not a PNG.
  const jpeg = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`
  assert.throws(() => pngFromDataUrl(jpeg), BadRequest)
  assert.throws(() => pngFromDataUrl('https://evil.invalid/x.png'), BadRequest)
  assert.throws(() => pngFromDataUrl('data:image/png;base64,'), BadRequest)
  assert.throws(() => pngFromDataUrl(url, 4), BadRequest)
})

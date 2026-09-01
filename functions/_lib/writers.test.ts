// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// THE TWO WRITER LISTS AGREE.
//
// `functions/_lib/writers.ts` and `apps/editor/src/writer/capability.ts` both
// carry the list of GitHub logins holding the writer capability, and both of
// them cite THIS FILE as the thing that keeps them in step. For a while this
// file did not exist — the checks lived in `session.test.ts` and the citations
// pointed at nothing, which is the sort of gap that looks fine right up until
// somebody grants the second writer, edits one list, greps for the named test
// to run it, and finds no such file.
//
// WHY THE LIST IS DUPLICATED AT ALL. The server copy is the security boundary:
// every write endpoint re-derives the answer from the GitHub login inside a
// signed session cookie the browser cannot forge. The client copy is not a
// boundary and must never be treated as one — anybody can edit their own
// JavaScript — it only decides which affordances the UI puts on screen. Two
// consumers with genuinely different jobs, and importing the server module into
// a browser bundle would ship `node:` builtins to a visitor.
//
// So they are duplicated deliberately and reconciled mechanically. Divergence
// is the worst of both worlds in either direction: a UI that offers a save the
// server refuses, or — worse, because it is invisible — one that hides a save
// the server would have allowed.
//
// The editor's copy is read as SOURCE TEXT rather than imported. That file is
// TSX-adjacent front-end code whose import graph is free to grow a React or
// Vite dependency at any time, and a parity test that starts failing because
// the editor imported something is a test people delete.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { isWriter, WRITERS } from './writers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', '..', 'apps', 'editor', 'src', 'writer', 'capability.ts')

/** The `WRITERS` array as the editor's source declares it. */
function clientWriters(): string[] {
  const source = readFileSync(CLIENT, 'utf8')
  const m = /export const WRITERS: readonly string\[\] = \[([^\]]*)\]/.exec(source)
  assert.ok(m, `could not find a WRITERS declaration in ${CLIENT}`)
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

test('the server and the editor hold the same writer list, in the same order', () => {
  assert.deepEqual(
    clientWriters(),
    [...WRITERS],
    'apps/editor/src/writer/capability.ts and functions/_lib/writers.ts disagree about who may write',
  )
})

test('the list is non-empty and every entry is a plausible GitHub login', () => {
  // An empty list is not "locked down": it is a deploy on which nobody can
  // write and the UI says so to the one person who can, which reads as an
  // outage. If the capability is ever genuinely withdrawn, that is a decision
  // to write down rather than an array to silently empty.
  assert.ok(WRITERS.length > 0, 'the writer list is empty')
  for (const login of WRITERS) {
    assert.match(login, /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/, `not a GitHub login: ${login}`)
  }
})

test('both implementations of isWriter answer identically, case-insensitively', () => {
  // Not just "the arrays match" — the two `isWriter` functions are duplicated
  // too, and a list that agrees while the matching rule does not would let the
  // UI and the server disagree about `CheyRas` while this file said they were
  // in step.
  const client = clientWriters()
  const clientIsWriter = (login: string | null): boolean =>
    typeof login === 'string' && login.length > 0 && client.some((w) => w.toLowerCase() === login.toLowerCase())

  const probes = [
    ...WRITERS,
    ...WRITERS.map((w) => w.toUpperCase()),
    ...WRITERS.map((w) => `${w}2`),
    'nobody',
    '',
  ]
  for (const p of probes) {
    assert.equal(isWriter(p), clientIsWriter(p), `the two isWriter implementations disagree about '${p}'`)
  }
  // The null/undefined cases the server sees when no cookie was presented.
  assert.equal(isWriter(null), false)
  assert.equal(isWriter(undefined), false)
})

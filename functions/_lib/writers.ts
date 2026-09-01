// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The writer capability, SERVER SIDE. This is the check that matters.
//
// `apps/editor/src/writer/capability.ts` carries the same list and decides what
// the UI offers. It is not a security boundary — anybody can edit their own
// JavaScript — so every write endpoint re-derives the answer here, from the
// GitHub login inside a signed session cookie the browser cannot forge.
//
// The two lists are kept in step by `functions/_lib/writers.test.ts`, which reads the
// editor's source and compares. A duplicated list that silently diverges would
// be the worst of both worlds: a UI that offers a save the server refuses, or
// worse, one that hides a save the server would have allowed.

/**
 * GitHub usernames holding the writer capability. Case-insensitive.
 *
 * A LIST, not an `isOwner` boolean, even with one entry: granting the second
 * person costs a config line instead of a refactor, and this is the seam #10's
 * owner-verified provenance tier hangs off.
 */
export const WRITERS: readonly string[] = ['cheyras']

export function isWriter(login: string | null | undefined): boolean {
  if (typeof login !== 'string' || login.length === 0) return false
  const l = login.toLowerCase()
  return WRITERS.some((w) => w.toLowerCase() === l)
}

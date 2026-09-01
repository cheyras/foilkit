// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The writer capability.
//
// Chey is the overwhelming majority of authoring volume, and #10 puts him on
// the REVIEW side of every contribution. Routing his own work through
// submit-and-review would put a queue between him and his own repository for no
// gain. So there is a capability, checked at the point of save: a holder writes
// through the PUT path and the staging layer never engages; everyone else
// stages.
//
// A LIST, NOT AN `isOwner` BOOLEAN, even though the list has one entry today.
// Granting the second person then costs a config line instead of a refactor.
// It is also the seam #10's owner-verified provenance tier hangs off — the same
// distinction, one use at write time and one at weight time — and a boolean
// cannot carry that.
//
// ── WHERE THE REAL CHECK LIVES ─────────────────────────────────────────────
//
// This module is CLIENT-SIDE and decides only what the UI offers. It is not a
// security boundary and must never be treated as one: anybody can edit their
// own JavaScript. `functions/mask.ts` re-derives the same answer from the verified
// GitHub identity in the session cookie before it writes anything, and that is
// the check that matters. Both read the same list so they cannot disagree.

/**
 * GitHub usernames holding the writer capability. Case-insensitive.
 *
 * One entry today, by decision (2026-08-31): "Only Chey is approved for now."
 */
export const WRITERS: readonly string[] = ['cheyras']

/** Does this GitHub login hold the writer capability? */
export function isWriter(login: string | null | undefined): boolean {
  if (typeof login !== 'string' || login.length === 0) return false
  const l = login.toLowerCase()
  return WRITERS.some((w) => w.toLowerCase() === l)
}

/** The signed-in identity, as the editor knows it. Null when signed out. */
export interface Viewer {
  login: string
  name: string | null
  avatarUrl: string | null
  /** Server's answer, not this file's. The client re-checks only to fail early. */
  writer: boolean
}

/**
 * What the editor will do when this viewer presses Save.
 *
 * Deliberately three values rather than a boolean, because "stage it" is not a
 * degraded version of "write it" — it is the normal path for everyone who is
 * not on the list, and the UI should say so in those words rather than
 * apologising for a missing permission.
 */
export type SavePath =
  /** Signed in, on the list: one PUT, straight to the repository. */
  | 'direct-write'
  /** Anyone else, signed in or not: staged locally, submitted later. */
  | 'stage'

export function savePathFor(viewer: Viewer | null): SavePath {
  return viewer !== null && viewer.writer ? 'direct-write' : 'stage'
}

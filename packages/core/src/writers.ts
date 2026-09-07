// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// WHO HOLDS THE WRITER CAPABILITY — the list, in the one package everything can
// import.
//
// It used to live only in `functions/_lib/writers.ts` (the security boundary)
// with a hand-kept copy in `apps/editor/src/writer/capability.ts` (the UI). Two
// consumers, two genuinely different jobs, reconciled by `writers.test.ts`.
//
// #10 adds a THIRD consumer with a third job, and it is the one that made this
// file necessary: `@foilkit/forge` has to decide, WHEN READING A SIDECAR OFF
// DISK, whether a `verification` block in it may be honoured. The rule is that a
// verification is honoured only when its `verifiedBy` holds the writer
// capability — the same capability the write route enforces — so a `verification`
// block hand-committed by a stranger cannot grant their own mask full exemplar
// weight. That check has to run inside forge, in a CLI with no HTTP request
// anywhere near it, so the list cannot live in `functions/`.
//
// `@foilkit/core` is where it goes because core is the one package with zero
// dependencies and no `node:` builtins, which means the server, the CLI and the
// browser can all read it without any of them pulling in the others.
//
// THE LIST IS NOT A SECRET AND IS NOT A BOUNDARY BY ITSELF. It ships in the
// browser bundle and always has. What makes it a boundary is WHERE it is
// checked: `functions/mask.ts` and `functions/canon.ts` check it against the
// GitHub login inside a signed session cookie a browser cannot forge. The
// editor's copy only decides which buttons exist; forge's use only decides
// whether a claim already committed to the repository is believed.

/**
 * GitHub usernames holding the writer capability. Case-insensitive.
 *
 * A LIST, not an `isOwner` boolean, even with one entry: granting the second
 * person costs a config line instead of a refactor, and this is the seam the
 * owner-verified provenance tier hangs off.
 *
 * One entry today, by decision (2026-08-31): "Only Chey is approved for now."
 */
export const WRITERS: readonly string[] = ['cheyras']

export function isWriter(login: string | null | undefined): boolean {
  if (typeof login !== 'string' || login.length === 0) return false
  const l = login.toLowerCase()
  return WRITERS.some((w) => w.toLowerCase() === l)
}

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
//
// ── WHY THIS IS NOW A RE-EXPORT (#10) ──────────────────────────────────────
//
// The array itself moved to `@foilkit/core`. A third consumer appeared and it
// could not import this module: `@foilkit/forge` has to decide, when reading a
// sidecar off disk, whether a committed `verification` block may be honoured,
// and the rule is that it is honoured only when its `verifiedBy` holds this
// capability. That check runs in a CLI with no HTTP request in sight, so the
// list had to live somewhere both a function and a `node` script can reach.
//
// Nothing about the boundary changed. This module is still where every write
// endpoint asks the question, and `isWriter` is still answered against a login
// that came out of a signed cookie rather than out of a request body.

export { WRITERS, isWriter } from '@foilkit/core'

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// tools/bake/guards.ts — docs/HOSTED-EDITOR.md §6 ("Never in an artifact"),
// enforced structurally rather than by review.
//
// The bake selects the columns it emits, which is the FIRST line of defence:
// a field nobody selected cannot leak. This module is the second. It exists
// because the first one is a property of code somebody could change, and the
// files it protects are public files on a CDN — a leak here is not a bug you
// fix in the next deploy, it is a byte somebody already downloaded.
//
// Shared by tools/bake-catalog.mts, tools/bake-fixture.mts and the tests, on
// purpose: a guard the fixture path skips is a guard the tests never exercise
// against the shape the real bake produces.

/**
 * Keys that may never appear in a baked artifact, at any depth.
 *
 * Matched case-insensitively against the whole key, so `owned` is caught and
 * `ownedByArtist` is not. Deliberate: this is a list of the exact field names
 * DeckPal's user-scoped tables use, not a substring dragnet that would false-
 * positive on innocent catalog fields forever after.
 */
export const FORBIDDEN_KEY =
  /^(owned|ownedOnly|ownership|quantity|totalQuantity|progress|userId|user_id|collection|have)$/i

/**
 * Walk `obj` and throw on the first forbidden key. `where` names the artifact
 * so the failure says which file was about to be written, and the thrown path
 * says where in it — a bake that fails must tell the maintainer enough to fix
 * the query without re-running against the database to find out.
 *
 * Cycles are tracked because an assembled catalog model is built by reference
 * (a set shard's `set` header is the same object the series list holds) and a
 * naive walk would recurse forever on the day somebody adds a back-pointer.
 */
export function assertNoUserScopedFields(obj: unknown, where: string): void {
  const seen = new WeakSet<object>()
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return
    if (seen.has(node as object)) return
    seen.add(node as object)
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`)
      return
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) {
        throw new Error(
          `${where}: user-scoped field '${k}' at ${path === '' ? '<root>' : path}.${k} — ` +
            `docs/HOSTED-EDITOR.md §6 forbids ownership, quantities, progress and user ids in a baked artifact. ` +
            `These are public files on a CDN; fix the query, do not widen the guard.`,
        )
      }
      walk(v, path === '' ? k : `${path}.${k}`)
    }
  }
  walk(obj, '')
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Canon: the pattern's own truth, per pattern, global.
//
// A canon file is a FULL uniform snapshot rather than a delta, and that is the
// property everything here follows from. It means a save replaces the file
// wholesale (there is nothing to merge), it means two files differing only in
// key order are the same canon (hence the sorted serialisation below), and it
// means a canon edit cannot ride a card-keyed session — which is why the
// staging layer gives it a second session type keyed by `patternId`.
//
// THE CONTRACT STAMP is carried through untouched. A canon file names the
// `main()` it was tuned against; a file tuned at one contract is a different
// rendering from the same file at another, and that has to stay legible rather
// than silent. This endpoint never invents one — it preserves what the file
// had, or takes what the client sends, and does not guess.
//
// THE FILE IS COMPOSED IN `_lib/canon-entry.ts`, not here. `functions/contribute.ts`
// writes canon files too, through a pull request, and two composers would grow
// two dialects of the same file. Sharing one is also what fixed two fields this
// endpoint used to drop on every rewrite: `tunedUnderContract`, which
// `tools/parity/data-receipt.mjs` fails without, and `frozen`, which is a human
// decision a machine may not roll back (AGENTS.md F4).

import {
  headerValue,
  queryValue,
  readJsonBody,
  sendPrivateError,
  sendPrivateJson,
  type FnRequest,
  type FnResponse,
} from './_lib/http.ts'
import { COOKIE_NAME, readCookie, verifySession, type SessionClaims } from './_lib/session.ts'
import { refuseIfUnconfigured, writeConfig } from './_lib/config.ts'
import { isWriter } from './_lib/writers.ts'
import { assertPatternId, BadRequest, CANON_PREFIX } from './_lib/corpus.ts'
import { commitChanges, noreplyAuthor, readFileAt, repoRef } from './_lib/github.ts'
import {
  composeCanonEntry,
  normalizeUniforms,
  parseExisting,
  sameCanon,
  serializeCanonEntry,
} from './_lib/canon-entry.ts'
import { canonicalPatternId, patternById } from '@foilkit/patterns'

function requireWriter(req: FnRequest, res: FnResponse): SessionClaims | null {
  // Configuration BEFORE identity. A deployment with no GitHub token cannot
  // write no matter who is asking, and telling a signed-out visitor to sign in
  // first would send them round a loop that ends in the same refusal.
  if (refuseIfUnconfigured(res, writeConfig())) return null
  const claims = verifySession(readCookie(headerValue(req, 'cookie') ?? undefined, COOKIE_NAME))
  if (claims === null) {
    sendPrivateError(res, 401, 'sign_in_required', 'a direct write needs a signed-in writer')
    return null
  }
  if (!isWriter(claims.login)) {
    sendPrivateError(res, 403, 'not_a_writer', `${claims.login} does not hold the writer capability`)
    return null
  }
  return claims
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  if (req.method === 'PUT') return void (await put(req, res))
  if (req.method === 'DELETE') return void (await del(req, res))
  sendPrivateError(res, 405, 'method_not_allowed', 'PUT or DELETE')
}

async function put(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return

  let patternId: string
  let note: string | null
  let rawUniforms: unknown
  let explicitContract: number | undefined
  try {
    const raw = await readJsonBody(req)
    if (typeof raw !== 'object' || raw === null) throw new BadRequest('expected a JSON object')
    const b = raw as Record<string, unknown>
    patternId = canonicalPatternId(assertPatternId(b.patternId))
    // A canon file for a pattern that does not exist is a file nothing reads,
    // and it would show up in the manifest as coverage that is not there.
    if (patternById(patternId).id !== patternId) throw new BadRequest(`${patternId} is not an implemented recipe`)
    note = typeof b.note === 'string' && b.note.trim().length > 0 ? b.note.trim() : null
    rawUniforms = b.uniforms
    explicitContract = typeof b.contract === 'number' ? b.contract : undefined
    // Parse the uniforms here so a malformed body is a 400 rather than a 502
    // from inside the write. `composeCanonEntry` runs the same normaliser.
    normalizeUniforms(rawUniforms)
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }

  const path = `${CANON_PREFIX}/${patternId}.json`
  try {
    // ONE COMPOSER, TWO PATHS. `functions/contribute.ts` writes canon files too,
    // and the two must produce identical bytes for identical uniforms or the
    // corpus grows two dialects. `composeCanonEntry` is also what carries
    // `tunedUnderContract` (which the data receipt requires) and `frozen` (a
    // human decision a machine may not roll back — AGENTS.md F4) through a
    // rewrite; this endpoint dropped both before it shared the composer.
    const previous = parseExisting(await readFileAt(repoRef(), path))
    const entry = composeCanonEntry({
      patternId,
      uniforms: rawUniforms,
      note,
      savedAt: new Date().toISOString(),
      previous,
      contract: explicitContract,
      tunedNow: true,
    })
    if (sameCanon(previous, entry)) {
      sendPrivateJson(res, 200, { ...entry, savedAt: previous?.savedAt ?? entry.savedAt, commit: null, unchanged: true })
      return
    }
    const commit = await commitChanges(
      repoRef(),
      [{ path, content: serializeCanonEntry(entry) }],
      `Canon: ${patternId}\n\n${note === null ? '' : `${note}\n\n`}Tuned at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { ...entry, commit })
  } catch (err) {
    sendPrivateError(res, 502, 'write_failed', (err as Error).message)
  }
}

async function del(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return
  let patternId: string
  try {
    patternId = canonicalPatternId(assertPatternId(queryValue(req, 'patternId')))
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }
  const path = `${CANON_PREFIX}/${patternId}.json`
  try {
    if ((await readFileAt(repoRef(), path)) === null) {
      sendPrivateError(res, 404, 'not_found', `no canon file at ${path}`)
      return
    }
    const commit = await commitChanges(
      repoRef(),
      [{ path, content: null }],
      // Deleting a canon file is not "resetting to defaults" — it is recording
      // that this pattern has never been canon'd, which is real signal for the
      // contribution queue. The message says so.
      `Canon: remove ${patternId}\n\nThis pattern is recorded as never canon'd again. ` +
        `Removed at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { deleted: [path], commit })
  } catch (err) {
    sendPrivateError(res, 502, 'delete_failed', (err as Error).message)
  }
}

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

/** Sorted keys, finite numbers only. Two orderings are the same canon. */
function uniforms(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) throw new BadRequest('uniforms must be an object')
  const out: Record<string, number> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (!/^u[A-Za-z0-9]{1,32}$/.test(key)) throw new BadRequest(`uniform name ${JSON.stringify(key)} is not a uniform`)
    const n = Number((value as Record<string, unknown>)[key])
    if (!Number.isFinite(n)) throw new BadRequest(`uniform ${key} is not a finite number`)
    out[key] = n
  }
  if (Object.keys(out).length === 0) throw new BadRequest('a canon file is a full snapshot; this one is empty')
  return out
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
  let entry: Record<string, unknown>
  let note: string | null
  try {
    const raw = await readJsonBody(req)
    if (typeof raw !== 'object' || raw === null) throw new BadRequest('expected a JSON object')
    const b = raw as Record<string, unknown>
    patternId = canonicalPatternId(assertPatternId(b.patternId))
    // A canon file for a pattern that does not exist is a file nothing reads,
    // and it would show up in the manifest as coverage that is not there.
    if (patternById(patternId).id !== patternId) throw new BadRequest(`${patternId} is not an implemented recipe`)
    note = typeof b.note === 'string' && b.note.trim().length > 0 ? b.note.trim() : null
    entry = {
      version: 1,
      patternId,
      savedAt: new Date().toISOString(),
      uniforms: uniforms(b.uniforms),
      ...(typeof b.contract === 'number' ? { contract: b.contract } : {}),
      ...(note === null ? {} : { note }),
    }
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }

  const path = `${CANON_PREFIX}/${patternId}.json`
  try {
    const existing = await readFileAt(repoRef(), path)
    if (existing !== null && entry.contract === undefined) {
      // Preserve the contract stamp the file already carried. Dropping it would
      // turn a file that names its `main()` into one that does not, which is
      // the exact silence the stamp exists to end.
      try {
        const prev = JSON.parse(existing.toString('utf8')) as { contract?: number }
        if (typeof prev.contract === 'number') entry.contract = prev.contract
      } catch {
        /* an unparseable existing file is replaced, not preserved */
      }
    }
    const content = Buffer.from(JSON.stringify(entry, null, 2) + '\n', 'utf8')
    if (existing !== null) {
      // `savedAt` moves on every write, so compare the parts that carry meaning
      // rather than the bytes — otherwise every no-op save is a commit.
      try {
        const prev = JSON.parse(existing.toString('utf8')) as Record<string, unknown>
        const same =
          JSON.stringify(prev.uniforms ?? {}) === JSON.stringify(entry.uniforms) &&
          (prev.note ?? null) === (entry.note ?? null) &&
          (prev.contract ?? null) === (entry.contract ?? null)
        if (same) {
          sendPrivateJson(res, 200, { ...entry, savedAt: prev.savedAt, commit: null, unchanged: true })
          return
        }
      } catch {
        /* fall through and replace */
      }
    }
    const commit = await commitChanges(
      repoRef(),
      [{ path, content }],
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

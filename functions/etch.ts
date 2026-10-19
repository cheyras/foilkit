// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// PUT /api/etch    write a human etch record (writer-gated, one commit)
// DELETE /api/etch?cardId=&variantId=   remove it, so the printing reverts to its generated etch
//
// See _lib/etch-record.ts for the format. The baked plate and the segment map
// are optional: a record with `enabled: false` and no files is the per-card
// "no etch" switch.

import { headerValue, queryValue, readJsonBody, sendPrivateError, sendPrivateJson, type FnRequest, type FnResponse } from './_lib/http.ts'
import { COOKIE_NAME, readCookie, verifySession, type SessionClaims } from './_lib/session.ts'
import { refuseIfUnconfigured, writeConfig } from './_lib/config.ts'
import { isWriter } from './_lib/writers.ts'
import { assertCardId, assertVariantId, BadRequest } from './_lib/corpus.ts'
import { commitChanges, noreplyAuthor, readFileAt, repoRef, type CommitChange } from './_lib/github.ts'
import { ETCHES_PREFIX, LEGEND, parseSections, pngOf, type EtchRecord } from './_lib/etch-record.ts'

function requireWriter(req: FnRequest, res: FnResponse): SessionClaims | null {
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

/** Validate a body into the record plus the file changes it implies. Exported for tests. */
export function buildEtchWrite(body: unknown, author: { login: string; id: number | null }, now = new Date()): { record: EtchRecord; changes: CommitChange[] } {
  if (typeof body !== 'object' || body === null) throw new BadRequest('expected a JSON object')
  const b = body as Record<string, unknown>
  const cardId = assertCardId(b.cardId)
  const variantId = assertVariantId(b.variantId)
  if (typeof b.enabled !== 'boolean') throw new BadRequest('enabled must be true or false')
  const baseRaw = (b.base ?? {}) as Record<string, unknown>
  const baseKind = baseRaw.kind === 'generated' ? 'generated' : 'none'
  const baseSha = typeof baseRaw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(baseRaw.sha256) ? baseRaw.sha256 : null
  const etch = pngOf(b.etch, 1008, 1408, 'etch')
  const segs = pngOf(b.segs, 504, 704, 'segs')
  const dir = `${ETCHES_PREFIX}/${cardId}`
  const record: EtchRecord = {
    version: 1,
    cardId,
    variantId,
    enabled: b.enabled,
    base: { kind: baseKind, sha256: baseKind === 'generated' ? baseSha : null },
    sections: parseSections(b.sections),
    legend: LEGEND,
    files: { etch: etch ? `${variantId}.png` : null, segs: segs ? `${variantId}.segs.png` : null },
    savedAt: now.toISOString(),
    author,
  }
  const changes: CommitChange[] = [
    { path: `${dir}/${variantId}.json`, content: Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8') },
    { path: `${dir}/${variantId}.png`, content: etch },
    { path: `${dir}/${variantId}.segs.png`, content: segs },
  ]
  return { record, changes }
}

async function put(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return
  let built: ReturnType<typeof buildEtchWrite>
  try {
    built = buildEtchWrite(await readJsonBody(req), { login: writer.login, id: writer.id })
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }
  const { record } = built
  try {
    // a null-content change deletes; only send deletions for files that exist
    const changes: CommitChange[] = []
    for (const c of built.changes) {
      if (c.content !== null) changes.push(c)
      else if ((await readFileAt(repoRef(), c.path)) !== null) changes.push(c)
    }
    const what = record.enabled ? (record.files.etch ? 'edited' : 'on (generated)') : 'off'
    const commit = await commitChanges(
      repoRef(),
      changes,
      `Etch: ${record.cardId}/${record.variantId} — ${what}\n\nSaved at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { ...record, commit })
  } catch (err) {
    sendPrivateError(res, 502, 'write_failed', (err as Error).message)
  }
}

async function del(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return
  let cardId: string
  let variantId: number
  try {
    cardId = assertCardId(queryValue(req, 'cardId'))
    variantId = assertVariantId(queryValue(req, 'variantId'))
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }
  const dir = `${ETCHES_PREFIX}/${cardId}`
  try {
    const changes: CommitChange[] = []
    for (const f of [`${variantId}.json`, `${variantId}.png`, `${variantId}.segs.png`]) {
      if ((await readFileAt(repoRef(), `${dir}/${f}`)) !== null) changes.push({ path: `${dir}/${f}`, content: null })
    }
    if (changes.length === 0) {
      sendPrivateError(res, 404, 'not_found', `no etch record for ${cardId}/${variantId}`)
      return
    }
    const commit = await commitChanges(
      repoRef(),
      changes,
      `Etch: ${cardId}/${variantId} — reverted to generated\n\nRemoved at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { deleted: changes.map((c) => c.path), commit })
  } catch (err) {
    sendPrivateError(res, 502, 'delete_failed', (err as Error).message)
  }
}

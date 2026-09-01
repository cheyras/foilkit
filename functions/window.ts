// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Adjusted window geometry — where the art box actually is on this scan.
//
// Simpler than a mask by a lot: it is a small JSON record with no pixels, so
// there is no rasterizer to run and nothing for a server to derive from the
// bytes. What it shares with the mask path is the shape of the write — writer
// capability, one commit, a fast-forward that refuses to discard somebody
// else's push.
//
// ALIASING NOTE, because it differs from masks and getting it backwards would
// corrupt the corpus: window geometry aliases SCOPE-AGNOSTICALLY, per card. The
// art box is a property of the scan, and a sheet is the same box inverted — so
// a single record answers for every variant and every scope of one cardId.
// Masks alias per `(cardId, scope)`; these do not.

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
import { assertCardId, assertVariantId, BadRequest, WINDOWS_PREFIX } from './_lib/corpus.ts'
import { commitChanges, noreplyAuthor, readFileAt, repoRef, type CommitChange } from './_lib/github.ts'
import { RESOLVER_VERSION } from '@foilkit/resolver'

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

function rect(value: unknown, what: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) throw new BadRequest(`${what} must be [x,y,w,h]`)
  const out = value.map((v) => Number(v))
  for (const v of out) {
    if (!Number.isFinite(v)) throw new BadRequest(`${what} has a non-finite number`)
    // Same bounds forge's own `parsePrior` uses: a UV rect may hang slightly
    // off the card, and nothing legitimate goes further than that.
    if (v < -0.5 || v > 1.5) throw new BadRequest(`${what} is out of range`)
  }
  return out as [number, number, number, number]
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  if (req.method === 'PUT') return void (await put(req, res))
  if (req.method === 'DELETE') return void (await del(req, res))
  sendPrivateError(res, 405, 'method_not_allowed', 'PUT or DELETE')
}

async function put(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return

  let entry: Record<string, unknown>
  let cardId: string
  let variantId: number
  try {
    const raw = await readJsonBody(req)
    if (typeof raw !== 'object' || raw === null) throw new BadRequest('expected a JSON object')
    const b = raw as Record<string, unknown>
    cardId = assertCardId(b.cardId)
    variantId = assertVariantId(b.variantId)
    const scope = String(b.scope ?? '')
    if (!['window', 'sheet', 'full', 'none'].includes(scope)) throw new BadRequest('scope is invalid')
    const eraId = String(b.eraId ?? '')
    if (!/^[a-z0-9-]{1,32}$/.test(eraId)) throw new BadRequest('eraId is invalid')
    const base = (b.base ?? {}) as Record<string, unknown>
    entry = {
      version: 1,
      cardId,
      variantId,
      // The artwork key is what makes the record scan-keyed rather than
      // variant-keyed; the card id IS the key, because imagery is per card.
      artworkKey: cardId,
      savedAt: new Date().toISOString(),
      scope,
      eraId,
      rect: rect(b.rect, 'rect'),
      radius: Number(b.radius),
      invert: b.invert === true,
      base: {
        rect: rect(base.rect, 'base.rect'),
        radius: Number(base.radius),
        resolverVersion: Number(base.resolverVersion ?? RESOLVER_VERSION),
      },
    }
    if (!Number.isFinite(entry.radius as number)) throw new BadRequest('radius must be a number')
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }

  const path = `${WINDOWS_PREFIX}/${cardId}/${variantId}.json`
  const content = Buffer.from(JSON.stringify(entry, null, 2) + '\n', 'utf8')
  try {
    const existing = await readFileAt(repoRef(), path)
    if (existing !== null && existing.equals(content)) {
      sendPrivateJson(res, 200, { ...entry, commit: null, unchanged: true })
      return
    }
    const commit = await commitChanges(
      repoRef(),
      [{ path, content }],
      `Window: ${cardId}/${variantId}\n\nAdjusted at foilkit.deckpal.app by @${writer.login}.\n`,
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
  let cardId: string
  let variantId: number
  try {
    cardId = assertCardId(queryValue(req, 'cardId'))
    variantId = assertVariantId(queryValue(req, 'variantId'))
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }
  const path = `${WINDOWS_PREFIX}/${cardId}/${variantId}.json`
  try {
    if ((await readFileAt(repoRef(), path)) === null) {
      sendPrivateError(res, 404, 'not_found', `no window geometry at ${path}`)
      return
    }
    const changes: CommitChange[] = [{ path, content: null }]
    const commit = await commitChanges(
      repoRef(),
      changes,
      `Window: remove ${cardId}/${variantId}\n\nRemoved at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { deleted: [path], commit })
  } catch (err) {
    sendPrivateError(res, 502, 'delete_failed', (err as Error).message)
  }
}

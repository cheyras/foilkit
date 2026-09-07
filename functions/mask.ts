// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The direct write. One save, one commit.
//
// THIS ENDPOINT IS THE REASON THE STAGING LAYER NEEDED NO PROVENANCE CHANGES.
// It runs `writeMaskRecord` — the same function the workbench PUT route and
// every generator run through — against a /tmp copy of the corpus, and commits
// what it produced. So `derivation_method` is still decided SERVER-SIDE by
// diffing the saved pixels against what the declared seed actually rasterizes
// to. The client says what it started from; it never says what it made.
//
// WHO MAY REACH IT. The writer capability, checked here against the GitHub
// login inside a signed cookie. `apps/editor/src/writer/capability.ts` carries
// the same list and decides what the UI offers, but it is not a boundary —
// anybody can edit their own JavaScript. This is the check that matters, and
// `functions/_lib/writers.test.ts` keeps the two lists honest.
//
// ── #10: THE AUTHOR, AND THE PROMOTION ─────────────────────────────────────
//
// PUT now stamps `author: { login, id, via: 'writer-direct' }` into the
// sidecar, from the SAME claims `requireWriter` just checked. It is not read
// from the body and there is no body field for it — `functions/_lib/validate.ts`
// refuses one on the contribution path for the same reason. Because that login
// holds the capability and the channel is writer-gated, `deriveTier` reads the
// record back as `owner-verified` with no verification block: a direct write
// runs AS the capability holder, so asking him to then countersign his own save
// would be a ritual rather than a check.
//
// PATCH is the promotion. It is the only route that writes a `verification`
// block, it writes it from the cookie's login rather than the body's, and
// `verifyMaskRecord` refuses outright if that login does not hold the
// capability. It touches the `.json` and nothing else — the mask PNG's sha256
// is identical before and after — which is what makes a promotion reviewable as
// a one-line diff instead of as a re-save nobody can tell from a repaint.

import {
  headerValue,
  readJsonBody,
  sendPrivateError,
  sendPrivateJson,
  queryValue,
  BodyTooLarge,
  type FnRequest,
  type FnResponse,
} from './_lib/http.ts'
import { COOKIE_NAME, readCookie, verifySession, type SessionClaims } from './_lib/session.ts'
import { refuseIfUnconfigured, writeConfig } from './_lib/config.ts'
import { isWriter } from './_lib/writers.ts'
import {
  assertCardId,
  assertVariantId,
  BadRequest,
  changesIn,
  deletionsIn,
  materialise,
  MASKS_PREFIX,
  pngFromDataUrl,
} from './_lib/corpus.ts'
import { commitChanges, noreplyAuthor, repoRef, type CommitChange } from './_lib/github.ts'
import { NotAWriter, verifyMaskRecord, writeMaskRecord } from '@foilkit/forge'
import { parsePrior } from '@foilkit/forge'
import { rm } from 'node:fs/promises'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The signed-in writer, or null with the response already sent. */
function requireWriter(req: FnRequest, res: FnResponse): SessionClaims | null {
  // Configuration BEFORE identity. A deployment with no GitHub token cannot
  // write no matter who is asking, and telling a signed-out visitor to sign in
  // first would send them round a loop that ends in the same refusal.
  if (refuseIfUnconfigured(res, writeConfig())) return null
  const claims = verifySession(readCookie(headerValue(req, 'cookie') ?? undefined, COOKIE_NAME))
  if (claims === null) {
    // 401, and the editor reads it exactly as the old client read a 404 from
    // the dev surface: the affordance is not available here, hide it. The work
    // goes to the staging layer, which is the normal path.
    sendPrivateError(res, 401, 'sign_in_required', 'a direct write needs a signed-in writer')
    return null
  }
  if (!isWriter(claims.login)) {
    sendPrivateError(
      res,
      403,
      'not_a_writer',
      `${claims.login} does not hold the writer capability — stage the session and submit it instead`,
    )
    return null
  }
  return claims
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  if (req.method === 'PUT') return void (await put(req, res))
  if (req.method === 'PATCH') return void (await verify(req, res))
  if (req.method === 'DELETE') return void (await del(req, res))
  sendPrivateError(res, 405, 'method_not_allowed', 'PUT, PATCH or DELETE')
}

async function put(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return

  let body: Record<string, unknown>
  try {
    const raw = await readJsonBody(req)
    if (typeof raw !== 'object' || raw === null) throw new BadRequest('expected a JSON object')
    body = raw as Record<string, unknown>
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      sendPrivateError(res, 413, 'too_large', err.message)
      return
    }
    sendPrivateError(res, 400, 'bad_body', (err as Error).message)
    return
  }

  let cardId: string
  let variantId: number
  let png: Buffer
  let width: number
  let height: number
  let prior: ReturnType<typeof parsePrior>
  let startedFrom: 'layout' | 'window-bake' | 'mask'
  let parentRef: { cardId: string; variantId: number } | null
  try {
    cardId = assertCardId(body.cardId)
    variantId = assertVariantId(body.variantId)
    png = pngFromDataUrl(body.png)
    width = Number(body.width)
    height = Number(body.height)
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new BadRequest('width and height must be positive integers')
    }
    // The prior is parsed by forge's own validator, which pins `source` to
    // 'layout' whatever the caller said: the REAL source is decided from the
    // pixels and the parent on disk. Never let a client name its own source.
    prior = parsePrior(body.prior)
    const derivation = (body.derivation ?? {}) as { startedFrom?: unknown; parent?: unknown }
    if (
      derivation.startedFrom !== 'layout' &&
      derivation.startedFrom !== 'window-bake' &&
      derivation.startedFrom !== 'mask'
    ) {
      throw new BadRequest('derivation.startedFrom must be layout, window-bake or mask')
    }
    startedFrom = derivation.startedFrom
    const p = derivation.parent as { cardId?: unknown; variantId?: unknown } | null | undefined
    parentRef =
      p === null || p === undefined
        ? null
        : { cardId: assertCardId(p.cardId), variantId: assertVariantId(p.variantId) }
  } catch (err) {
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }

  const ref = repoRef()
  let workspaceRoot: string | null = null
  try {
    // Everything the write READS: this card's directory, and the parent's when
    // the seed named a different card (aliasing across variants of one card is
    // inside the same directory, so that case needs nothing extra).
    const dirs = [`${MASKS_PREFIX}/${cardId}`]
    if (parentRef !== null && parentRef.cardId !== cardId) dirs.push(`${MASKS_PREFIX}/${parentRef.cardId}`)
    const ws = await materialise(ref, dirs)
    workspaceRoot = ws.root

    const sidecar = await writeMaskRecord({
      masksDir: ws.masksDir,
      cardId,
      variantId: String(variantId),
      png,
      width,
      height,
      prior,
      startedFrom,
      parentRef,
      artworkUrl: typeof body.artworkUrl === 'string' ? body.artworkUrl : null,
      card: (body.card ?? undefined) as never,
      // The author, from the cookie `requireWriter` just verified — NEVER from
      // the body, which carries no field for it. Same trust model as `machine`
      // below: the route knows, the client does not get to say.
      author: { login: writer.login, id: writer.id, via: 'writer-direct' },
      // No `machine`: only a real generator may claim a machine label, and only
      // by handing over a full identity. An HTTP caller cannot supply one, which
      // is the rule that keeps machine output out of the exemplar pool.
    })

    const changes: CommitChange[] = [...changesIn(ws, MASKS_PREFIX), ...deletionsIn(ws, MASKS_PREFIX)]
    if (changes.length === 0) {
      // Byte-identical to what is already there. Not an error, and not a commit
      // either — an empty commit in this history would read as a save nobody
      // made.
      sendPrivateJson(res, 200, { ...sidecar, commit: null, unchanged: true })
      return
    }

    const subject = `Mask: ${cardId}/${variantId} — ${sidecar.derivation_method}`
    const detail = typeof body.comment === 'string' && body.comment.trim().length > 0 ? body.comment.trim() : null
    const message =
      `${subject}\n\n` +
      `${sidecar.diff ? `Agreement against the era rule: ${sidecar.diff.agreement}.\n` : ''}` +
      `${sidecar.correction ? `Corrects ${sidecar.correction.parent.cardId}/${sidecar.correction.parent.variantId} (${sidecar.correction.parent.method}), agreement ${sidecar.correction.agreement}.\n` : ''}` +
      `${detail === null ? '' : `\n${detail}\n`}` +
      `\nAuthored at foilkit.deckpal.app by @${writer.login}.\n`

    const commit = await commitChanges(
      ref,
      changes,
      message,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { ...sidecar, commit })
  } catch (err) {
    const message = (err as Error).message
    // forge throws on a frame it cannot authorise, on a machine write over a
    // human mask, and on a png whose dimensions disagree with the declared
    // ones. All of those are the caller's problem and all deserve a 400 with
    // the real reason — the alternative is a 500 and a mystery.
    const status = /frame|dimensions|supersede|prior/i.test(message) ? 400 : 502
    sendPrivateError(res, status, status === 400 ? 'refused' : 'write_failed', message)
  } finally {
    if (workspaceRoot !== null) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * PROMOTE a mask to `owner-verified`. The writer-gated half of #10.
 *
 * The whole security property is one line below: `verifier` is built from
 * `writer.login`, which came out of a signed cookie, and there is no path from
 * the request body to it. A contributor cannot verify their own work, because
 * `verifyMaskRecord` refuses a login without the capability — and even if a
 * forged block somehow reached the repository, `deriveTier` re-checks the login
 * against the same list on every single read, so the block would grant nothing.
 *
 * It rewrites ONE FILE. `writeMaskRecord` is deliberately not involved: it
 * would re-derive the method against the parent as it is on disk and re-emit
 * every artifact, which is the right behaviour for a save and the wrong one for
 * a statement about a save.
 */
async function verify(req: FnRequest, res: FnResponse): Promise<void> {
  const writer = requireWriter(req, res)
  if (writer === null) return

  let cardId: string
  let variantId: number
  let note: string | null
  try {
    const raw = await readJsonBody(req)
    if (typeof raw !== 'object' || raw === null) throw new BadRequest('expected a JSON object')
    const b = raw as Record<string, unknown>
    cardId = assertCardId(b.cardId)
    variantId = assertVariantId(b.variantId)
    note = typeof b.note === 'string' && b.note.trim().length > 0 ? b.note.trim().slice(0, 400) : null
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      sendPrivateError(res, 413, 'too_large', err.message)
      return
    }
    sendPrivateError(res, 400, 'bad_request', (err as Error).message)
    return
  }

  const ref = repoRef()
  let workspaceRoot: string | null = null
  try {
    const ws = await materialise(ref, [`${MASKS_PREFIX}/${cardId}`])
    workspaceRoot = ws.root
    const result = await verifyMaskRecord({
      masksDir: ws.masksDir,
      cardId,
      variantId,
      // From the COOKIE. There is no body field that reaches this.
      verifier: { login: writer.login, id: writer.id },
      via: 'writer-direct',
      note,
    })
    if (result.unchanged) {
      sendPrivateJson(res, 200, { ...result.sidecar, commit: null, unchanged: true })
      return
    }

    const changes: CommitChange[] = changesIn(ws, MASKS_PREFIX)
    // A verification changes exactly one file. Asserting it rather than
    // trusting it: if this ever collected a PNG, something re-rasterized during
    // a promotion and the commit would say "verified" over changed pixels.
    const png = changes.find((c) => !c.path.endsWith('.json'))
    if (png) throw new Error(`a verification must touch only the sidecar, but ${png.path} also changed`)
    if (changes.length === 0) {
      sendPrivateJson(res, 200, { ...result.sidecar, commit: null, unchanged: true })
      return
    }

    const commit = await commitChanges(
      ref,
      changes,
      `Verify: ${cardId}/${variantId} — ${result.from} → ${result.to}\n\n` +
        `${result.sidecar.derivation_method} mask promoted to exemplar grade; it now carries weight in ` +
        'selectExemplars and every rule derived through it.\n' +
        `${note === null ? '' : `\n${note}\n`}` +
        `\nVerified at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { ...result.sidecar, commit, promoted: { from: result.from, to: result.to } })
  } catch (err) {
    if (err instanceof NotAWriter) {
      sendPrivateError(res, 403, 'not_a_writer', err.message)
      return
    }
    const message = (err as Error).message
    const status = /no readable sidecar|only the sidecar/i.test(message) ? 404 : 502
    sendPrivateError(res, status, status === 404 ? 'not_found' : 'verify_failed', message)
  } finally {
    if (workspaceRoot !== null) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Delete a mask and every artifact beside it.
 *
 * Writer-only, and NOT STAGEABLE for anybody else — a contributor's first
 * available action should not be removing ground truth, and a deletion has no
 * diff to review.
 */
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

  const ref = repoRef()
  let workspaceRoot: string | null = null
  try {
    const ws = await materialise(ref, [`${MASKS_PREFIX}/${cardId}`])
    workspaceRoot = ws.root
    const dir = join(ws.masksDir, cardId)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      sendPrivateError(res, 404, 'not_found', `no mask directory for ${cardId}`)
      return
    }
    // `<variantId>.png`, `.json`, `.prior.png`, `.diff.png`, `.parent.png`,
    // `.parent.diff.png` — matched by prefix so a future artifact kind is
    // removed too, and anchored on the dot so variant 1 never takes out 10.
    const prefix = `${variantId}.`
    for (const name of names) if (name.startsWith(prefix)) rmSync(join(dir, name))

    const changes = deletionsIn(ws, MASKS_PREFIX)
    if (changes.length === 0) {
      sendPrivateError(res, 404, 'not_found', `nothing to delete for ${cardId}/${variantId}`)
      return
    }
    const commit = await commitChanges(
      ref,
      changes,
      `Mask: remove ${cardId}/${variantId}\n\nRemoved at foilkit.deckpal.app by @${writer.login}.\n`,
      noreplyAuthor({ login: writer.login, id: writer.id, name: writer.name, avatar_url: writer.avatarUrl }),
    )
    sendPrivateJson(res, 200, { deleted: changes.map((c) => c.path), commit })
  } catch (err) {
    sendPrivateError(res, 502, 'delete_failed', (err as Error).message)
  } finally {
    if (workspaceRoot !== null) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

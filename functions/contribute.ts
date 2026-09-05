// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The contribution pipeline. A staged session becomes a reviewable pull request.
//
// This is the endpoint the "Submission opens PRs once the contribution pipeline
// ships" placeholder was standing in for. The shape it replaced that placeholder
// with, end to end:
//
//   1. REFUSE EARLY, NAMING WHY. No App configured → a clean 503 that names the
//      three variables. Not signed in → 401. Invalid submission → 422 with the
//      list of reasons, before a branch exists.
//   2. VALIDATE SERVER-SIDE (`_lib/validate.ts`). Non-negotiable: a pull
//      request is a claim on a reviewer's attention and an invalid one costs a
//      human a round trip to learn something a machine knew in 40 ms.
//   3. RUN THE REAL WRITE against a /tmp copy of `main` — `writeMaskRecord`,
//      the same function every mask in this project goes through. The
//      `derivation_method`, the agreement number and the `.diff.png` in the
//      pull request are therefore MEASURED, by the same code, from the same
//      pixels, as every mask already in the corpus. Nothing here re-derives
//      them, and nothing takes the client's word for them (AGENTS.md F3).
//   4. COMMIT AS THE APP, onto a branch derived from the session's identity and
//      its seed, and open or update the pull request.
//
// ── WHO MAY REACH IT ───────────────────────────────────────────────────────
//
// Any signed-in GitHub account. That is the whole point of the subtask: the
// direct-write path is one person, and this one is everybody else. The writer
// capability is not checked, and must not be — a contribution from the
// maintainer and a contribution from a stranger travel the same rails, which is
// also what makes the pipeline live-testable by the person who owns it.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//
// Deletions. `DELETIONS_STAGEABLE = false` in the staging layer, and the same
// reasoning holds one layer down: a contributor's first available action should
// not be removing ground truth, and a deletion has no diff to review — the pull
// request would be an empty file and a claim.

import {
  BodyTooLarge,
  headerValue,
  readJsonBody,
  sendPrivateError,
  sendPrivateJson,
  type FnRequest,
  type FnResponse,
} from './_lib/http.ts'
import { COOKIE_NAME, readCookie, verifySession, type SessionClaims } from './_lib/session.ts'
import { contributeConfig, refuseIfUnconfigured } from './_lib/config.ts'
import {
  assertCardId,
  assertPatternId,
  assertVariantId,
  BadRequest,
  CANON_PREFIX,
  changesIn,
  materialise,
  MASKS_PREFIX,
  pngFromDataUrl,
} from './_lib/corpus.ts'
import { repoRef, type RepoRef } from './_lib/github.ts'
import { AppAuthError, appCredentials, installationToken } from './_lib/app-auth.ts'
import {
  botAuthor,
  canonBranchName,
  commitToBranch,
  maskBranchName,
  openOrUpdatePr,
  PrError,
  readBranch,
  type FileChange,
} from './_lib/pr.ts'
import { validateCanon, validateMask, type Check } from './_lib/validate.ts'
import {
  composeCommitMessage,
  composePrBody,
  prTitle,
  touchesData,
  type Contributor,
} from './_lib/pr-body.ts'
import {
  composeCanonEntry,
  parseExisting,
  sameCanon,
  serializeCanonEntry,
} from './_lib/canon-entry.ts'
import { readFileAt } from './_lib/github.ts'
import { canonicalPatternId, patternById } from '@foilkit/patterns'
import { COMPOSITE_CONTRACT } from '@foilkit/core'
import { parsePrior, writeMaskRecord } from '@foilkit/forge'
import { rm } from 'node:fs/promises'

/**
 * The App's own identity in a commit author line.
 *
 * These are the slug and the bot user id of the installed App. They are
 * cosmetic — GitHub attributes the commit by the token that pushed it, not by
 * this string — but getting them right is what makes the avatar on the commit
 * resolve to the App rather than to a blank. Overridable by environment so a
 * differently-named App does not need a code change, with the values the
 * maintainer's App is being created with as the default.
 */
function appIdentity(): { slug: string; userId: string } {
  return {
    slug: process.env.FOILKIT_APP_SLUG ?? 'foilkit-contribute',
    // The bot user id is not knowable before the App exists. Falling back to
    // the app id keeps the address well-formed and stable; the maintainer can
    // set the real one once `GET /users/<slug>[bot]` answers.
    userId: process.env.FOILKIT_APP_USER_ID ?? process.env.FOILKIT_APP_ID ?? '0',
  }
}

/** The signed-in contributor, or null with the response already sent. */
function requireSignedIn(req: FnRequest, res: FnResponse): SessionClaims | null {
  // Configuration BEFORE identity, the same ladder every other function uses:
  // a deployment with no App cannot open a pull request no matter who is
  // asking, and sending a signed-out visitor round a sign-in loop that ends in
  // the same refusal is worse than saying so up front.
  if (refuseIfUnconfigured(res, contributeConfig())) return null
  const claims = verifySession(readCookie(headerValue(req, 'cookie') ?? undefined, COOKIE_NAME))
  if (claims === null) {
    sendPrivateError(
      res,
      401,
      'sign_in_required',
      'submitting opens a pull request in your name, so it needs a GitHub sign-in. Your session stays staged either way.',
    )
    return null
  }
  return claims
}

export default async function handler(req: FnRequest, res: FnResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendPrivateError(res, 405, 'method_not_allowed', 'POST')
    return
  }
  const claims = requireSignedIn(req, res)
  if (claims === null) return

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

  const contributor: Contributor = { login: claims.login, name: claims.name, id: claims.id }

  try {
    if (body.kind === 'mask') return void (await submitMask(res, body, contributor))
    if (body.kind === 'canon') return void (await submitCanon(res, body, contributor))
    sendPrivateError(res, 400, 'bad_request', 'kind must be "mask" or "canon"')
  } catch (err) {
    if (err instanceof BadRequest) {
      sendPrivateError(res, 400, 'bad_request', err.message)
      return
    }
    if (err instanceof AppAuthError) {
      // 503 when the App is misconfigured (the maintainer's problem), 502 when
      // GitHub refused (transient, retryable). `AppAuthError` already made that
      // distinction; do not flatten it.
      sendPrivateError(
        res,
        err.status === 503 ? 503 : 502,
        err.status === 503 ? 'not_configured' : 'github_unavailable',
        err.message,
      )
      return
    }
    if (err instanceof PrError) {
      sendPrivateError(res, err.status >= 400 && err.status < 500 ? 502 : 502, 'pr_failed', err.message)
      return
    }
    const message = (err as Error).message
    // forge refuses a frame it cannot authorise, a machine write over a human
    // mask, and a png whose dimensions disagree with the declared ones. All of
    // those are the caller's problem and deserve the real reason.
    const refused = /frame|dimensions|supersede|prior/i.test(message)
    sendPrivateError(res, refused ? 422 : 502, refused ? 'refused' : 'submit_failed', message)
  }
}

/** The conflict block every submission carries. Absent means "fresh". */
function readConflict(value: unknown): { kind: string; acknowledged: boolean; detail: string } {
  const c = (value ?? {}) as Record<string, unknown>
  const kind = typeof c.kind === 'string' && c.kind.length > 0 ? c.kind : 'none'
  return {
    kind,
    acknowledged: c.acknowledged === true,
    detail: typeof c.detail === 'string' ? c.detail.slice(0, 400) : '',
  }
}

function refuseValidation(res: FnResponse, checks: readonly Check[], failures: readonly string[]): void {
  sendPrivateJson(res, 422, {
    error: {
      code: 'validation_failed',
      message: `this session cannot open a pull request yet: ${failures[0] ?? 'unknown'}`,
    },
    checks,
    failures,
  })
}

// ── Masks ──────────────────────────────────────────────────────────────────

async function submitMask(res: FnResponse, body: Record<string, unknown>, contributor: Contributor): Promise<void> {
  const cardId = assertCardId(body.cardId)
  const variantId = assertVariantId(body.variantId)
  const png = pngFromDataUrl(body.png)
  const width = Number(body.width)
  const height = Number(body.height)
  const derivation = (body.derivation ?? {}) as { startedFrom?: unknown; parent?: unknown }
  const seedRaw = (body.seed ?? {}) as Record<string, unknown>
  const seed = {
    parentSha256: typeof seedRaw.parentSha256 === 'string' ? seedRaw.parentSha256 : null,
    resolvedFrom: readRef(seedRaw.resolvedFrom),
    seededAt: typeof seedRaw.seededAt === 'string' ? seedRaw.seededAt : 'an unrecorded time',
  }
  const conflict = readConflict(body.conflict)
  const comment = typeof body.comment === 'string' ? body.comment : ''

  // ── Validation, BEFORE the branch exists ────────────────────────────────
  const validation = validateMask({
    png,
    width,
    height,
    prior: body.prior,
    derivation,
    seed: { parentSha256: seed.parentSha256, resolvedFrom: seed.resolvedFrom },
    conflict,
  })
  if (!validation.ok) return refuseValidation(res, validation.checks, validation.failures)

  // Past validation, the shapes below are known good — `validateMask` already
  // ran `parsePrior` and checked `startedFrom`, so these cannot throw.
  const prior = parsePrior(body.prior)
  const startedFrom = derivation.startedFrom as 'layout' | 'window-bake' | 'mask'
  const parentRef = readRef(derivation.parent)

  const token = await installationToken(appCredentials())
  const ref: RepoRef = { ...repoRef(), token }

  let workspaceRoot: string | null = null
  try {
    // Everything the write READS, materialised from the BASE branch head — not
    // from the contribution branch. The contribution is always "what this
    // session changes about current `main`", however many times it is
    // submitted, which is what keeps the pull request one commit with one diff.
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
      // No `machine`. Only a real generator may claim a machine label, and only
      // by handing over a full identity — which an HTTP caller cannot supply.
      // That is the rule that keeps machine output out of the exemplar pool
      // (AGENTS.md F3), and it holds on this path exactly as it does on the
      // direct-write one.
    })

    // DELETIONS ARE NOT COLLECTED. `changesIn` alone, deliberately: the direct
    // write also passes `deletionsIn` so a save that stops being a correction
    // cleans up its stale `.parent.png`, but a pull request that removes a file
    // from `data/` is a different act with a different review, and a
    // contribution must not be able to perform one as a side effect.
    const changes: FileChange[] = changesIn(ws, MASKS_PREFIX)
    if (changes.length === 0) {
      sendPrivateJson(res, 200, {
        unchanged: true,
        pr: null,
        validation,
        sidecar,
        message:
          'this session is byte-identical to what is already upstream, so there is nothing to review. ' +
          'Nothing was opened.',
      })
      return
    }

    const paths = changes.map((c) => c.path)
    const branch = maskBranchName(contributor.login, cardId, variantId, seed.parentSha256)
    const identity = appIdentity()

    const message = composeCommitMessage({
      subject: `Mask: ${cardId}/${variantId} — ${sidecar.derivation_method}`,
      detail: [
        sidecar.diff ? `Agreement against the era rule: ${sidecar.diff.agreement}.` : null,
        sidecar.correction
          ? `Corrects ${sidecar.correction.parent.cardId}/${sidecar.correction.parent.variantId} (${sidecar.correction.parent.method}), agreement ${sidecar.correction.agreement}.`
          : null,
        comment.trim().length > 0 ? `\n${comment.trim()}` : null,
      ]
        .filter((l): l is string => l !== null)
        .join('\n'),
      contributor,
      data: touchesData(paths),
    })

    const state = await readBranch(ref, branch, token)
    await commitToBranch(
      ref,
      {
        branch,
        baseSha: state.baseSha,
        changes,
        message,
        author: botAuthor(identity.slug, identity.userId),
        branchExists: state.headSha !== null,
      },
      token,
    )

    const prBody = composePrBody({
      kind: 'mask',
      contributor,
      cardId,
      variantId,
      cardName: readCardName(body.card),
      paths,
      comment,
      checks: validation.checks,
      coverage: validation.coverage,
      provisional: readProvisional(body.provisional),
      measured: {
        derivationMethod: sidecar.derivation_method,
        agreement: sidecar.diff?.agreement ?? null,
        correctionAgreement: sidecar.correction?.agreement ?? null,
      },
      seed: {
        startedFrom,
        parent: parentRef,
        resolvedFrom: seed.resolvedFrom,
        parentSha256: seed.parentSha256,
        seededAt: seed.seededAt,
      },
      conflict,
      branch,
    })

    const pr = await openOrUpdatePr(
      ref,
      { branch, title: prTitle({ kind: 'mask', cardId, variantId, cardName: readCardName(body.card) }), body: prBody },
      token,
    )
    sendPrivateJson(res, 200, { pr: { url: pr.htmlUrl, number: pr.number, updated: pr.updated }, branch, validation, sidecar })
  } finally {
    if (workspaceRoot !== null) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

function readRef(value: unknown): { cardId: string; variantId: number } | null {
  if (value === null || value === undefined) return null
  const r = value as { cardId?: unknown; variantId?: unknown }
  return { cardId: assertCardId(r.cardId), variantId: assertVariantId(r.variantId) }
}

function readCardName(value: unknown): string | null {
  const c = (value ?? null) as { name?: unknown } | null
  return c !== null && typeof c.name === 'string' && c.name.length > 0 ? c.name : null
}

/**
 * The client's PROVISIONAL diff numbers, when it sent them.
 *
 * Carried into the pull request body as an explicitly-labelled second opinion
 * beside the measured ones. It is never allowed to STAND IN for the measured
 * numbers, and it never enters a sidecar — a provisional number that got
 * written down would eventually be read as a measured one.
 */
function readProvisional(
  value: unknown,
): { agreement: number; addedPx: number; removedPx: number; unchangedPx: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  const nums = ['agreement', 'addedPx', 'removedPx', 'unchangedPx'].map((k) => Number(p[k]))
  if (nums.some((n) => !Number.isFinite(n))) return null
  return { agreement: nums[0]!, addedPx: nums[1]!, removedPx: nums[2]!, unchangedPx: nums[3]! }
}

// ── Canon ──────────────────────────────────────────────────────────────────

async function submitCanon(res: FnResponse, body: Record<string, unknown>, contributor: Contributor): Promise<void> {
  const patternId = canonicalPatternId(assertPatternId(body.patternId))
  const uniforms = (body.uniforms ?? {}) as Record<string, unknown>
  const note = typeof body.note === 'string' && body.note.trim().length > 0 ? body.note.trim() : null
  const comment = typeof body.comment === 'string' ? body.comment : ''
  const conflict = readConflict(body.conflict)
  const seedContract = typeof body.seedContract === 'number' ? body.seedContract : null
  const seedSha256 = typeof body.seedSha256 === 'string' ? body.seedSha256 : null

  const validation = validateCanon({ patternId, uniforms, seedContract, conflict })
  if (!validation.ok) return refuseValidation(res, validation.checks, validation.failures)

  const token = await installationToken(appCredentials())
  const ref: RepoRef = { ...repoRef(), token }
  const path = `${CANON_PREFIX}/${patternId}.json`

  const previous = parseExisting(await readFileAt(ref, path))
  const entry = composeCanonEntry({
    patternId,
    uniforms,
    note,
    savedAt: new Date().toISOString(),
    previous,
    // A live tuning session chose these numbers against the law this build
    // ships, which is what `tunedUnderContract` records.
    tunedNow: true,
  })

  if (sameCanon(previous, entry)) {
    sendPrivateJson(res, 200, {
      unchanged: true,
      pr: null,
      validation,
      message: 'these uniforms are what is already upstream, so there is nothing to review. Nothing was opened.',
    })
    return
  }

  const paths = [path]
  const branch = canonBranchName(contributor.login, patternId, seedSha256)
  const identity = appIdentity()

  const message = composeCommitMessage({
    subject: `Canon: ${patternId}`,
    detail: [note, comment.trim().length > 0 ? `\n${comment.trim()}` : null]
      .filter((l): l is string => l !== null && l.length > 0)
      .join('\n'),
    contributor,
    data: touchesData(paths),
  })

  const state = await readBranch(ref, branch, token)
  await commitToBranch(
    ref,
    {
      branch,
      baseSha: state.baseSha,
      changes: [{ path, content: serializeCanonEntry(entry) }],
      message,
      author: botAuthor(identity.slug, identity.userId),
      branchExists: state.headSha !== null,
    },
    token,
  )

  const previousUniforms = (previous?.uniforms ?? null) as Record<string, number> | null
  const moved = Object.keys(entry.uniforms)
    .filter((k) => previousUniforms === null || previousUniforms[k] !== entry.uniforms[k])
    .map((k) => ({ key: k, from: previousUniforms?.[k] ?? null, to: entry.uniforms[k]! }))

  const prBody = composePrBody({
    kind: 'canon',
    contributor,
    patternId,
    paths,
    comment,
    note: note ?? '',
    checks: validation.checks,
    moved,
    contract: COMPOSITE_CONTRACT,
    seedContract,
    conflict,
    branch,
  })

  const pr = await openOrUpdatePr(
    ref,
    { branch, title: prTitle({ kind: 'canon', patternId }), body: prBody },
    token,
  )
  sendPrivateJson(res, 200, {
    pr: { url: pr.htmlUrl, number: pr.number, updated: pr.updated },
    branch,
    validation,
    canon: entry,
    // Named so the client can show which recipe was assembled and checked.
    pattern: patternById(patternId).id,
  })
}

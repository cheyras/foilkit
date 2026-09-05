// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The staged-work surface: what you have staged, what upstream did while you
// were working, and what Submit actually does.
//
// SUBMIT OPENS A PULL REQUEST NOW. It used to say "Submission opens PRs once
// the contribution pipeline ships (subtask 9)" and keep the session locally,
// which was the honest label for a thing that did not exist. The pipeline
// exists: `/api/contribute` validates the session server-side, commits it to a
// branch as the foilkit App with the contributor as `Co-authored-by`, and opens
// the pull request.
//
// THE HONEST FALLBACK SURVIVES, in the same shape it always had. A deployment
// with no App configured answers a named 503; this surface says so and leaves
// the session exactly where it is. A contributor whose work is safe and
// unshipped is in a completely different situation from one whose work is gone,
// and the difference has to be legible in the sentence.
//
// FOUR REFUSALS, FOUR DIFFERENT SENTENCES. Sign-in is one click away.
// Not-configured is nothing they can do and nothing they lost. Invalid is a
// list of things to fix, each checked BEFORE a branch existed. Failed is GitHub
// having a day. Collapsing those into one "submit failed" would be the most
// expensive shortcut available on this screen.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionBtn, Chip, Section } from './ui.tsx'
import { foilApi } from './api.ts'
import { navigate } from './router.ts'
import type { Staging } from './staging/useStaging.ts'
import { isDirty, NotSubmittable } from './staging/session.ts'
import { buildCanonContribution, buildMaskContribution, type SubmissionResult } from './staging/submit.ts'
import { provisionalOf } from './staging/provisionalPixels.ts'
import { detectCanonConflict, detectMaskConflict, type ConflictReport } from './staging/conflict.ts'
import { buildBundle, bundleFilename, parseBundle, planImport, BadBundle } from './staging/portable.ts'
import { sha256Uniforms } from './staging/sha.ts'
import type { CanonSession, MaskSession, StagedSession } from './staging/types.ts'
import { SubmitOutcome } from './SubmitOutcome.tsx'
import type { ViewerState } from './writer/useViewer.ts'
import { RESOLVER_VERSION } from '@foilkit/resolver'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function title(s: StagedSession): string {
  if (s.kind === 'canon') return `canon · ${s.patternId}`
  return `${s.card?.name ?? s.cardId} · ${s.cardId}/${s.variantId}`
}

/**
 * What one session's Submit is currently doing or has just done.
 *
 * Kept PER SESSION rather than as one panel-wide banner, because a contributor
 * with four staged cards submits them one at a time and a shared banner would
 * attribute the last answer to whichever row they happened to be looking at.
 */
interface SubmitState {
  busy: boolean
  result: SubmissionResult | null
}

export function StagePanel({
  staging,
  viewer,
}: {
  staging: Staging
  viewer: ViewerState
}): React.ReactElement {
  const [conflicts, setConflicts] = useState<Record<string, ConflictReport>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [submits, setSubmits] = useState<Record<string, SubmitState>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const masks = useMemo(
    () => staging.sessions.filter((s): s is MaskSession => s.kind === 'mask'),
    [staging.sessions],
  )
  const canons = useMemo(
    () => staging.sessions.filter((s): s is CanonSession => s.kind === 'canon'),
    [staging.sessions],
  )

  // Probe upstream for every staged session, once the list settles. This is the
  // conflict check, and it runs on the STAGED list rather than only at submit
  // so a contributor learns that upstream moved before they spend another hour.
  //
  // CANON SESSIONS ARE PROBED TOO, which they were not before. The submit
  // endpoint refuses a stale session that was never acknowledged, and a canon
  // session with no report would have been submitted as `fresh` — the pull
  // request would say it applies to what its author was looking at when it does
  // not, which is precisely the wrong thing to be confident about in a review.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, ConflictReport> = {}
      for (const s of masks) {
        const probe = await foilApi.probeMask(s.cardId, s.variantId, s.seed.prior.scope)
        next[s.id] = detectMaskConflict(
          s,
          probe === null
            ? { sha256: null, resolvedFrom: null, savedAt: null, method: null }
            : { sha256: probe.sha256, resolvedFrom: probe.resolvedFrom, savedAt: probe.savedAt, method: probe.method },
        )
      }
      if (canons.length > 0) {
        const upstream = await foilApi.getCanon()
        for (const s of canons) {
          const entry = upstream?.[s.patternId] ?? null
          next[s.id] = detectCanonConflict(s, {
            sha256: entry === null ? null : await sha256Uniforms(entry.uniforms),
            savedAt: entry?.savedAt ?? null,
            contract: entry?.contract ?? null,
          })
        }
      }
      if (!cancelled) setConflicts(next)
    })()
    return () => {
      cancelled = true
    }
  }, [masks, canons])

  const exportAll = () => {
    const bundle = buildBundle(staging.sessions, {
      now: new Date().toISOString(),
      resolverVersion: RESOLVER_VERSION,
      buildId: null,
    })
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = bundleFilename(bundle.exportedAt)
    a.click()
    // Revoking immediately races the download on Safari; a tick is enough.
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    setNote(`Exported ${bundle.sessions.length} session(s).`)
  }

  const importFile = async (file: File) => {
    setBusy(true)
    try {
      const bundle = parseBundle(await file.text())
      const plan = planImport(bundle.sessions, staging.sessions)
      for (const s of plan.add) await staging.save(s)
      if (plan.collide.length > 0) {
        // Never merged, never silently overwritten. The human decides, one at
        // a time, with both sides on screen — same principle as a mask conflict.
        const keep = confirm(
          `${plan.collide.length} imported session(s) already exist here:\n\n` +
            plan.collide.map((c) => `  ${title(c.incoming)}`).join('\n') +
            '\n\nReplace the local copies with the imported ones? Cancel keeps what is already here.',
        )
        if (keep) for (const c of plan.collide) await staging.save(c.incoming)
      }
      setNote(`Imported ${plan.add.length} new, ${plan.collide.length} already present.`)
    } catch (err) {
      setNote(err instanceof BadBundle ? `That file is not a usable bundle: ${err.message}` : String(err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /**
   * Submit one session.
   *
   * THE SESSION IS NEVER DISCARDED HERE, not even on success. A pull request
   * can be closed, a reviewer can ask for a change, and the contributor may
   * want to re-submit — which is a supported operation precisely because the
   * branch name is a function of the session's identity and its seed. Deleting
   * the local copy the moment a pull request opened would make the one path
   * that needs it impossible.
   */
  const submit = async (s: StagedSession) => {
    setSubmits((m) => ({ ...m, [s.id]: { busy: true, result: null } }))
    try {
      const payload =
        s.kind === 'mask'
          ? buildMaskContribution(s, conflicts[s.id], await provisionalOf(s))
          : buildCanonContribution(s, conflicts[s.id])
      const result = await foilApi.submitContribution(payload)
      setSubmits((m) => ({ ...m, [s.id]: { busy: false, result } }))
    } catch (err) {
      // `NotSubmittable` is the client's own pre-flight — a session with no
      // pixels yet. It is shaped as a refusal so the row renders it the same
      // way as the server's, rather than through a second code path.
      setSubmits((m) => ({
        ...m,
        [s.id]: {
          busy: false,
          result: {
            ok: false,
            kind: 'invalid',
            message: err instanceof NotSubmittable ? err.message : String(err),
            checks: [],
            failures: [],
            missing: [],
          },
        },
      }))
    }
  }

  return (
    <div className="flex flex-col gap-[12px]">
      <Section title={`Staged work (${staging.sessions.length})`}>
        {!staging.durable && (
          <p className="mb-[10px] rounded-md border border-amber-500/50 bg-amber-500/10 p-[8px] text-[12px] text-amber-200">
            This browser will not let the editor keep a database, so staged work lives only in this tab.
            Export before you close it.
          </p>
        )}
        {staging.loading && <p className="text-[12px] text-text-muted">Reading staged sessions…</p>}
        {!staging.loading && staging.sessions.length === 0 && (
          <p className="text-[13px] text-text-muted">
            Nothing staged. Open a card, draw, and press Save — no account needed, and it will still be here
            tomorrow.
          </p>
        )}

        <ul className="flex flex-col gap-[10px]">
          {staging.sessions.map((s) => {
            const c = s.kind === 'mask' ? conflicts[s.id] : undefined
            return (
              <li key={s.id} className="rounded-md border border-border-default bg-surface-tertiary p-[10px]">
                <div className="flex flex-wrap items-baseline justify-between gap-[6px]">
                  <span className="text-[13px] text-text-primary">{title(s)}</span>
                  <span className="text-[11px] text-text-muted">updated {when(s.updatedAt)}</span>
                </div>
                <p className="mt-[4px] text-[11px] text-text-muted">
                  seeded {when(s.kind === 'mask' ? s.seed.seededAt : s.seed.seededAt)}
                  {s.kind === 'mask' ? ` · from ${s.seed.startedFrom}` : ''}
                  {isDirty(s) ? '' : ' · nothing changed yet'}
                </p>
                {s.kind === 'mask' && s.comment.trim().length > 0 && (
                  <p className="mt-[6px] whitespace-pre-wrap rounded border border-border-default bg-surface-secondary p-[6px] text-[12px] text-text-muted">
                    {s.comment}
                  </p>
                )}
                {c?.conflicted && (
                  <p className="mt-[6px] rounded border border-amber-500/50 bg-amber-500/10 p-[6px] text-[12px] text-amber-200">
                    <strong className="font-semibold">{c.kind}</strong> — {c.detail}
                  </p>
                )}
                <div className="mt-[8px] flex flex-wrap gap-[6px]">
                  {s.kind === 'mask' && (
                    <ActionBtn onClick={() => navigate(`/card?id=${encodeURIComponent(s.cardId)}&v=${s.variantId}`)}>
                      Open
                    </ActionBtn>
                  )}
                  <ActionBtn onClick={() => void submit(s)} disabled={!isDirty(s) || submits[s.id]?.busy === true}>
                    {submits[s.id]?.busy === true
                      ? 'Opening a pull request…'
                      : submits[s.id]?.result?.ok === true
                        ? 'Submit again'
                        : 'Submit'}
                  </ActionBtn>
                  <ActionBtn
                    onClick={() => {
                      if (confirm(`Discard the staged work on ${title(s)}? This cannot be undone.`)) {
                        void staging.discard(s.id)
                      }
                    }}
                  >
                    Discard
                  </ActionBtn>
                </div>
                <SubmitOutcome state={submits[s.id]} viewer={viewer} />
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="Move work between browsers">
        <p className="mb-[8px] text-[12px] text-text-muted">
          There is no account before Submit, so a file is the only bridge between two devices — and the
          only way work is never trapped in one browser.
        </p>
        <div className="flex flex-wrap gap-[6px]">
          <ActionBtn onClick={exportAll} disabled={staging.sessions.length === 0}>
            Export all
          </ActionBtn>
          <ActionBtn onClick={() => fileRef.current?.click()} disabled={busy}>
            Import a bundle
          </ActionBtn>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
            }}
          />
          <Chip
            active={false}
            onClick={() => {
              if (
                staging.sessions.length > 0 &&
                confirm(`Discard ALL ${staging.sessions.length} staged session(s)? Export first if you are unsure.`)
              ) {
                void staging.discardAll()
              }
            }}
          >
            Discard everything
          </Chip>
        </div>
        {note && <p className="mt-[8px] text-[12px] text-text-muted">{note}</p>}
      </Section>
    </div>
  )
}

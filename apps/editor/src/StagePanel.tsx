// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The staged-work surface: what you have staged, what upstream did while you
// were working, and the honest state of Submit.
//
// SUBMIT IS LABELLED HONESTLY. The PR pipeline is subtask 9 and does not exist
// yet, so pressing Submit today records the session as submitted-intent and
// keeps it locally. The button says that in those words. An affordance that
// looks like it opened a PR and did not is worse than no button, because the
// contributor walks away believing their work is somewhere it is not.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionBtn, Chip, Section } from './ui.tsx'
import { foilApi } from './api.ts'
import { navigate } from './router.ts'
import type { Staging } from './staging/useStaging.ts'
import { buildMaskSubmission, isDirty, NotSubmittable } from './staging/session.ts'
import { detectMaskConflict, type ConflictReport } from './staging/conflict.ts'
import { buildBundle, bundleFilename, parseBundle, planImport, BadBundle } from './staging/portable.ts'
import type { MaskSession, StagedSession } from './staging/types.ts'
import { RESOLVER_VERSION } from '@foilkit/resolver'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function title(s: StagedSession): string {
  if (s.kind === 'canon') return `canon · ${s.patternId}`
  return `${s.card?.name ?? s.cardId} · ${s.cardId}/${s.variantId}`
}

export function StagePanel({ staging }: { staging: Staging }): React.ReactElement {
  const [conflicts, setConflicts] = useState<Record<string, ConflictReport>>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const masks = useMemo(
    () => staging.sessions.filter((s): s is MaskSession => s.kind === 'mask'),
    [staging.sessions],
  )

  // Probe upstream for every staged mask, once the list settles. This is the
  // conflict check, and it runs on the STAGED list rather than only at submit
  // so a contributor learns that upstream moved before they spend another hour.
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
      if (!cancelled) setConflicts(next)
    })()
    return () => {
      cancelled = true
    }
  }, [masks])

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

  const submit = async (s: StagedSession) => {
    try {
      if (s.kind === 'mask') buildMaskSubmission(s)
      setNote(
        'Staged and validated. Submission opens PRs once the contribution pipeline ships (subtask 9); ' +
          'until then your session stays here and in your export.',
      )
    } catch (err) {
      setNote(err instanceof NotSubmittable ? `Not ready to submit: ${err.message}` : String(err))
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
                  <ActionBtn onClick={() => void submit(s)} disabled={!isDirty(s)}>
                    Submit
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

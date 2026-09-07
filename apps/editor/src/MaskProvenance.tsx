// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// foil/MaskProvenance.tsx — the workbench's view of mask provenance (sidecar v3).
//
// Two pieces, both phone-first (they live in the 390px single column):
//
//   <MaskProvenanceLine>  a badge + one line under the mask controls: WHO made
//                         this mask, and — on tap — the generator that proposed
//                         it, which of Chey's masks it learned from, and what
//                         he changed when he corrected it.
//   <MaskCorpusPanel>     the corpus at a glance: counts by method, how many
//                         masks a generator is allowed to learn from, the queue
//                         of AI masks awaiting review, and the corrections
//                         recorded so far.
//
// Kept OUT of FoilLab.tsx on purpose: FoilLab is contended (patterns/shader/
// slider work lands there constantly), so the provenance surface is one import
// + two tags there and everything else here.

import { useEffect, useState } from 'react'
import {
  foilApi,
  type FoilCorpusReport,
  type FoilDerivationMethod,
  type FoilMaskSidecar,
  type FoilProvenanceTier,
} from './api.ts'
import { Section } from './ui.tsx'

/** How each method presents itself. Colors carry the review state, not the age. */
const METHOD_STYLE: Record<FoilDerivationMethod, { label: string; short: string; cls: string; blurb: string }> = {
  hand: {
    label: 'Hand-painted',
    short: 'hand',
    cls: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    blurb: 'You painted this from the layout prior. Ground truth — a generator may learn from it.',
  },
  'hand-refined': {
    label: 'Hand-refined',
    short: 'hand-refined',
    cls: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    blurb: 'You painted on top of an existing mask. Ground truth — a generator may learn from it.',
  },
  'ai-corrected': {
    label: 'AI · you corrected it',
    short: 'ai-corrected',
    cls: 'border-sky-400/50 bg-sky-400/15 text-sky-300',
    blurb: 'An AI proposed this and you fixed it. The fix is recorded as training signal (weight 0.6 — anchored by the proposal).',
  },
  ai: {
    label: 'AI · UNREVIEWED',
    short: 'ai',
    cls: 'border-amber-400/60 bg-amber-400/20 text-amber-200',
    blurb: 'A machine proposal nobody has looked at. It can NEVER be an exemplar — correct it to turn it into training signal.',
  },
  'layout-flatten': {
    label: 'Baked window (unpainted)',
    short: 'baked',
    cls: 'border-slate-400/40 bg-slate-400/15 text-slate-300',
    blurb: 'Machine-rasterized geometry — the window rect, no strokes. Not an exemplar: it only teaches the rect the rule already has.',
  },
}

export function MethodBadge({ method, compact = false }: { method: FoilDerivationMethod; compact?: boolean }) {
  const s = METHOD_STYLE[method]
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-[7px] py-[2px] text-[10px] font-semibold uppercase tracking-[0.04em] ${s.cls}`}
      title={s.blurb}
    >
      {compact ? s.short : s.label}
    </span>
  )
}

/**
 * The TIER badge (#10) — a SECOND badge beside the method one, not a colour
 * change to it.
 *
 * They answer different questions and a reader needs both at once. The method
 * badge says what kind of hand made the pixels; this one says whether anybody
 * with the writer capability has signed them off as ground truth. Folding the
 * tier into the method's colour would have made a contributor's hand mask
 * indistinguishable from the owner's at a glance, which is the exact confusion
 * this subtask exists to end — and merging them into one label would suggest
 * the tier demotes the method, when in fact a merged contribution is real,
 * correct-looking, servable data that simply has not been verified for RULE
 * DERIVATION.
 */
const TIER_STYLE: Record<FoilProvenanceTier, { label: string; short: string; cls: string; blurb: string }> = {
  'owner-verified': {
    label: 'Owner-verified',
    short: 'verified',
    cls: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    blurb:
      'A writer authored or verified these pixels. This is the only tier that carries exemplar weight — a generator may derive a rule from it.',
  },
  contributor: {
    label: 'Contributor · unverified',
    short: 'contributor',
    cls: 'border-violet-400/50 bg-violet-400/15 text-violet-200',
    blurb:
      'A contribution that was merged. It is real data — it is served and it renders — but no writer has verified it as ground truth, so it carries exemplar weight 0 until one does. Merge is acceptance, not exemplar grade.',
  },
  unattributed: {
    label: 'Unattributed',
    short: 'unattributed',
    cls: 'border-slate-400/40 bg-slate-400/15 text-slate-300',
    blurb:
      'No human is recorded as the author — machine output, or a record written by something that is not one of the write paths. Exemplar weight 0.',
  },
}

export function TierBadge({ tier, compact = false }: { tier: FoilProvenanceTier; compact?: boolean }) {
  const s = TIER_STYLE[tier]
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-[7px] py-[2px] text-[10px] font-semibold uppercase tracking-[0.04em] ${s.cls}`}
      title={s.blurb}
    >
      {compact ? s.short : s.label}
    </span>
  )
}

const pctOf = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toFixed(3))

/** Where corrections landed, as the sidecar's coarse grid. Tiny by design. */
function CorrectionGrid({ grid }: { grid: { size: number; cells: number[] } }) {
  const max = Math.max(...grid.cells, 0.0001)
  return (
    <div
      className="grid w-[76px] gap-[1px] rounded-[3px] border border-border-default p-[2px]"
      style={{ gridTemplateColumns: `repeat(${grid.size}, minmax(0, 1fr))` }}
      title="Where your corrections concentrate (darker = more changed)"
    >
      {grid.cells.map((c, i) => (
        <div
          key={i}
          className="aspect-square rounded-[1px] bg-sky-400"
          style={{ opacity: 0.12 + 0.88 * (c / max) }}
        />
      ))}
    </div>
  )
}

/**
 * Provenance line for the mask currently on screen. `sidecar` is null while
 * loading or when the mask is unsaved; `liveMethod` lets the caller show what
 * the NEXT save will stamp before it happens.
 */
export function MaskProvenanceLine({
  sidecar,
  aliasOf,
  cardId,
  variantId,
  scope,
  pendingNote,
  canVerify = false,
  onVerified,
}: {
  sidecar: FoilMaskSidecar | null
  aliasOf: number | null
  cardId: string
  variantId: number
  scope: string
  /** e.g. "unsaved strokes — will save as hand-refined". */
  pendingNote?: string | null
  /**
   * Does this viewer hold the writer capability? Offered by the caller, which
   * knows the viewer; NOT a security decision. The server re-derives the answer
   * from the session cookie and refuses a PATCH from anybody else, so this only
   * decides whether the button is on screen.
   */
  canVerify?: boolean
  /** Called after a successful promotion, so the caller can refetch. */
  onVerified?: (s: FoilMaskSidecar) => void
}) {
  const [open, setOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  if (!sidecar) {
    return pendingNote ? <p className="mt-[6px] text-[11px] text-text-muted">{pendingNote}</p> : null
  }
  const g = sidecar.prior.generator ?? sidecar.correction?.parent.generator ?? null
  const c = sidecar.correction ?? null
  const sup = sidecar.supersedes ?? null
  const tier = sidecar.provenanceTier ?? null
  const author = sidecar.author ?? null
  const verification = sidecar.verification ?? null
  // Verifying an `ai` or `layout-flatten` record buys nothing — those are
  // weight 0 in the verified tier too — so the affordance is not offered for
  // them. A button that does nothing is worse than no button.
  const promotable =
    canVerify &&
    tier !== null &&
    tier !== 'owner-verified' &&
    (sidecar.derivation_method === 'hand' ||
      sidecar.derivation_method === 'hand-refined' ||
      sidecar.derivation_method === 'ai-corrected')

  const verify = (): void => {
    setVerifying(true)
    setVerifyError(null)
    void foilApi
      .verifyMask(cardId, variantId)
      .then((s) => onVerified?.(s))
      .catch((e: Error) => setVerifyError(e.message))
      .finally(() => setVerifying(false))
  }

  return (
    <div className="mt-[8px] rounded-md border border-border-default bg-surface-tertiary/50 p-[8px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-[8px] text-left"
        aria-expanded={open}
      >
        <MethodBadge method={sidecar.derivation_method} />
        {tier && <TierBadge tier={tier} compact />}
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
          {new Date(sidecar.savedAt).toLocaleString()}
          {aliasOf != null ? ` · alias of variant ${aliasOf}` : ''}
        </span>
        <span className="shrink-0 text-[11px] text-text-muted">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-[8px] space-y-[8px] border-t border-border-default pt-[8px] text-[11px] leading-[16px] text-text-muted">
          <p>{METHOD_STYLE[sidecar.derivation_method].blurb}</p>

          {tier && (
            <div className="rounded-[4px] border border-border-default p-[6px]">
              <p className="font-semibold text-text-primary">{TIER_STYLE[tier].label}</p>
              <p className="mt-[2px]">{TIER_STYLE[tier].blurb}</p>
              <p className="mt-[4px]">
                {author
                  ? `Authored by @${author.login} (${author.via}).`
                  : `No author recorded — sidecar v${sidecar.version} predates the field.`}
              </p>
              {verification && (
                <p>
                  Verified by @{verification.verifiedBy} on{' '}
                  {new Date(verification.verifiedAt).toLocaleDateString()}
                  {verification.note ? ` — “${verification.note}”` : ''}
                </p>
              )}
              {promotable && (
                <button
                  onClick={verify}
                  disabled={verifying}
                  className="mt-[6px] rounded-[4px] border border-emerald-500/50 bg-emerald-500/15 px-[8px] py-[3px] text-[11px] font-semibold text-emerald-300 disabled:opacity-50"
                  title="Records your verification in the sidecar and commits it. Only the .json changes — the pixels are untouched."
                >
                  {verifying ? 'Verifying…' : 'Verify as exemplar-grade'}
                </button>
              )}
              {verifyError && <p className="mt-[4px] text-amber-300">{verifyError}</p>}
            </div>
          )}

          <p className="tabular-nums">
            vs era rule: agreement {pctOf(sidecar.diff?.agreement)} · +{sidecar.diff?.addedPx ?? 0}px / −
            {sidecar.diff?.removedPx ?? 0}px · sidecar v{sidecar.version} · prior source “{sidecar.prior.source}”
          </p>

          {g && (
            <div className="rounded-[4px] border border-border-default p-[6px]">
              <p className="font-semibold text-text-primary">
                Generated by {g.name}@{g.version}
                {g.modelId ? ` · ${g.modelId}` : ''}
              </p>
              <p className="tabular-nums">
                run {g.runId} · confidence {g.confidence === null ? 'none emitted' : g.confidence}
              </p>
              <p className="mt-[4px]">
                Learned from {g.exemplars.length} human mask{g.exemplars.length === 1 ? '' : 's'}:
              </p>
              <ul className="ml-[12px] list-disc">
                {g.exemplars.map((e) => (
                  <li key={`${e.cardId}-${e.variantId}`} className="tabular-nums">
                    {e.cardId}/{e.variantId} · {e.method} · weight {e.weight}
                  </li>
                ))}
                {g.exemplars.length === 0 && <li>none — it learned from nothing</li>}
              </ul>
            </div>
          )}

          {sup && (
            <div className="rounded-[4px] border border-amber-400/40 bg-amber-400/10 p-[6px]">
              <p className="font-semibold text-amber-200">
                This REPLACED your {sup.parent.method} mask — you have not agreed to it yet
              </p>
              <div className="mt-[4px] flex items-start gap-[8px]">
                <CorrectionGrid grid={sup.grid} />
                <p className="tabular-nums">
                  agreement with what you drew {sup.agreement} · +{sup.addedPx}px added / −{sup.removedPx}px removed ·{' '}
                  {(sup.changedFraction * 100).toFixed(2)}% of the face changed
                </p>
              </div>
              <div className="mt-[6px] flex gap-[6px]">
                <a
                  className="underline"
                  href={foilApi.maskArtifactUrl(cardId, variantId, 'parent')}
                  target="_blank"
                  rel="noreferrer"
                >
                  your original
                </a>
                <a
                  className="underline"
                  href={foilApi.maskArtifactUrl(cardId, variantId, 'parent-diff')}
                  target="_blank"
                  rel="noreferrer"
                >
                  change map
                </a>
              </div>
              <p className="mt-[6px] break-all">
                Undo, byte-for-byte (archived at <code>{sup.archiveDir}</code>):
                <br />
                <code className="text-text-primary">
                  pnpm --filter deckscout-api exec tsx src/foil/generate-masks.ts revert --run-id {sup.runId}
                </code>
              </p>
            </div>
          )}

          {c && (
            <div className="rounded-[4px] border border-sky-400/30 bg-sky-400/5 p-[6px]">
              <p className="font-semibold text-text-primary">
                Your correction of the previous mask ({c.parent.method})
              </p>
              <div className="mt-[4px] flex items-start gap-[8px]">
                <CorrectionGrid grid={c.grid} />
                <p className="tabular-nums">
                  agreement with what you started from {c.agreement} · +{c.addedPx}px added / −{c.removedPx}px removed ·{' '}
                  {(c.changedFraction * 100).toFixed(2)}% of the face changed
                </p>
              </div>
              <div className="mt-[6px] flex gap-[6px]">
                <a
                  className="underline"
                  href={foilApi.maskArtifactUrl(cardId, variantId, 'parent')}
                  target="_blank"
                  rel="noreferrer"
                >
                  before
                </a>
                <a
                  className="underline"
                  href={foilApi.maskArtifactUrl(cardId, variantId, 'parent-diff')}
                  target="_blank"
                  rel="noreferrer"
                >
                  change map
                </a>
                <a
                  className="underline"
                  href={foilApi.maskArtifactUrl(cardId, variantId, 'diff')}
                  target="_blank"
                  rel="noreferrer"
                >
                  vs era rule
                </a>
              </div>
            </div>
          )}

          {sidecar.lineage && sidecar.lineage.length > 1 && (
            <p>
              lineage:{' '}
              {sidecar.lineage
                .map((l) => l.method + (l.generator ? ` (${l.generator.name}@${l.generator.version})` : ''))
                .join(' → ')}
            </p>
          )}
          {pendingNote && <p className="text-amber-300">{pendingNote}</p>}
        </div>
      )}
      {!open && pendingNote && <p className="mt-[4px] text-[11px] text-amber-300">{pendingNote}</p>}
    </div>
  )
}

// ── Corpus at a glance ─────────────────────────────────────────────────────

const METHOD_ORDER: FoilDerivationMethod[] = ['hand', 'hand-refined', 'ai-corrected', 'ai', 'layout-flatten']

export function MaskCorpusPanel({
  available,
  refreshKey,
  onPick,
}: {
  available: boolean
  /** Bump to refetch after a save. */
  refreshKey: number
  onPick?: (cardId: string, variantId: number) => void
}) {
  const [report, setReport] = useState<FoilCorpusReport | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!available || !open) return
    const ac = new AbortController()
    void foilApi.maskCorpus(ac.signal).then((r) => setReport(r))
    return () => ac.abort()
  }, [available, open, refreshKey])

  if (!available) return null
  return (
    <Section title="Mask corpus">
      <button onClick={() => setOpen((o) => !o)} className="mb-[8px] w-full text-left text-[12px] text-text-muted">
        {open ? '▲ hide' : '▼ show'} provenance report
        {report ? ` — ${report.total} mask${report.total === 1 ? '' : 's'}` : ''}
      </button>
      {open && !report && <p className="text-[11px] text-text-muted">Loading…</p>}
      {open && report && (
        <div className="space-y-[10px] text-[11px] leading-[16px] text-text-muted">
          <div className="flex flex-wrap gap-[6px]">
            {METHOD_ORDER.filter((m) => report.byMethod[m] > 0).map((m) => (
              <span key={m} className="flex items-center gap-[4px]">
                <MethodBadge method={m} compact />
                <span className="tabular-nums text-text-primary">{report.byMethod[m]}</span>
              </span>
            ))}
            {report.total === 0 && <span>No masks yet.</span>}
          </div>

          <div className="flex flex-wrap gap-[6px]">
            {(['owner-verified', 'contributor', 'unattributed'] as const)
              .filter((t) => (report.byTier?.[t] ?? 0) > 0)
              .map((t) => (
                <span key={t} className="flex items-center gap-[4px]">
                  <TierBadge tier={t} compact />
                  <span className="tabular-nums text-text-primary">{report.byTier[t]}</span>
                </span>
              ))}
            {(report.byTier?.unstated ?? 0) > 0 && (
              <span className="tabular-nums">tier not stated {report.byTier.unstated}</span>
            )}
          </div>

          <p className="tabular-nums">
            mean agreement vs the era rule: <span className="text-text-primary">{pctOf(report.meanAgreement)}</span> ·
            exemplars a generator may learn from:{' '}
            <span className="text-text-primary">{report.exemplarsAvailable.total}</span>
          </p>
          <p className="text-[10px]">
            Unreviewed <code>ai</code> masks are never exemplars — that is the anti-feedback-collapse rule, enforced in
            selection code, not by convention. Neither is a contribution nobody with the writer capability has verified:
            exemplar weight is keyed on (method × tier), and merge is acceptance rather than exemplar grade.
          </p>

          {(report.awaitingVerification?.length ?? 0) > 0 && (
            <div>
              <p className="font-semibold text-text-primary">
                awaiting verification ({report.awaitingVerification.length})
              </p>
              <p className="text-[10px]">
                Human work already merged, held at exemplar weight 0 until a writer signs it off. Open one and use
                “Verify as exemplar-grade”.
              </p>
              {report.awaitingVerification.map((a) => (
                <button
                  key={`${a.cardId}-${a.variantId}`}
                  onClick={() => onPick?.(a.cardId, a.variantId)}
                  className="block w-full text-left tabular-nums underline decoration-dotted hover:text-text-primary"
                >
                  {a.cardId}/{a.variantId} · {a.method} · {a.author ? `@${a.author}` : 'author unrecorded'} · vs-rule{' '}
                  {pctOf(a.agreement)}
                </button>
              ))}
            </div>
          )}

          {Object.keys(report.byEra).length > 0 && (
            <div>
              <p className="font-semibold text-text-primary">by era</p>
              {Object.entries(report.byEra).map(([k, b]) => (
                <p key={k} className="tabular-nums">
                  {k}: n={b.n} · agree {pctOf(b.meanAgreement)} ·{' '}
                  {Object.entries(b.byMethod)
                    .filter(([, v]) => v)
                    .map(([m, v]) => `${m} ${v}`)
                    .join(', ')}
                </p>
              ))}
            </div>
          )}
          {report.bySet === null ? (
            <div>
              <p className="font-semibold text-text-primary">by set</p>
              {/*
                NOT MEASURED HERE, and it says so rather than showing a zero.
                Grouping the corpus by set needs a catalog join, and this report
                is derived from the corpus manifest — a local file walk with no
                catalog in it. A number nobody took is worse than an absence.
              */}
              <p>Not measured on the hosted editor — a set breakdown needs a catalog join.</p>
            </div>
          ) : (
            Object.keys(report.bySet).length > 0 && (
              <div>
                <p className="font-semibold text-text-primary">by set</p>
                {Object.entries(report.bySet).map(([k, b]) => (
                  <p key={k} className="tabular-nums">
                    {k}: n={b.n} · agree {pctOf(b.meanAgreement)}
                  </p>
                ))}
              </div>
            )
          )}

          <div>
            <p className="font-semibold text-text-primary">
              awaiting review ({report.awaitingReview.length})
            </p>
            {report.awaitingReview.length === 0 && <p>Nothing queued.</p>}
            {report.awaitingReview.map((a) => (
              <button
                key={`${a.cardId}-${a.variantId}`}
                onClick={() => onPick?.(a.cardId, a.variantId)}
                className="block w-full text-left tabular-nums underline decoration-dotted hover:text-text-primary"
              >
                {a.cardId}/{a.variantId} · {a.generator ? `${a.generator.name}@${a.generator.version}` : 'no id'} · conf{' '}
                {a.confidence ?? '—'} · vs-rule {pctOf(a.agreement)}
              </button>
            ))}
          </div>

          <div>
            <p className="font-semibold text-text-primary">
              corrections recorded {report.corrections === null ? '' : `(${report.corrections.n})`}
            </p>
            {report.corrections === null && (
              // Same rule as `bySet`: the correction blocks live inside each
              // sidecar, and the manifest does not carry them. Saying "0" would
              // be a measurement nobody took.
              <p>Not measured on the hosted editor — a correction census reads every sidecar.</p>
            )}
            {report.corrections?.n === 0 && (
              <p>None yet — correct an AI mask to create the first training pair.</p>
            )}
            {(report.corrections?.entries ?? []).map((c) => (
              <p key={`${c.cardId}-${c.variantId}-${c.savedAt}`} className="tabular-nums">
                {c.cardId}/{c.variantId} · fixed a {c.parentMethod}
                {c.generator ? ` (${c.generator})` : ''} · agree {c.agreement} · +{c.addedPx}/−{c.removedPx}px
              </p>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

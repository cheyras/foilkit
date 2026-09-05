// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The answer to a submission, on screen.
//
// ITS OWN FILE BECAUSE THERE ARE TWO CALLERS. `StagePanel` renders it under
// every staged row, and `FoilLab`/`CanonLab` render it under a writer's "Open
// as PR instead". Those are the same five outcomes and must read the same way —
// a writer who is told something different from what a contributor is told is a
// writer who cannot debug the contributor's report.

import type { SubmissionResult } from './staging/submit.ts'
import type { ViewerState } from './writer/useViewer.ts'

/**
 * What happened when this session was submitted.
 *
 * FIVE STATES, and none of them share a sentence. The reason to spell them out
 * separately rather than render `result.message` into one box is that a
 * contributor's next action is different in every case, and a box that always
 * looks the same trains people not to read it.
 */
export function SubmitOutcome({
  state,
  viewer,
}: {
  state: { busy: boolean; result: SubmissionResult | null } | undefined
  viewer: ViewerState
}): React.ReactElement | null {
  const result = state?.result
  if (result === undefined || result === null) return null

  if (result.ok) {
    if (result.pr === null) {
      // Byte-identical to upstream. Not a failure and not a pull request — the
      // work is already there, which is worth saying rather than leaving the
      // contributor to wonder where their PR went.
      return (
        <p className="mt-[8px] rounded border border-border-default bg-surface-secondary p-[8px] text-[12px] text-text-muted">
          {result.message ?? 'Nothing to review — this session matches what is already upstream.'}
        </p>
      )
    }
    return (
      <div className="mt-[8px] rounded border border-emerald-500/50 bg-emerald-500/10 p-[8px] text-[12px] text-emerald-200">
        <p>
          {result.pr.updated ? 'Updated' : 'Opened'}{' '}
          <a className="underline hover:text-emerald-100" href={result.pr.url} target="_blank" rel="noreferrer">
            pull request #{result.pr.number}
          </a>
          . Your name is on it as a co-author, and the CC0 dedication is in the body.
        </p>
        <p className="mt-[4px] text-emerald-300/80">
          The render evidence — an 8-frame tilt sweep — is rendered by a workflow and posted as a comment there
          shortly. Your session stays here; submitting again updates the same pull request.
        </p>
      </div>
    )
  }

  if (result.kind === 'sign-in') {
    return (
      <p className="mt-[8px] rounded border border-sky-500/50 bg-sky-500/10 p-[8px] text-[12px] text-sky-200">
        A pull request is opened in your name, so it needs a GitHub sign-in.{' '}
        <a className="underline hover:text-sky-100" href={viewer.signInUrl}>
          Sign in
        </a>{' '}
        and press Submit again — nothing is lost in the meantime.
      </p>
    )
  }

  if (result.kind === 'not-configured') {
    return (
      <div className="mt-[8px] rounded border border-amber-500/50 bg-amber-500/10 p-[8px] text-[12px] text-amber-200">
        <p>{result.message}</p>
        {result.missing.length > 0 && (
          <p className="mt-[4px] text-amber-300/80">
            Missing on this deployment: <code>{result.missing.join(', ')}</code>
          </p>
        )}
        <p className="mt-[4px] text-amber-300/80">
          Your session is untouched. Export it if you want it somewhere other than this browser.
        </p>
      </div>
    )
  }

  if (result.kind === 'invalid') {
    return (
      <div className="mt-[8px] rounded border border-rose-500/50 bg-rose-500/10 p-[8px] text-[12px] text-rose-200">
        <p>Not ready to submit — checked before anything was pushed, so nothing was opened.</p>
        <ul className="mt-[6px] flex list-disc flex-col gap-[2px] pl-[16px]">
          {(result.failures.length > 0 ? result.failures : [result.message]).map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
        {result.checks.length > 0 && (
          <details className="mt-[6px]">
            <summary className="cursor-pointer text-rose-300/80">Everything that was checked</summary>
            <ul className="mt-[4px] flex flex-col gap-[2px]">
              {result.checks.map((c) => (
                <li key={c.name} className={c.ok ? 'text-text-muted' : 'text-rose-200'}>
                  {c.ok ? '✅' : '❌'} {c.detail}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    )
  }

  return (
    <p className="mt-[8px] rounded border border-rose-500/50 bg-rose-500/10 p-[8px] text-[12px] text-rose-200">
      {result.message} Your session is untouched — try again in a moment.
    </p>
  )
}

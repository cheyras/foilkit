// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The shell. Four surfaces, one staging store, one viewer identity.
//
// The staging store and the viewer live HERE rather than inside each surface,
// because a session is not a property of the screen you happened to be on when
// you made it — you can stage a mask, walk to the canon lab, come back, and
// find it. Hoisting them is what makes that true.

import { Suspense, lazy } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Queue } from './Queue.tsx'
import { StagePanel } from './StagePanel.tsx'
import { SurfaceTabs } from './ui.tsx'
import { surfaceOf, useLocation } from './router.ts'
import { useStaging } from './staging/useStaging.ts'
import { useViewer } from './writer/useViewer.ts'

// The two lab surfaces pull in three.js and 3,462 lines of pattern recipes.
// The queue is the landing screen and must not wait for a renderer to arrive.
const FoilLab = lazy(() => import('./FoilLab.tsx').then((m) => ({ default: m.FoilLab })))
const CanonLab = lazy(() => import('./CanonLab.tsx').then((m) => ({ default: m.CanonLab })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Every read is a static file behind an immutable CDN header. Refetching
      // one because a window regained focus is pure waste.
      refetchOnWindowFocus: false,
      staleTime: 5 * 60_000,
      retry: 1,
    },
  },
})

function Loading(): React.ReactElement {
  return <p className="p-[16px] text-[13px] text-text-muted">Loading the workbench…</p>
}

function Shell(): React.ReactElement {
  const path = useLocation()
  const surface = surfaceOf(path)
  const staging = useStaging()
  const viewer = useViewer()

  return (
    <div className="min-h-full bg-surface-primary text-text-primary">
      <header className="flex flex-wrap items-baseline justify-between gap-[8px] border-b border-border-default px-[12px] py-[8px]">
        <div>
          <span className="text-[14px] font-semibold">foilkit</span>
          <span className="ml-[8px] text-[12px] text-text-muted">contribution editor</span>
        </div>
        <div className="flex items-center gap-[10px] text-[12px]">
          {staging.sessions.length > 0 && (
            <a href="/staged" className="text-action-primary" onClick={(e) => { e.preventDefault(); history.pushState(null, '', '/staged'); dispatchEvent(new PopStateEvent('popstate')) }}>
              {staging.sessions.length} staged
            </a>
          )}
          {viewer.viewer === null ? (
            // Sign-in is offered, never required. Read is fully public and so
            // is staging; this link exists for the two people who can write
            // directly and for whoever eventually submits a PR.
            <a className="text-text-muted hover:text-text-primary" href={viewer.signInUrl}>
              Sign in
            </a>
          ) : (
            <span className="text-text-muted">
              {viewer.viewer.login}
              {viewer.viewer.writer && <span className="ml-[6px] text-action-primary">writer</span>}{' '}
              <a className="ml-[6px] hover:text-text-primary" href={viewer.signOutUrl}>
                sign out
              </a>
            </span>
          )}
        </div>
      </header>

      <Suspense fallback={<Loading />}>
        {surface === 'queue' && <Queue staging={staging} />}
        {surface === 'card' && <FoilLab staging={staging} viewer={viewer} />}
        {surface === 'canon' && <CanonLab staging={staging} viewer={viewer} />}
        {surface === 'staged' && (
          <div className="mx-auto flex max-w-[900px] flex-col gap-[12px] p-[12px]">
            <SurfaceTabs active="queue" />
            <StagePanel staging={staging} />
          </div>
        )}
      </Suspense>
    </div>
  )
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  )
}

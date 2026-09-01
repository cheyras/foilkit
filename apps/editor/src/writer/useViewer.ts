// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Who is looking, and what happens when they press Save.
//
// READ IS FULLY PUBLIC. No login to browse, no login to open a card, no login
// to look at a canon, no login to draw a mask and stage it. Sign-in exists only
// at Submit and at direct write — a contributor can do a full session of work
// and only authenticate when they hand it over. So this hook resolving to
// `null` is the NORMAL state, not a degraded one, and nothing in the editor may
// treat it as an error.

import { useEffect, useState } from 'react'
import { savePathFor, type SavePath, type Viewer } from './capability.ts'

export interface ViewerState {
  viewer: Viewer | null
  loading: boolean
  savePath: SavePath
  /** Where to send the browser to sign in, preserving where they were. */
  signInUrl: string
  signOutUrl: string
}

export function useViewer(): ViewerState {
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/me', { credentials: 'same-origin', signal: ac.signal })
        // 401 and 404 mean the same thing to this editor: nobody is signed in
        // here. 404 in particular is the state a `vite dev` run is always in,
        // because the functions are not running — and that has to look like
        // "signed out", not like a broken build.
        if (res.ok) {
          const body = (await res.json()) as Partial<Viewer>
          if (typeof body.login === 'string') {
            setViewer({
              login: body.login,
              name: body.name ?? null,
              avatarUrl: body.avatarUrl ?? null,
              writer: body.writer === true,
            })
          }
        }
      } catch {
        /* signed out; see above */
      } finally {
        setLoading(false)
      }
    })()
    return () => ac.abort()
  }, [])

  const here = typeof location === 'undefined' ? '/' : location.pathname + location.search
  return {
    viewer,
    loading,
    savePath: savePathFor(viewer),
    signInUrl: `/api/auth/start?return=${encodeURIComponent(here)}`,
    signOutUrl: `/api/auth/signout?return=${encodeURIComponent(here)}`,
  }
}

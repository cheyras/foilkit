// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The staging layer, as a React hook.
//
// Thin on purpose: every rule worth arguing about lives in the pure modules
// next door and is tested without a browser. This is the part that owns a store
// handle and a piece of component state, and nothing else.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createSessionStore, type SessionStore } from './store.ts'
import type { MaskSession, StagedSession } from './types.ts'

export interface Staging {
  /** Every staged session, newest-updated first. */
  sessions: StagedSession[]
  /** False when IndexedDB was unavailable — work will not survive a reload. */
  durable: boolean
  loading: boolean
  save(session: StagedSession): Promise<void>
  discard(id: string): Promise<void>
  discardAll(): Promise<void>
  get(id: string): StagedSession | null
  reload(): Promise<void>
  store: SessionStore
}

export function useStaging(): Staging {
  const handle = useRef<{ store: SessionStore; durable: boolean } | null>(null)
  handle.current ??= createSessionStore()
  const { store, durable } = handle.current

  const [sessions, setSessions] = useState<StagedSession[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setSessions(await store.list())
    setLoading(false)
  }, [store])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (session: StagedSession) => {
      await store.put(session)
      // Optimistic and authoritative at once: the list is small, so re-reading
      // it is cheaper than reasoning about whether the local copy is right.
      await reload()
    },
    [store, reload],
  )

  const discard = useCallback(
    async (id: string) => {
      await store.delete(id)
      await reload()
    },
    [store, reload],
  )

  const discardAll = useCallback(async () => {
    await store.clear()
    await reload()
  }, [store, reload])

  const get = useCallback((id: string) => sessions.find((s) => s.id === id) ?? null, [sessions])

  return { sessions, durable, loading, save, discard, discardAll, get, reload, store }
}

/** Narrowing helper — the two session kinds share a store and nothing else. */
export function maskSessions(sessions: StagedSession[]): MaskSession[] {
  return sessions.filter((s): s is MaskSession => s.kind === 'mask')
}

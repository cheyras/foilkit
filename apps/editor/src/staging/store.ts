// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Where a session lives between visits.
//
// SIZED AGAINST UNDO, NOT AGAINST MASKS. Mask PNGs average 7.7 KB — the whole
// current corpus of 96 of them is 738 KB, which localStorage would hold
// comfortably. That was never the constraint. The thing that blows past it is
// the undo stack: `MaskEditor` keeps 12 ImageData snapshots at canonical
// raster, ~1.4 MB each, ~16 MB per card. IndexedDB is still the right call —
// binary-friendly, asynchronous, quota measured in hundreds of megabytes — but
// the design decision it forced was to NOT PERSIST UNDO. Current pixels, the
// seed, and the parent sha. That is the whole record.
//
// The store is an interface with two implementations so the session logic is
// testable without a browser: `idbSessionStore()` in the app, `memorySessionStore()`
// in the tests. Nothing above this file knows which one it has.

import type { StagedSession } from './types.ts'

export interface SessionStore {
  list(): Promise<StagedSession[]>
  get(id: string): Promise<StagedSession | null>
  put(session: StagedSession): Promise<void>
  delete(id: string): Promise<void>
  /** Explicit discard of everything. Never called without a confirmation. */
  clear(): Promise<void>
}

export const DB_NAME = 'foilkit-staging'
export const DB_VERSION = 1
export const STORE_NAME = 'sessions'

/** In-memory store — the test double, and the fallback when IndexedDB is
 *  unavailable (private browsing on some engines). A session that survives only
 *  the tab is still better than an editor that refuses to open, but the caller
 *  is told, because "your work will not survive a reload" is not a detail. */
export function memorySessionStore(seed: StagedSession[] = []): SessionStore {
  const map = new Map<string, StagedSession>(seed.map((s) => [s.id, s]))
  return {
    async list() {
      return [...map.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    },
    async get(id) {
      return map.get(id) ?? null
    },
    async put(session) {
      map.set(session.id, session)
    },
    async delete(id) {
      map.delete(id)
    },
    async clear() {
      map.clear()
    },
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    // A blocked upgrade means another tab holds the old version. Surfacing it
    // is better than hanging forever on a promise nobody resolves.
    req.onblocked = () => reject(new Error('another tab is holding an older version of the staging database'))
  })
}

function run<T>(store: IDBObjectStore, req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'))
    void store
  })
}

export function idbSessionStore(): SessionStore {
  async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await open()
    try {
      const t = db.transaction(STORE_NAME, mode)
      const result = await fn(t.objectStore(STORE_NAME))
      await new Promise<void>((resolve, reject) => {
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error ?? new Error('transaction failed'))
        t.onabort = () => reject(t.error ?? new Error('transaction aborted'))
      })
      return result
    } finally {
      db.close()
    }
  }

  return {
    list: () =>
      tx('readonly', async (s) => {
        const all = await run(s, s.getAll() as IDBRequest<StagedSession[]>)
        return all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      }),
    get: (id) => tx('readonly', async (s) => (await run(s, s.get(id) as IDBRequest<StagedSession | undefined>)) ?? null),
    put: (session) =>
      tx('readwrite', async (s) => {
        await run(s, s.put(session) as IDBRequest<IDBValidKey>)
      }),
    delete: (id) =>
      tx('readwrite', async (s) => {
        await run(s, s.delete(id) as IDBRequest<undefined>)
      }),
    clear: () =>
      tx('readwrite', async (s) => {
        await run(s, s.clear() as IDBRequest<undefined>)
      }),
  }
}

/**
 * Pick a store. IndexedDB when it is there, memory when it is not, and the
 * caller always learns which — an editor that silently loses a session on
 * reload is worse than one that says up front that it will.
 */
export function createSessionStore(): { store: SessionStore; durable: boolean } {
  const hasIdb = typeof indexedDB !== 'undefined' && indexedDB !== null
  return hasIdb ? { store: idbSessionStore(), durable: true } : { store: memorySessionStore(), durable: false }
}

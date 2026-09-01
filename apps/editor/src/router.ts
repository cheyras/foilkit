// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The whole router.
//
// Three surfaces and a deep link into a card. A routing library would be more
// code than the thing it routes, and the workbench's own navigation was two
// `<Link>`s. This is a pushState, a popstate listener, and a subscription —
// which is the entire requirement, and it is honest about being that.
//
// Real paths rather than a hash, because Vercel rewrites everything to
// index.html anyway (see vercel.json) and a shareable `/card?id=base1-4` is
// worth having: "look at this card" is a message people send each other.

import { useSyncExternalStore } from 'react'

export type Surface = 'queue' | 'card' | 'canon' | 'staged'

const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', emit)
}

export function navigate(to: string, replace = false): void {
  if (typeof window === 'undefined') return
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  emit()
  // A surface change should start at the top; the previous surface's scroll
  // position is meaningless on the next one.
  window.scrollTo(0, 0)
}

/** Change the query string without adding a history entry — selection state. */
export function setParam(key: string, value: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(location.href)
  if (value === null) url.searchParams.delete(key)
  else url.searchParams.set(key, value)
  history.replaceState(null, '', `${url.pathname}${url.search}`)
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function snapshot(): string {
  return typeof window === 'undefined' ? '/' : location.pathname + location.search
}

export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '/')
}

export function surfaceOf(path: string): Surface {
  const p = path.split('?')[0] ?? '/'
  if (p.startsWith('/card')) return 'card'
  if (p.startsWith('/canon')) return 'canon'
  if (p.startsWith('/staged')) return 'staged'
  return 'queue'
}

export function paramOf(path: string, key: string): string | null {
  const q = path.indexOf('?')
  if (q < 0) return null
  return new URLSearchParams(path.slice(q)).get(key)
}

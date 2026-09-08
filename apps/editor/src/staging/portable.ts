// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Export / import — a session bundle as a file.
//
// This is not a nicety. There is no account before Submit, so a browser is the
// only place a session exists, and a file is therefore the ONLY bridge between
// an unsigned-in contributor's two devices. It is also the answer to "my work
// is trapped in this browser", which is a real thing to be afraid of when the
// browser is the database.
//
// The bundle is plain JSON with the PNGs inline as data URLs. Not a zip: a
// contributor should be able to open the file, see that it contains their own
// work and nothing else, and mail it to somebody. The size is fine — sessions
// hold current pixels only (~7.7 KB per mask), because the undo stack is
// deliberately not persisted.

import { SESSION_VERSION, type StagedSession } from './types.ts'

export const BUNDLE_KIND = 'foilkit.staged-sessions' as const
export const BUNDLE_VERSION = 1 as const

export interface SessionBundle {
  kind: typeof BUNDLE_KIND
  bundleVersion: typeof BUNDLE_VERSION
  exportedAt: string
  /** Which build wrote it — a bundle from a much older editor is a real case. */
  editor: { resolverVersion: number | null; buildId: string | null }
  sessions: StagedSession[]
}

export function buildBundle(
  sessions: StagedSession[],
  meta: { now: string; resolverVersion: number | null; buildId: string | null },
): SessionBundle {
  return {
    kind: BUNDLE_KIND,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: meta.now,
    editor: { resolverVersion: meta.resolverVersion, buildId: meta.buildId },
    // Sorted so two exports of the same work are the same file — a diffable
    // export is a debuggable one.
    sessions: [...sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

export class BadBundle extends Error {}

/**
 * Parse a bundle, refusing anything it cannot vouch for.
 *
 * Import is the one place where data the editor did not create becomes a
 * session it will later submit as a provenance record. Being strict here is
 * not fussiness: a malformed seed that survives import becomes a wrong parent
 * in a correction record, which is exactly the kind of quiet lie the whole
 * provenance model exists to prevent.
 */
export function parseBundle(text: string): SessionBundle {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BadBundle('not JSON')
  }
  if (typeof raw !== 'object' || raw === null) throw new BadBundle('not an object')
  const b = raw as Partial<SessionBundle>
  if (b.kind !== BUNDLE_KIND) throw new BadBundle(`not a foilkit session bundle (kind: ${String(b.kind)})`)
  if (b.bundleVersion !== BUNDLE_VERSION) {
    throw new BadBundle(`bundle version ${String(b.bundleVersion)} — this editor writes and reads version ${BUNDLE_VERSION}`)
  }
  if (!Array.isArray(b.sessions)) throw new BadBundle('no sessions array')

  const sessions: StagedSession[] = []
  for (const [i, s] of b.sessions.entries()) {
    sessions.push(validateSession(s, `sessions[${i}]`))
  }
  return {
    kind: BUNDLE_KIND,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : new Date(0).toISOString(),
    editor: {
      resolverVersion: typeof b.editor?.resolverVersion === 'number' ? b.editor.resolverVersion : null,
      buildId: typeof b.editor?.buildId === 'string' ? b.editor.buildId : null,
    },
    sessions,
  }
}

function validateSession(raw: unknown, where: string): StagedSession {
  if (typeof raw !== 'object' || raw === null) throw new BadBundle(`${where} is not an object`)
  const s = raw as Record<string, unknown>
  if (s.version !== SESSION_VERSION) throw new BadBundle(`${where}: session version ${String(s.version)}`)
  if (typeof s.id !== 'string' || s.id.length === 0) throw new BadBundle(`${where}: no id`)
  if (typeof s.createdAt !== 'string' || typeof s.updatedAt !== 'string') throw new BadBundle(`${where}: no timestamps`)

  if (s.kind === 'mask') {
    if (typeof s.cardId !== 'string' || typeof s.variantId !== 'number') throw new BadBundle(`${where}: bad card ref`)
    if (s.id !== `mask:${s.cardId}:${s.variantId}`) throw new BadBundle(`${where}: id does not match its card ref`)
    const seed = s.seed as Record<string, unknown> | undefined
    if (typeof seed !== 'object' || seed === null) throw new BadBundle(`${where}: no seed`)
    if (seed.startedFrom !== 'layout' && seed.startedFrom !== 'window-bake' && seed.startedFrom !== 'mask') {
      throw new BadBundle(`${where}: seed.startedFrom is ${String(seed.startedFrom)}`)
    }
    if (typeof seed.prior !== 'object' || seed.prior === null) throw new BadBundle(`${where}: seed has no prior`)
    if (s.png !== null && typeof s.png !== 'string') throw new BadBundle(`${where}: png is neither null nor a data URL`)
    if (typeof s.png === 'string' && !s.png.startsWith('data:image/png;base64,')) {
      // A remote URL here would make an import fetch something on submit, which
      // is a different and much worse thing than importing a file.
      throw new BadBundle(`${where}: png must be an inline data:image/png URL`)
    }
    if (typeof s.width !== 'number' || typeof s.height !== 'number') throw new BadBundle(`${where}: no raster size`)
    // The pen's geometry, when the bundle carries any. Checked to the same standard as the
    // seed and for the same reason the file header gives: an import is where data the editor
    // did not create becomes a record it will later submit. A malformed path list that
    // survived import would reach `/api/contribute`, be rasterised there, and be REFUSED for
    // disagreeing with its own pixels — a correct refusal with an unhelpful message, arriving
    // one network round trip and one sign-in after the point where the file could have been
    // named. `null` is allowed and means "this mask has no paths", which is what a brush
    // session says out loud after painting over a pen-authored one.
    if (s.vector !== undefined && s.vector !== null) validateVector(s.vector, `${where}.vector`)
    return raw as StagedSession
  }

  if (s.kind === 'canon') {
    if (typeof s.patternId !== 'string') throw new BadBundle(`${where}: no patternId`)
    if (s.id !== `canon:${s.patternId}`) throw new BadBundle(`${where}: id does not match its patternId`)
    if (typeof s.uniforms !== 'object' || s.uniforms === null) throw new BadBundle(`${where}: no uniforms`)
    return raw as StagedSession
  }

  throw new BadBundle(`${where}: unknown session kind ${String(s.kind)}`)
}

/**
 * The mask vector's SHAPE, checked shallowly and on purpose.
 *
 * DELIBERATELY NOT A SECOND PARSER. `parseMaskVector` in `@foilkit/forge` is the authority on
 * what a path list is, it runs server-side on every submission, and re-implementing it here
 * would fork the format — two definitions of a committed artifact, drifting apart the first
 * time one of them is fixed. So this checks only the envelope: the version the editor can
 * actually edit, a raster the canvas can actually be sized to, and paths that are paths. A
 * primitive that is malformed INSIDE that envelope is caught by the real parser, which is also
 * the thing that can say something useful about it.
 *
 * What it buys is the failure that would otherwise be silent: a bundle from a future build,
 * whose vector this editor would load, render as an empty document, and then submit — quietly
 * throwing away the geometry it could not understand.
 */
function validateVector(raw: unknown, where: string): void {
  if (typeof raw !== 'object' || raw === null) throw new BadBundle(`${where} is not an object`)
  const v = raw as Record<string, unknown>
  if (v.version !== 1) {
    throw new BadBundle(`${where}: vector version ${String(v.version)} — this editor reads version 1`)
  }
  const space = v.space as Record<string, unknown> | undefined
  if (
    typeof space !== 'object' ||
    space === null ||
    typeof space.width !== 'number' ||
    typeof space.height !== 'number' ||
    space.width <= 0 ||
    space.height <= 0
  ) {
    throw new BadBundle(`${where}: space must be { width, height } in pixels`)
  }
  if (!Array.isArray(v.paths) || v.paths.length === 0) throw new BadBundle(`${where}: paths must be a non-empty array`)
  for (const [i, p] of v.paths.entries()) {
    if (typeof p !== 'object' || p === null) throw new BadBundle(`${where}.paths[${i}] is not an object`)
    const path = p as Record<string, unknown>
    if (!Array.isArray(path.start) || path.start.length !== 2) {
      throw new BadBundle(`${where}.paths[${i}]: start must be two numbers`)
    }
    if (!Array.isArray(path.prims) || path.prims.length === 0) {
      throw new BadBundle(`${where}.paths[${i}]: prims must be a non-empty array`)
    }
  }
}

/** What an import would do, decided before anything is written. */
export interface ImportPlan {
  add: StagedSession[]
  /** Same id on both sides. The human chooses; nothing is merged. */
  collide: { incoming: StagedSession; existing: StagedSession }[]
}

export function planImport(incoming: StagedSession[], existing: StagedSession[]): ImportPlan {
  const byId = new Map(existing.map((s) => [s.id, s]))
  const plan: ImportPlan = { add: [], collide: [] }
  for (const s of incoming) {
    const hit = byId.get(s.id)
    if (hit) plan.collide.push({ incoming: s, existing: hit })
    else plan.add.push(s)
  }
  return plan
}

export function bundleFilename(now: string): string {
  return `foilkit-sessions-${now.replace(/[:.]/g, '-')}.json`
}

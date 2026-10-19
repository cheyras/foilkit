// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The human etch record: data/foil-etches/<cardId>/<variantId>.json, plus an
// optional baked plate (<variantId>.png, 1008x1408) and the segment map it was
// baked from (<variantId>.segs.png, 504x704). A record is a HUMAN DECISION
// (AGENTS.md F4): it wins over the generated etch for that printing, and no
// regeneration touches it. `enabled: false` is itself a decision: this
// printing shows no etch at all.
//
// The record is written to be READ BY AGENTS as well as by the editor. The
// sections say, per painted region, which pattern was chosen and with what
// direction, pitch and weight, so a generator can learn which patterns people
// pick for which kinds of region.

import { decodePng } from '@foilkit/forge'
import { BadRequest } from './corpus.ts'

export const ETCHES_PREFIX = 'data/foil-etches'
export const ETCH_PATTERNS = ['contour', 'arcs', 'parallel', 'wave', 'radial', 'crosshatch', 'chevron', 'shards', 'stipple', 'solid', 'clear'] as const
export const SECTION_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const

export interface EtchSectionRecord {
  pattern: (typeof ETCH_PATTERNS)[number]
  angle: number
  pitch: number
  weight: number
  cx: number
  cy: number
  phase: number
  amount: number
  /** Free-text: what this region is ("eyes", "fire", "background sky"). The learning signal. */
  note?: string
}

export interface EtchRecord {
  version: 1
  cardId: string
  variantId: number
  enabled: boolean
  /** What KEEP pixels show: the generated etch (by hash) or plain foil. */
  base: { kind: 'generated' | 'none'; sha256: string | null }
  sections: Partial<Record<(typeof SECTION_NAMES)[number], EtchSectionRecord>>
  legend: Record<string, string>
  files: { etch: string | null; segs: string | null }
  savedAt: string
  author: { login: string; id: number | null }
}

const num = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi) throw new BadRequest(`${what} must be a number in [${lo}, ${hi}]`)
  return n
}

export function parseSections(raw: unknown): EtchRecord['sections'] {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') throw new BadRequest('sections must be an object')
  const out: EtchRecord['sections'] = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SECTION_NAMES as readonly string[]).includes(k)) throw new BadRequest(`unknown section ${k}`)
    const s = v as Record<string, unknown>
    if (!(ETCH_PATTERNS as readonly string[]).includes(String(s.pattern))) throw new BadRequest(`section ${k}: unknown pattern ${String(s.pattern)}`)
    const rec: EtchSectionRecord = {
      pattern: s.pattern as EtchSectionRecord['pattern'],
      angle: num(s.angle, -360, 360, `section ${k} angle`),
      pitch: num(s.pitch, 1.5, 64, `section ${k} pitch`),
      weight: num(s.weight, 0.02, 0.98, `section ${k} weight`),
      cx: num(s.cx, -1, 2, `section ${k} cx`),
      cy: num(s.cy, -1, 2, `section ${k} cy`),
      phase: num(s.phase, -100, 100, `section ${k} phase`),
      amount: num(s.amount, 0, 1, `section ${k} amount`),
    }
    if (typeof s.note === 'string' && s.note.trim()) rec.note = s.note.trim().slice(0, 120)
    out[k as (typeof SECTION_NAMES)[number]] = rec
  }
  return out
}

/** A data-URL PNG of exactly w x h, or null when absent. */
export function pngOf(v: unknown, w: number, h: number, what: string): Buffer | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || !v.startsWith('data:image/png;base64,')) throw new BadRequest(`${what} must be a data:image/png URL`)
  const buf = Buffer.from(v.slice('data:image/png;base64,'.length), 'base64')
  if (buf.length > 4 * 1024 * 1024) throw new BadRequest(`${what} is over 4 MB`)
  const img = decodePng(buf)
  if (img.width !== w || img.height !== h) throw new BadRequest(`${what} must be ${w}x${h}, got ${img.width}x${img.height}`)
  return buf
}

export const LEGEND: Record<string, string> = {
  '0': 'keep (the base etch shows: generated or plain foil)',
  '1': 'white (clear: full foil, no lines)',
  '2': 'black (solid dark)',
  ...Object.fromEntries(SECTION_NAMES.map((n, i) => [String(3 + i), `section ${n}`])),
}

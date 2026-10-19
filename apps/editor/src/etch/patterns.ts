// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The etch pattern library and the baker. Pure functions: a segment map (which
// section each pixel belongs to) plus per-section pattern settings in, an etch
// plate out (1008 x 1408, 8-bit, 255 = foil / no line, 0 = line or solid).
//
// THE LIBRARY was chosen by measurement: 160 reference etches from the modern
// era (Scarlet & Violet, Mega Evolution), classified in 48 px patches at 1008 px
// wide (local, never committed; only the numbers carry over):
//   blank (full foil)      50%     curved / concentric    33%
//   straight parallel      10%     cross-hatch            3.7%
//   stipple / dots         2.5%    solid                  1.0%
//   line pitch  median 4.85 px at 1008 (0.30 mm), p10 4.0, p90 ~12
//   line weight (dark fraction) median 0.51-0.61
//   the outer border band leans diagonal (angle peaks near 135 deg and 0/180)
// The user's own reading of the same cards: wide concentric arcs following
// the broadest curve of a shape, direction changing at depth changes, angular
// chaotic texture for fire and crystals, solid dark eyes, a tight angular
// border. Every one of those has a pattern here.

export const ETCH_W = 1008
export const ETCH_H = 1408
/** Segment maps are painted at canonical resolution and scaled 2x at bake. */
export const SEG_W = 504
export const SEG_H = 704

export type EtchPatternId =
  | 'contour' // lines follow the section's own outline, nested inward (the dominant "concentric arcs")
  | 'arcs' // concentric circles about a chosen centre
  | 'parallel' // straight lines at an angle
  | 'wave' // gently bending parallel lines
  | 'radial' // rays from a chosen centre
  | 'crosshatch' // two parallel sets crossing
  | 'chevron' // tight angular zig-zag (the border band)
  | 'shards' // angular chaotic facets, each with its own line angle (fire, crystal)
  | 'stipple' // dots on a jittered grid
  | 'solid' // fully dark
  | 'clear' // no lines: full foil

export interface EtchPatternDef {
  id: EtchPatternId
  label: string
  /** What it is for, in the words an agent or a person picking one would use. */
  use: string
  /** Measured share of reference patches it accounts for (null: not measured as its own class). */
  measuredShare: number | null
}

export const ETCH_PATTERNS: EtchPatternDef[] = [
  { id: 'contour', label: 'Contour (follows shape)', use: 'the default for a body or object: wide concentric arcs following the outline, nested inward', measuredShare: 0.332 },
  { id: 'arcs', label: 'Concentric arcs', use: 'rings about a centre you place: a round body, a bubble, a glow', measuredShare: null },
  { id: 'parallel', label: 'Parallel lines', use: 'flat planes, sky, backgrounds, a single direction of motion', measuredShare: 0.1 },
  { id: 'wave', label: 'Wave', use: 'parallel lines that bend: cloth, water, hair', measuredShare: null },
  { id: 'radial', label: 'Radial rays', use: 'bursts, sunbeams, explosions, from a centre you place', measuredShare: null },
  { id: 'crosshatch', label: 'Cross-hatch', use: 'shaded areas, metal, textured surfaces', measuredShare: 0.037 },
  { id: 'chevron', label: 'Chevron (angular border)', use: 'the tight angular band around the card edge', measuredShare: null },
  { id: 'shards', label: 'Shards (angular chaos)', use: 'fire, crystal, ice, rock: facets each with its own line angle', measuredShare: null },
  { id: 'stipple', label: 'Stipple', use: 'soft gradients, dust, sparkle fields', measuredShare: 0.025 },
  { id: 'solid', label: 'Solid dark', use: 'eyes (always), pupils, deep shadow, small dark accents', measuredShare: 0.0105 },
  { id: 'clear', label: 'Clear (full foil)', use: 'no texture: the foil shows plain', measuredShare: 0.496 },
]

export interface EtchSection {
  pattern: EtchPatternId
  /** Line direction in degrees (parallel, wave, crosshatch, chevron; shards use it as a seed). */
  angle: number
  /** Distance between line centres, in px at 1008 wide. Measured median 4.85. */
  pitch: number
  /** Dark fraction of each period, 0..1. Measured median ~0.55. */
  weight: number
  /** Centre for arcs / radial, in canonical 0..1 card coordinates (y down). */
  cx: number
  cy: number
  /** Phase offset in periods (shifts lines without changing them). */
  phase: number
  /** Curvature for wave, scale for shards and stipple (pattern-specific, 0..1). */
  amount: number
}

export const DEFAULT_SECTION: EtchSection = {
  pattern: 'contour', angle: 135, pitch: 4.85, weight: 0.55, cx: 0.5, cy: 0.35, phase: 0, amount: 0.5,
}

/**
 * Segment map labels. 0 = KEEP (the base etch shows through: the generated
 * one, or plain foil when there is none), 1 = WHITE (clear, full foil),
 * 2 = BLACK (solid), 3.. = sections A, B, C ... each with its own settings.
 */
export const LABEL_KEEP = 0
export const LABEL_WHITE = 1
export const LABEL_BLACK = 2
export const SECTION_BASE = 3
export const SECTION_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
export const SECTION_COLORS = ['#ff4d6d', '#4dabff', '#69db7c', '#ffd43b', '#b197fc', '#ff922b', '#3bc9db', '#f783ac']

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Line profile: 1 (dark) on the first `weight` of each period, soft 1 px edges. */
function lineAt(t: number, weight: number, pitch: number): number {
  const f = t - Math.floor(t)
  const edge = 0.5 / Math.max(pitch, 1)
  const a = smooth(0, edge, f) - smooth(weight, weight + edge, f)
  return Math.max(0, Math.min(1, a))
}
function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0 || 1e-6)))
  return t * t * (3 - 2 * t)
}

/**
 * Chamfer distance (px) from each pixel to the nearest pixel NOT in `inside`.
 * Two passes, 3-4 weights; exact enough for nested contour lines.
 */
export function distanceInside(inside: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? INF : 0
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]!)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!inside[i]) continue
      d[i] = Math.min(d[i]!, at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.4142, at(x + 1, y - 1) + 1.4142)
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (!inside[i]) continue
      d[i] = Math.min(d[i]!, at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.4142, at(x - 1, y + 1) + 1.4142)
    }
  return d
}

/** Darkness (0..1) of one pattern at an etch pixel. `dist` is only read by contour. */
export function patternDark(s: EtchSection, x: number, y: number, dist: number): number {
  const p = Math.max(1.5, s.pitch)
  const rad = (s.angle * Math.PI) / 180
  const nx = Math.cos(rad + Math.PI / 2), ny = Math.sin(rad + Math.PI / 2) // across the lines
  switch (s.pattern) {
    case 'clear':
      return 0
    case 'solid':
      return 1
    case 'contour':
      return lineAt(dist / p + s.phase, s.weight, p)
    case 'arcs': {
      const r = Math.hypot(x - s.cx * ETCH_W, y - s.cy * ETCH_H)
      return lineAt(r / p + s.phase, s.weight, p)
    }
    case 'radial': {
      // a fixed ray count, spaced one pitch apart at 60 px from the centre
      const a = Math.atan2(y - s.cy * ETCH_H, x - s.cx * ETCH_W)
      const rays = Math.max(8, Math.round((2 * Math.PI * 60) / p))
      return lineAt((a / (2 * Math.PI)) * rays + s.phase, s.weight, p)
    }
    case 'parallel':
      return lineAt((x * nx + y * ny) / p + s.phase, s.weight, p)
    case 'wave': {
      const along = x * Math.cos(rad) + y * Math.sin(rad)
      const across = x * nx + y * ny + Math.sin(along / (40 + 120 * (1 - s.amount))) * (6 + 24 * s.amount)
      return lineAt(across / p + s.phase, s.weight, p)
    }
    case 'crosshatch': {
      const a = lineAt((x * nx + y * ny) / p + s.phase, s.weight * 0.6, p)
      const nx2 = Math.cos(rad), ny2 = Math.sin(rad)
      const b = lineAt((x * nx2 + y * ny2) / p + s.phase, s.weight * 0.6, p)
      return Math.max(a, b)
    }
    case 'chevron': {
      const along = x * Math.cos(rad) + y * Math.sin(rad)
      const across = x * nx + y * ny
      const tooth = p * (3 + 5 * s.amount)
      const zig = Math.abs(((along / tooth) % 2 + 2) % 2 - 1) * tooth
      return lineAt((across + zig) / p + s.phase, s.weight, p)
    }
    case 'shards': {
      // Voronoi facets ~ 30-110 px, each with its own line angle around s.angle
      const cell = 30 + 80 * s.amount
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell)
      let best = 1e9, bx = 0, by = 0
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const cxp = (gx + i + hash2(gx + i, gy + j)) * cell
          const cyp = (gy + j + hash2(gy + j + 91, gx + i + 7)) * cell
          const dd = (x - cxp) ** 2 + (y - cyp) ** 2
          if (dd < best) { best = dd; bx = gx + i; by = gy + j }
        }
      const a2 = rad + (hash2(bx * 3 + 1, by * 5 + 2) - 0.5) * Math.PI
      return lineAt((x * Math.cos(a2 + Math.PI / 2) + y * Math.sin(a2 + Math.PI / 2)) / p + s.phase, s.weight, p)
    }
    case 'stipple': {
      const cell = p * (1.5 + 2 * s.amount)
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell)
      const ox = (gx + 0.5 + (hash2(gx, gy) - 0.5) * 0.5) * cell
      const oy = (gy + 0.5 + (hash2(gy + 13, gx) - 0.5) * 0.5) * cell
      const r = cell * Math.sqrt(s.weight / Math.PI)
      return Math.hypot(x - ox, y - oy) < r ? 1 : 0
    }
  }
}

/**
 * Bake an etch plate. `segs` is SEG_W x SEG_H labels; `base` is the etch the
 * KEEP label shows (ETCH_W x ETCH_H, 255 = foil), or null for plain foil.
 */
export function bakeEtch(segs: Uint8Array, sections: Record<string, EtchSection>, base: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(ETCH_W * ETCH_H)
  // per-section distance fields for contour, at etch resolution
  const dists = new Map<number, Float32Array>()
  SECTION_NAMES.forEach((name, i) => {
    const s = sections[name]
    if (!s || s.pattern !== 'contour') return
    const label = SECTION_BASE + i
    const inside = new Uint8Array(ETCH_W * ETCH_H)
    for (let y = 0; y < ETCH_H; y++)
      for (let x = 0; x < ETCH_W; x++) inside[y * ETCH_W + x] = segs[(y >> 1) * SEG_W + (x >> 1)] === label ? 1 : 0
    dists.set(label, distanceInside(inside, ETCH_W, ETCH_H))
  })
  for (let y = 0; y < ETCH_H; y++)
    for (let x = 0; x < ETCH_W; x++) {
      const i = y * ETCH_W + x
      const label = segs[(y >> 1) * SEG_W + (x >> 1)]!
      let v: number
      if (label === LABEL_KEEP) v = base ? base[i]! : 255
      else if (label === LABEL_WHITE) v = 255
      else if (label === LABEL_BLACK) v = 0
      else {
        const s = sections[SECTION_NAMES[label - SECTION_BASE] ?? ''] ?? DEFAULT_SECTION
        v = Math.round(255 * (1 - patternDark(s, x, y, dists.get(label)?.[i] ?? 0)))
      }
      out[i] = v
    }
  return out
}

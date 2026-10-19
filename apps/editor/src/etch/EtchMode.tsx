// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// ETCH MODE: paint segments over the card, pick a pattern per segment, bake the
// etch plate, see it on the live 3D card, and save it as a human record.
//
//   labels   keep (the base etch shows through), white (clear, full foil),
//            black (solid), and sections A-H, each with its own pattern.
//   tools    brush, lasso, erase (back to keep), centre (places the centre of
//            the selected section's arcs or rays).
//
// The record it saves (data/foil-etches/, see its README) holds the section
// rules alongside the baked plate, so the choices people make are readable by
// agents as well as rendered.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionBtn, Chip, Section, Select, Slider } from '../ui.tsx'
import { deleteEtch, resolveEtch, saveEtch, type EtchRecordFile, type EtchSectionSettings } from '../api.ts'
import {
  DEFAULT_SECTION, ETCH_H, ETCH_PATTERNS, ETCH_W, LABEL_BLACK, LABEL_KEEP, LABEL_WHITE, SECTION_BASE, SECTION_COLORS,
  SECTION_NAMES, SEG_H, SEG_W, bakeEtch, type EtchSection,
} from './patterns.ts'

export type EtchTool = 'brush' | 'lasso' | 'erase' | 'centre'

export interface EtchSession {
  loading: boolean
  source: 'edited' | 'generated' | 'off' | 'none'
  enabled: boolean
  setEnabled: (v: boolean) => void
  labels: React.MutableRefObject<Uint8Array>
  labelsVersion: number
  bump: () => void
  pushUndo: () => void
  undo: () => void
  sections: Record<string, EtchSection>
  setSection: (name: string, patch: Partial<EtchSection>) => void
  label: number
  setLabel: (l: number) => void
  tool: EtchTool
  setTool: (t: EtchTool) => void
  brush: number
  setBrush: (b: number) => void
  overlayOpacity: number
  setOverlayOpacity: (o: number) => void
  /** The etch the 3D card should show right now (baked preview while editing). */
  previewUrl: string | null
  bake: () => void
  dirty: boolean
  save: () => Promise<void>
  switchOff: () => Promise<void>
  revert: () => Promise<void>
  status: string
}

function loadGrey(url: string, w: number, h: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.imageSmoothingEnabled = w !== img.width
      ctx.drawImage(img, 0, 0, w, h)
      const d = ctx.getImageData(0, 0, w, h).data
      const out = new Uint8Array(w * h)
      for (let i = 0; i < out.length; i++) out[i] = d[i * 4]!
      resolve(out)
    }
    img.onerror = () => reject(new Error(`could not load ${url}`))
    img.src = url
  })
}

function greyToPng(a: Uint8Array, w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  const im = ctx.createImageData(w, h)
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!
    im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255
  }
  ctx.putImageData(im, 0, 0)
  return c.toDataURL('image/png')
}

const toRecordSections = (s: Record<string, EtchSection & { note?: string }>): Record<string, EtchSectionSettings> =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v }]))

export function useEtchSession(cardId: string | null, variantId: number | null, active: boolean, canWrite: boolean): EtchSession {
  const labels = useRef<Uint8Array>(new Uint8Array(SEG_W * SEG_H))
  const undoStack = useRef<Uint8Array[]>([])
  const base = useRef<Uint8Array | null>(null)
  const baseInfo = useRef<{ kind: 'generated' | 'none'; sha256: string | null }>({ kind: 'none', sha256: null })
  const [labelsVersion, setLabelsVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<EtchSession['source']>('none')
  const [enabled, setEnabled] = useState(true)
  const [sections, setSections] = useState<Record<string, EtchSection>>({})
  const [label, setLabel] = useState(SECTION_BASE)
  const [tool, setTool] = useState<EtchTool>('brush')
  const [brush, setBrush] = useState(14)
  const [overlayOpacity, setOverlayOpacity] = useState(0.45)
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null)
  const [bakedUrl, setBakedUrl] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // What the card shows outside etch mode, and the starting point inside it.
  useEffect(() => {
    if (!cardId || variantId == null) return
    let cancelled = false
    setLoading(true)
    void resolveEtch(cardId, variantId, reloadKey > 0).then(async (r) => {
      if (cancelled) return
      setSource(r.source)
      setResolvedUrl(r.url)
      setEnabled(r.source !== 'off')
      const rec: EtchRecordFile | null = r.record
      setSections(Object.fromEntries(Object.entries(rec?.sections ?? {}).map(([k, v]) => [k, { ...DEFAULT_SECTION, ...v } as EtchSection])))
      // KEEP shows the generated etch (what a record was edited over), else plain foil
      const baseUrl = rec?.base.kind === 'none' ? null : r.generated?.url ?? null
      baseInfo.current = baseUrl ? { kind: 'generated', sha256: r.generated!.sha256 } : { kind: 'none', sha256: null }
      base.current = baseUrl ? await loadGrey(baseUrl, ETCH_W, ETCH_H).catch(() => null) : null
      labels.current = rec?.files.segs
        ? await loadGrey(`/foil-etches/${cardId}/${rec.files.segs}?v=${encodeURIComponent(rec.savedAt)}`, SEG_W, SEG_H).catch(() => new Uint8Array(SEG_W * SEG_H))
        : new Uint8Array(SEG_W * SEG_H)
      undoStack.current = []
      setBakedUrl(null)
      setDirty(false)
      setLabelsVersion((v) => v + 1)
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [cardId, variantId, reloadKey])

  const bake = useCallback(() => {
    const out = bakeEtch(labels.current, sections, base.current)
    setBakedUrl(greyToPng(out, ETCH_W, ETCH_H))
  }, [sections])

  // Re-bake shortly after any edit while the mode is open, so the 3D card follows.
  useEffect(() => {
    if (!active || loading) return
    const t = setTimeout(bake, 350)
    return () => clearTimeout(t)
  }, [active, loading, labelsVersion, sections, bake])

  const setSection = useCallback((name: string, patch: Partial<EtchSection>) => {
    setSections((s) => ({ ...s, [name]: { ...DEFAULT_SECTION, ...s[name], ...patch } }))
    setDirty(true)
  }, [])

  const pushUndo = useCallback(() => {
    undoStack.current.push(labels.current.slice())
    if (undoStack.current.length > 40) undoStack.current.shift()
  }, [])
  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    labels.current = prev
    setLabelsVersion((v) => v + 1)
  }, [])
  const bump = useCallback(() => {
    setLabelsVersion((v) => v + 1)
    setDirty(true)
  }, [])

  const write = useCallback(async (body: Parameters<typeof saveEtch>[0], done: string) => {
    if (!canWrite) {
      setStatus('Sign in as a writer to save etches.')
      return
    }
    setStatus('Saving…')
    try {
      await saveEtch(body)
      setStatus(done)
      setDirty(false)
      setReloadKey((k) => k + 1)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }, [canWrite])

  const save = useCallback(async () => {
    if (!cardId || variantId == null) return
    const baked = bakeEtch(labels.current, sections, base.current)
    // only sections actually painted are recorded
    const used = new Set<number>()
    for (const v of labels.current) if (v >= SECTION_BASE) used.add(v)
    const recSections = Object.fromEntries(
      Object.entries(sections).filter(([k]) => used.has(SECTION_BASE + SECTION_NAMES.indexOf(k as never))),
    )
    await write({
      cardId, variantId, enabled,
      base: baseInfo.current,
      sections: toRecordSections(recSections),
      etch: greyToPng(baked, ETCH_W, ETCH_H),
      segs: greyToPng(labels.current, SEG_W, SEG_H),
    }, 'Saved. The card now shows your etch.')
  }, [cardId, variantId, enabled, sections, write])

  const switchOff = useCallback(async () => {
    if (!cardId || variantId == null) return
    await write({ cardId, variantId, enabled: false }, 'Etch switched off for this card.')
  }, [cardId, variantId, write])

  const revert = useCallback(async () => {
    if (!cardId || variantId == null) return
    if (!canWrite) {
      setStatus('Sign in as a writer to change etches.')
      return
    }
    setStatus('Reverting…')
    try {
      await deleteEtch(cardId, variantId)
      setStatus('Reverted to the generated etch.')
      setReloadKey((k) => k + 1)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }, [cardId, variantId, canWrite])

  const previewUrl = !enabled ? null : active && bakedUrl ? bakedUrl : resolvedUrl
  return {
    loading, source, enabled, setEnabled: (v) => { setEnabled(v); setDirty(true) }, labels, labelsVersion, bump, pushUndo, undo,
    sections, setSection, label, setLabel, tool, setTool, brush, setBrush, overlayOpacity, setOverlayOpacity,
    previewUrl, bake, dirty, save, switchOff, revert, status,
  }
}

const labelColor = (l: number): [number, number, number] | null => {
  if (l === LABEL_KEEP) return null
  if (l === LABEL_WHITE) return [255, 255, 255]
  if (l === LABEL_BLACK) return [10, 10, 14]
  const hex = SECTION_COLORS[l - SECTION_BASE] ?? '#ffffff'
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

/** The painting surface, laid over the card at `rect` (base, unzoomed coordinates). */
export function EtchOverlay({ session, rect }: { session: EtchSession; rect: { left: number; top: number; width: number; height: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const lasso = useRef<[number, number][]>([])

  // redraw the segment colours whenever they change
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext('2d')!
    const im = ctx.createImageData(SEG_W, SEG_H)
    const L = session.labels.current
    for (let i = 0; i < L.length; i++) {
      const col = labelColor(L[i]!)
      if (!col) continue
      im.data[i * 4] = col[0]; im.data[i * 4 + 1] = col[1]; im.data[i * 4 + 2] = col[2]; im.data[i * 4 + 3] = 255
    }
    ctx.putImageData(im, 0, 0)
    if (lasso.current.length > 1) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
      ctx.beginPath()
      lasso.current.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke(); ctx.setLineDash([])
    }
  }, [session.labelsVersion, session.labels])

  const toSeg = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * SEG_W, ((e.clientY - r.top) / r.height) * SEG_H]
  }
  const paintAt = (x: number, y: number) => {
    const L = session.labels.current
    const v = session.tool === 'erase' ? LABEL_KEEP : session.label
    const r = session.brush
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(SEG_H, Math.ceil(y + r)); yy++)
      for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(SEG_W, Math.ceil(x + r)); xx++)
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) L[yy * SEG_W + xx] = v
  }
  const fillLasso = () => {
    const pts = lasso.current
    lasso.current = []
    if (pts.length < 3) return
    const c = document.createElement('canvas')
    c.width = SEG_W; c.height = SEG_H
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath(); ctx.fill()
    const d = ctx.getImageData(0, 0, SEG_W, SEG_H).data
    const L = session.labels.current
    for (let i = 0; i < L.length; i++) if (d[i * 4 + 3]! > 127) L[i] = session.label
  }

  return (
    <canvas
      ref={canvas}
      width={SEG_W}
      height={SEG_H}
      className="absolute touch-none"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, opacity: session.overlayOpacity, cursor: 'crosshair', imageRendering: 'pixelated', pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
        const [x, y] = toSeg(e)
        if (session.tool === 'centre') {
          const name = SECTION_NAMES[session.label - SECTION_BASE]
          if (name) session.setSection(name, { cx: x / SEG_W, cy: y / SEG_H })
          return
        }
        session.pushUndo()
        drawing.current = true
        if (session.tool === 'lasso') lasso.current = [[x, y]]
        else { paintAt(x, y); session.bump() }
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return
        const [x, y] = toSeg(e)
        if (session.tool === 'lasso') lasso.current.push([x, y])
        else paintAt(x, y)
        session.bump()
      }}
      onPointerUp={() => {
        if (!drawing.current) return
        drawing.current = false
        if (session.tool === 'lasso') fillLasso()
        session.bump()
      }}
    />
  )
}

const LABELS: { value: number; name: string; swatch: string }[] = [
  { value: LABEL_KEEP, name: 'Keep', swatch: 'transparent' },
  { value: LABEL_WHITE, name: 'White', swatch: '#ffffff' },
  { value: LABEL_BLACK, name: 'Black', swatch: '#0a0a0e' },
  ...SECTION_NAMES.map((n, i) => ({ value: SECTION_BASE + i, name: n, swatch: SECTION_COLORS[i]! })),
]

/** The controls, for the right-hand column. */
export function EtchPanel({ session, editing, setEditing, canWrite }: { session: EtchSession; editing: boolean; setEditing: (v: boolean) => void; canWrite: boolean }) {
  const name = SECTION_NAMES[session.label - SECTION_BASE]
  const sec: EtchSection & { note?: string } = name ? { ...DEFAULT_SECTION, ...session.sections[name] } : DEFAULT_SECTION
  const patternDef = useMemo(() => ETCH_PATTERNS.find((p) => p.id === sec.pattern), [sec.pattern])
  const sourceText = {
    edited: 'hand-edited etch',
    generated: 'generated etch (machine guess)',
    off: 'etch switched OFF for this card',
    none: 'no etch for this card yet',
  }[session.source]
  return (
    <Section title="Etch">
      <p className="mb-[8px] text-[12px] text-text-muted">Showing: {session.loading ? 'loading…' : sourceText}</p>
      <label className="mb-[8px] flex items-center gap-[8px] text-[12px]">
        <input type="checkbox" checked={session.enabled} onChange={(e) => session.setEnabled(e.target.checked)} />
        Etch on for this card
      </label>
      <div className="mb-[8px] flex flex-wrap gap-[6px]">
        <ActionBtn onClick={() => setEditing(!editing)}>{editing ? 'Close etch editor' : 'Edit etch'}</ActionBtn>
        {!session.enabled && <ActionBtn onClick={() => void session.switchOff()} disabled={!canWrite}>Save: etch off</ActionBtn>}
        {session.source !== 'generated' && session.source !== 'none' && (
          <ActionBtn onClick={() => void session.revert()} disabled={!canWrite}>Revert to generated</ActionBtn>
        )}
      </div>
      {editing && (
        <>
          <div className="mb-[6px] text-[11px] uppercase tracking-[0.06em] text-text-muted">Paint</div>
          <div className="mb-[8px] flex flex-wrap gap-[4px]">
            {LABELS.map((l) => (
              <button
                key={l.value}
                onClick={() => session.setLabel(l.value)}
                title={l.value === LABEL_KEEP ? 'Keep: the base etch shows through' : l.value === LABEL_WHITE ? 'White: clear, full foil' : l.value === LABEL_BLACK ? 'Black: solid' : `Section ${l.name}`}
                className={`flex h-[26px] min-w-[26px] items-center justify-center rounded border px-[5px] text-[11px] ${session.label === l.value ? 'border-action-primary ring-1 ring-action-primary' : 'border-border-default'}`}
                style={{ background: l.swatch, color: l.value === LABEL_WHITE ? '#000' : '#fff', backgroundImage: l.value === LABEL_KEEP ? 'repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)' : undefined }}
              >
                {l.name}
              </button>
            ))}
          </div>
          <div className="mb-[8px] flex flex-wrap gap-[4px]">
            {(['brush', 'lasso', 'erase', 'centre'] as const).map((t) => (
              <Chip key={t} active={session.tool === t} onClick={() => session.setTool(t)}>
                {t === 'centre' ? 'set centre' : t}
              </Chip>
            ))}
            <Chip active={false} onClick={session.undo}>undo</Chip>
          </div>
          <Slider label="Brush size" value={session.brush} min={2} max={60} step={1} onChange={session.setBrush} />
          <Slider label="Overlay opacity" value={session.overlayOpacity} min={0} max={1} step={0.05} onChange={session.setOverlayOpacity} />
          {name ? (
            <div className="mt-[6px] rounded border border-border-default p-[8px]">
              <div className="mb-[6px] text-[12px] font-semibold" style={{ color: SECTION_COLORS[session.label - SECTION_BASE] }}>Section {name}</div>
              <Select value={sec.pattern} onChange={(v: string) => session.setSection(name, { pattern: v as EtchSection['pattern'] })}>
                {ETCH_PATTERNS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </Select>
              {patternDef && <p className="my-[6px] text-[11px] text-text-muted">{patternDef.use}</p>}
              <Slider label="Direction (deg)" value={sec.angle} min={0} max={180} step={1} onChange={(v) => session.setSection(name, { angle: v })} />
              <Slider label="Pitch (px @1008; 4.85 typical)" value={sec.pitch} min={2} max={24} step={0.05} onChange={(v) => session.setSection(name, { pitch: v })} />
              <Slider label="Line weight" value={sec.weight} min={0.1} max={0.9} step={0.01} onChange={(v) => session.setSection(name, { weight: v })} />
              <Slider label="Amount (wave bend, shard size, dot size)" value={sec.amount} min={0} max={1} step={0.01} onChange={(v) => session.setSection(name, { amount: v })} />
              <Slider label="Phase" value={sec.phase} min={0} max={1} step={0.01} onChange={(v) => session.setSection(name, { phase: v })} />
              {(sec.pattern === 'arcs' || sec.pattern === 'radial') && (
                <p className="text-[11px] text-text-muted">Centre {sec.cx.toFixed(2)}, {sec.cy.toFixed(2)}: pick "set centre" and click the card.</p>
              )}
              <input
                className="mt-[6px] w-full rounded border border-border-default bg-surface-tertiary px-[6px] py-[4px] text-[12px]"
                placeholder="What is this region? (eyes, fire, sky…)"
                value={(session.sections[name] as { note?: string } | undefined)?.note ?? ''}
                onChange={(e) => session.setSection(name, { note: e.target.value } as Partial<EtchSection>)}
              />
            </div>
          ) : (
            <p className="text-[11px] text-text-muted">Keep, White and Black have no settings. Pick a section (A-H) to give a region a pattern.</p>
          )}
          <div className="mt-[8px] flex flex-wrap gap-[6px]">
            <ActionBtn onClick={session.bake}>Bake preview</ActionBtn>
            <ActionBtn onClick={() => void session.save()} disabled={!canWrite}>{canWrite ? 'Save etch' : 'Save (writers only)'}</ActionBtn>
          </div>
        </>
      )}
      {session.status && <p className="mt-[6px] text-[12px] text-text-muted">{session.status}</p>}
    </Section>
  )
}

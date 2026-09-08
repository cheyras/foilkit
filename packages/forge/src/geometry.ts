// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
// forge/geometry.ts — @foilkit/forge/geometry: the half of the forge a BROWSER can import.
//
// THE PRECEDENT THIS EXISTS TO STOP. `@foilkit/forge`'s barrel re-exports the PNG codec, the
// mask corpus and the generator, so importing it drags in `node:fs`, `node:zlib` and
// `node:child_process`. The editor cannot have those, so when it needed forge's diff geometry
// it HAND-PORTED the functions into `apps/editor/src/staging/provisionalDiff.ts` and put a
// byte-parity test alongside to keep the copy honest. That was a reasonable call once. Doing
// it a second time for the pen tool would make the port the normal way to reach this package,
// and a hand-ported copy is a fork that has not noticed yet: the parity test proves the two
// agree TODAY, and says nothing about the next person who fixes a bug in one of them.
//
// So this file is the seam instead. It re-exports only modules that are already free of node
// builtins — `vector-template.ts`, `pen-geometry.ts`, `line-snap.ts`, `edge-trace.ts` — and
// deliberately does NOT widen to the rest of the forge. `edge-trace.ts` reaches for `png.ts`,
// which does import `node:zlib`, but only for `RgbaImage` and only as `import type`, which
// erases entirely; that distinction is load-bearing and is why the guard checks for VALUE
// imports rather than for the string `node:`.
//
// The guard is `tools/check-geometry-browser-safe.mjs`, wired into CI. It walks the import
// graph from this file transitively, because the way this breaks is never a `node:fs` added
// to this file — it is a `node:fs` added three modules down by someone with no reason to know
// a browser reads their code.

export {
  flattenPath,
  rasterizeTemplate,
  reversePath,
  vectorness,
  // The px <-> fraction converter. Exported because the editor's pen works in pixels and the
  // artifact is committed in fractions, and a second implementation of that conversion is
  // precisely how a cubic's handles end up in the wrong space.
  mapPathCoords,
  arcGeometry,
  cubicAt,
  DEFAULT_VECTOR_FIT_PARAMS,
  // The mask's own vector artifact: what the pen holds, what the repository stores, and the
  // rasteriser that proves the two agree. The editor needs all four — it previews through
  // `rasterizeMaskVector`, stages the parsed value, and must never grow a second serialiser,
  // because a byte-identical re-save is the only thing that keeps the committed diff readable.
  BadMaskVector,
  MASK_VECTOR_VERSION,
  VECTOR_COORD_DP,
  parseMaskVector,
  rasterizeMaskVector,
  serializeMaskVector,
} from './vector-template.ts';

export type {
  AnchorType,
  ArcGeometry,
  ArcPrim,
  CubicPrim,
  LinePrim,
  MaskVector,
  Prim,
  TemplateHole,
  TemplateProvenance,
  VPath,
  VectorFitParams,
  VectorTemplate,
  Vectorness,
} from './vector-template.ts';

export * from './pen-geometry.ts';

// The pen's BEHAVIOUR, on the same terms as its arithmetic: pure, DOM-free, framework-free, and
// therefore reachable from the browser through this seam rather than hand-ported into the
// editor. `pen-engine.ts` imports only `pen-geometry.ts`, `vector-template.ts` and a type from
// `line-snap.ts`, all of which the guard already walks — so the editor's pen surface is a
// renderer for `PenState` plus a translator from pointer events to `PenInput`, and every
// judgement it would otherwise have made locally stays here where `node --test` can drive it.
export * from './pen-engine.ts';

// The shared rasteriser and the loop tracer: `rasterizeTemplate` returns coverage from
// `rasterizePolygons`, so an editor previewing an edit must fill by the same rule or its
// preview and its export disagree at every hole.
export { intersectLines, rasterizePolygons, traceLoops } from './line-snap.ts';
export type { Line, Vec } from './line-snap.ts';

// The sub-pixel half-level contour. `vectorness` measures on it rather than on `traceLoops`'
// rectilinear staircase, and anything in the browser comparing a drawn mask to a template has
// to make the same choice or it will be measuring the tracer.
export { contourSegments } from './edge-trace.ts';

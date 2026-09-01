// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/forge — the authoring stack. node: builtins only, no database, no
// image library: the PNG codec is hand-rolled over node:zlib.
//
// A hand mask is a TEACHING EVENT, not a deliverable. Every mask a human draws
// is both a verification ("this is how this card truly is") and training signal
// about how its era handles foil. That is why provenance, the exemplar
// weighting in mask-corpus / region-learn, and the generator travel together —
// separate them and the loop that makes the next generative pass smarter breaks.
//
// FOUR MODULES ARE NOT RE-EXPORTED, because importing them RUNS them:
// `backfill.ts`, `corpus.ts`, `fit-template.ts` and `generate-masks.ts` are
// command-line entry points with a top-level `main()`. Run them directly
// (`node packages/forge/src/corpus.ts report`); importing this index must never
// start a job.

export * from './provenance.ts'
export * from './mask-corpus.ts'
export * from './mask-artifacts.ts'
export * from './png.ts'
export * from './frames.ts'
export * from './image-dims.ts'
export * from './edge-trace.ts'
export * from './line-snap.ts'
export * from './region-learn.ts'
export * from './vector-template.ts'
export * from './template-raster.ts'
export * from './generator.ts'
// analysis-source and mask-corpus both define `setIdOf` (identical two-line
// splits of a tcgdex card id). Re-exported once, from mask-corpus, so the
// package has one name for it; the duplicate implementation is a follow-up.
export {
  AnalysisSource,
  CACHE_ROOT,
  DEFAULT_USER_AGENT,
  analysisSource,
  cardCacheKey,
  cardRelativePath,
  closeAnalysisSource,
  getAnalysisImage,
  inspectPng,
  losslessUrlFrom,
  registerAssetPool,
  sniffImageType,
  type AnalysisDeps,
  type AnalysisImage,
  type AnalysisRequest,
  type AnalysisSourceConfig,
  type AnalysisSourceKind,
  type AnalysisSourceStats,
  type FetchResult,
  type LosslessUrl,
  type ManifestRow,
  type MinimalPool,
  type PngInfo,
  type Quality,
} from './analysis-source.ts'

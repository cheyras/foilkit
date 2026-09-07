// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen

export * from './resolver.ts'
// The second axis: which DESIGN is printed over the sheet resolveFoil picked.
// A parallel resolver rather than a field on FoilRecipeRef — same input shape,
// different question, and a caller that never asks renders exactly as before.
export * from './ink.ts'
export { default as ERA_LAYOUTS } from './era-layouts.json' with { type: 'json' }

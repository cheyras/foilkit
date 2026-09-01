# `@foilkit/core`

The shader ABI. **Zero dependencies, and no renderer** — this package emits GLSL
strings and a uniform table and nothing else.

```ts
import { buildFoilShader } from '@foilkit/core'
import { patternById } from '@foilkit/patterns'

const { vertexShader, fragmentShader, uniforms } = buildFoilShader(patternById('cosmos'))
```

## What is in here

- **Canonical card space.** `card-space.json` is the datum — 63 × 88 mm, a 3 mm
  corner (triangulated, not official; the provenance travels with the number),
  8 px/mm. `canonical-space.ts` derives everything else, so the module cannot
  drift from itself. Nothing in this repository types a raster size in, and a
  contract test reads the source back to keep it that way.
- **The uniform contract.** `GLOBAL_DEFAULTS`, and the full commented table of
  what every uniform means: the core dials, the scan-path composite dials, the
  two mask tiers, the glyph slot, and `uP0`–`uP5`.
- **The GLSL.** `PREAMBLE` (constants, hash and noise, the hue ramp, the mask and
  card-corner SDFs, the glyph sampler) and `MAIN` (the composite law). A recipe
  compiles as `PREAMBLE + pattern.glsl + MAIN`.
- **`COMPOSITE_CONTRACT`.** The version of that law, so "the same canon file
  renders differently now" is a recorded fact rather than a silent one.
- **Canon layering.** `seedUniforms`, `canonBaseline`, `sparseDiff` — code
  defaults, then the canon snapshot, then a sparse per-card override.
- **The stored-form types.** `FoilPattern`, `FoilCanonEntry`, `FoilOverrideEntry`.

## Two vertex shaders, on purpose

three.js injects `projectionMatrix`, `modelViewMatrix`, `position` and `uv` into
every ShaderMaterial for free — so a shader written for three MUST NOT declare
them, and a shader for anything else MUST. `VERTEX_SHADER` is self-contained;
`VERTEX_SHADER_THREE` omits the declarations. Picking the wrong one is a GLSL
redeclaration error, which is why they are two named exports rather than a flag.

## Why it has no three.js import

The GLSL is ES 1.00 (`texture2D`, `gl_FragColor`, `varying`), which WebGL2
compiles unchanged — so a raw-WebGL2 or custom-element adapter is a later
*addition* rather than a later rewrite. That is the whole obligation the
extraction carried forward for those packages, it costs nothing today, and
`tools/check-independence.mjs` keeps it true: it scans the sources, typechecks
this package in a sandbox holding only typescript and `@types/node`, and then
executes it.

The three.js binding — two 1×1 fallback textures and `buildFoilMaterial` — is
about sixty lines, and lives in `@foilkit/three`.

MIT, except the JSON data files, which are CC0-1.0. See `REUSE.toml`.

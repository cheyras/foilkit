**Deep dive.** The narrative companion to the shader. When `docs/SHADER-CONTRACT.md` lands with the extraction it becomes the canonical specification; this page stays as the explanation of *why* the contract has the shape it does. Where the two disagree, the document wins — and the disagreement is a bug.

# Shader Contract

The renderer's stability claim is simple: **a foil pattern is a pure GLSL
function with a fixed signature, and everything else is the shared program's
job.** A recipe knows nothing about three.js, nothing about React, nothing about
the application it is embedded in. That is what makes 45 patterns maintainable
and what makes the library extractable at all.

## The assembly model

A material is built by concatenating three strings:

```
PREAMBLE + pattern.glsl + MAIN
```

- **`PREAMBLE`** declares the precision, the constants, **every uniform**, and
  the helper library. Nothing else may declare a uniform.
- **`pattern.glsl`** is the recipe, verbatim. A template literal in the pattern
  library; pure GLSL text.
- **`MAIN`** is the single `void main()`. It samples the card scan, builds the
  mask, the art gate and the ink estimates, calls the recipe, and composites.

There is exactly one `main()` in the program and no recipe supplies it. The
vertex shader passes card UV and is not extensible.

At build time the material seeds its uniforms from the recipe's `defaults`, then
from each declared parameter's default.

## The entry point

```glsl
vec3 foilPattern(vec2 uv, vec2 tilt)
```

`uv` is card UV, `0..1`, **y up**. `tilt` is the current card tilt, `-1..1` per
axis. The return value is **the foil light layer** in linear-ish RGB — later
masked, gained, and composited by the shared `main()`.

Honest output range is `0 .. ~1.5`, but only the metalness path preserves
anything above `1.0`; the additive path clamps to `1.0`.

## The uniform contract

### Core

| Uniform | Type | Meaning | Notes |
|---|---|---|---|
| `uFace` | `sampler2D` | The card scan | Uploaded with **no colour-space conversion** — the whole blend model is authored in display space |
| `uTilt` | `vec2` | Card tilt, −1..1 per axis | **The primary animator.** Driven by pointer, gyroscope or manual control, then eased |
| `uTime` | `float` | Seconds since mount | Ambient drift only. Never animate a foil from time alone |
| `uIntensity` | `float` | Overall foil gain | Applied by `main()`. Recipes must not self-apply it. `0` renders the plain scan — a hard contract |
| `uScale` | `float` | Global pattern scale | Multiply your spatial frequencies by it |
| `uHueShift` | `float` | Base hue offset around the rainbow ramp | |
| `uHueSpread` | `float` | Hue variation width across pattern and tilt | |
| `uSat` | `float` | Rainbow saturation | `0` = silver, `1` = full spectrum. Applied inside the shared hue ramp |
| `uArtGate` | `float` | Luminance gate: let foil show in dark scan areas | The licensed exception to "text is sacred" — on a WOTC holo window, dark means foil, not ink |
| `uSpecular` | `float` | Shared white sheen-band gain | Applied by `main()` |
| `uTint` | `float` | How much the flash carries the printed ink's own colour | The double-ink-pass model: `flash × (normalized chroma)²` |
| `uInkGuard` | `float` | Scan-composite engagement | **A switch, not a dial.** Leave at 1 |
| `uInkPop` | `float` | Metallic chroma pop under the flash | Luminance-neutral by construction |
| `uMetal` | `float` | **The law selector** | `0` = additive law. `>0` = metalness law, and that is mirror-only |
| `uSheen` | `float` | Pattern-light gain in both laws | `1` = the authored blank-canon strength |
| `uSheenTint` | `float` | How far the flash takes the ink's colour rather than the foil's own | **0 on every non-mirror family** |
| `uDepth` | `float` | Substrate darkness on a real scan | The trap — see below |
| `uGrain` | `float` | Metalness only: how much pattern structure perturbs the surface | |
| `uDarken` | `float` | Blank-base mirror-substrate attenuation | Inert on real scans |
| `uScanBase` | `float` | **Surface-owned mode switch**: `1` = `uFace` is a real scan, `0` = a synthetic blank base | Never a slider. Never stored in a canon file |

### Mask uniforms — the layout tier

Set from the resolver and the era layout data. Patterns **never mask
themselves**; `main()` owns the mask entirely.

| Uniform | Type | Meaning |
|---|---|---|
| `uMaskRect` | `vec4` | Art-window rect `x, y, w, h` in UV, y up |
| `uMaskRadius` | `float` | Corner radius, as a fraction of card width |
| `uMaskFeather` | `float` | Edge softness |
| `uMaskInvert` | `float` | `0` = inside the rect (window, full), `1` = outside (reverse-holo sheet) |
| `uMaskView` | `float` | Debug: tint the masked zone red |

### Mask uniforms — the hand tier

A hand-drawn mask **beats** the layout tier.

| Uniform | Type | Meaning |
|---|---|---|
| `uMaskTex` | `sampler2D` | The hand mask. **Alpha is foil coverage**; RGB is display tint only. Falls back to a 1×1 opaque white texture so the sampler is always valid |
| `uMaskTexOn` | `float` | `1` = sample the texture instead of the rect |

**Exactly one V flip, ever.** The shader samples the mask with `y` inverted and
the source texture is uploaded unflipped. Two flips is the classic failure and it
is silent — a symmetric mask looks fine and an asymmetric one is upside down.

### Glyph slot

For patterns whose identity is a real emblem rather than a procedural shape.
Real artwork drops into a registered slot and is rasterized into an atlas; the
uniforms carry the atlas, its count and its grid. When no artwork is present the
recipe falls back to its procedural form, bit-for-bit the shipped look.

This exists so that supplying genuine glyph art needs **zero code change** — and
so that shipping without it is a supported state rather than a broken one. See
`NOTICE-CONVENTIONS.md` for what an asset has to carry before it may land there.

### Per-recipe parameters

`uP0` … `uP5`, all `float`, meaning defined per recipe and surfaced as labelled
sliders. Convention: **at most four**, each with a real label, range and default;
unused slots labelled as unused. Two more exist for recipes that genuinely
outgrew four.

### Helpers available to every recipe

Deterministic hash noise (`hash21`, `hash22`, `vnoise`, three-octave `fnoise`),
the saturation-aware cosine `hueRamp`, `screenBlend`, a rounded-rect SDF, the
rect mask, the card alpha, the shared `sheen`, and the glyph-atlas sampler. Plus
`PI`, `TAU` and `CARD_ASPECT`. For an isotropic pattern, multiply uv by
`vec2(1.0, CARD_ASPECT)`.

---

## The composite law

The order of operations, which is the part most easily got wrong:

1. **Card alpha**, then discard outside it — real cards have rounded corners.
2. **Sample the scan.**
3. **Mask** — the hand tier if present (absolute, never inverted), else the
   layout rect with the scope's invert applied.
4. **Art gate** — a luminance gate scaled by `uArtGate`.
5. **Ink estimates** — an 8-tap, two-ring **local contrast** measurement at fixed
   card-space radii. Crucially it is *relative*: a flat tone yields exactly zero.
   "Dark pixel means ink" would have been simpler and would have killed every
   render on a dark base. From it come the glyph-ink term (sacred), the detail-ink
   term, and the chroma term.
6. **The classic composite** — always computed, and the only path when
   `uScanBase` is 0.
7. **The scan path**, one of two mutually exclusive laws selected by `uMetal`:
   - **Metalness** (mirror only): the pattern perturbs a metal surface around a
     pivot; where the surface turns away it darkens the body, where it turns
     toward you it adds highlight.
   - **Additive** (everything else): the pattern is light added over the scan,
     with the substrate darkening where the pattern is *not*.
8. **The shared tail** — the light is tinted, then passed through a **compressive
   soft knee** against the per-pixel luminance headroom, then screen-blended or
   added with a per-channel no-clip cap.

### The invariants, and why each exists

**(a) The plain print is always recoverable.** `uIntensity` at zero, or the ink
guard off, renders exactly the scan. Both substrate terms are gated on intensity
so that an all-zero pattern field never reads as "the whole card turned away".

**(b) Text is sacred at every angle, under both laws.** Added light — the
pattern *and* the shared specular, on one shared budget — is bounded by the
per-pixel luminance headroom, applied as a compressive knee rather than a hard
clamp, plus a per-channel cap that cannot clip by construction. Glyph-dark pixels
are exempt from the flash and from every substrate term. `uArtGate` is the single
licensed exception.

**(c) Printed chroma is preserved.** The light rides its own hue, the chroma pop
is luminance-neutral, and every substrate darkening is multiplicative rather than
subtractive. This invariant is the fix for a long-standing "the reverse holos
look dull and grayish" complaint, which turned out to be the shared composite and
not any recipe: achromatic light screen-blended over coloured art raises all
three channels equally and compresses chroma.

**(d) `uScanBase 0` runs the classic composite textually unchanged.** The entire
scan section lives inside a branch. That is what lets every saved canon file
render bit-identically after a composite change, and it is how a major re-scoping
of the metalness law was proven to have moved no canon's blank appearance at all.

### The composite families

Keyed on duty cycle — how much of the face the recipe's own light covers.

| Family | Duty cycle | `uSheen` | `uSheenTint` | `uDepth` |
|---|---|---|---|---|
| flash | under ~20% | 3.4 | 0 | 0 |
| line | ~20–45% | 4.2 | 0 | 0.45 |
| stamp | sheet, sparse stamps | 3.6 | 0 | 0.22 |
| field | over ~45% | 3.0 | 0 | 0.6 |
| pearl | any | 1.2 | 0 | 0.2 |
| metal | mirror only | its own canon | 0.5 | — (metalness law) |

**`uDepth` is the trap.** It darkens where the pattern is *not*, so its cost
scales with `1 − duty`. Applying a field family's depth to a flash pattern
darkens almost the whole card.

`uSheenTint` is zero everywhere except mirror because tinting a highlight with
the ink underneath it was, on inspection, exactly the behaviour that had been
rejected.

---

## Versioning — structural, not a version number

**There is no `contract:` version field on a recipe, and no mismatch handler.**
That was considered and is not what the code does. Worth stating plainly, because
a reader expecting a version field will look for one and conclude it was
forgotten.

The contract is enforced structurally instead, in four ways:

1. **The family ↔ defaults pairing is the contract.** A recipe declares a
   composite family, and its defaults must spread that family's constants. That
   pairing is what a reviewer checks. It is not machine-checked, which is a known
   gap.
2. **Unknown keys in *data* are inert; unknown keys in a *recipe* are fatal.**
   The runtime applies only uniforms it knows, so a canon file carrying a
   uniform that was later removed silently does nothing and a canon predating a
   new uniform inherits the code default. But a recipe declaring a default for a
   nonexistent uniform is a hard error at material build, and a recipe body that
   fails to define the entry point is a shader compile error. Strict for code,
   tolerant for data — deliberately.
3. **Slug versioning, not contract versioning.** Renamed patterns keep an alias
   from the old id, permanently. **Old ids resolve forever; an id is never
   repurposed.** That is the migration discipline that replaces a version number.
4. **Canon files are full uniform snapshots, not deltas.** So changing a recipe's
   default never reaches a pattern that has been canon'd — you migrate the canon
   value in place and log it. This is also why splitting the dataset out of the
   renderer's repository would have let them drift *silently*.

Real version constants do exist elsewhere and are recorded in every artifact
they touch: the resolver version, the mask sidecar version, the training and
archive manifest versions. See [Provenance Model](Provenance-Model).

---

## Rules a new pattern must obey

1. **The signature exactly.** `vec3 foilPattern(vec2 uv, vec2 tilt)`, uv y-up.
2. **Pure GLSL.** No three.js, no React, no JavaScript. The recipe never sees the
   renderer.
3. **Deterministic.** Only the provided hash noise. No frame counters, no
   external state, no side channels.
4. **Tilt is the primary animator.** Time is ambient drift; a pattern that
   animates from time alone is wrong even when it looks right.
5. **Respect the output range.** `0..1` under the additive law, `0..1.5` under
   metalness. Do not rely on values above 1 unless you are mirror.
6. **Do not self-apply the shared terms.** Intensity, specular, darkening, the
   art gate, the masks and the substrate are all `main()`'s job. If your printing
   needs a zone the layout tier cannot express, that is a mask work item — not a
   pattern hack.
7. **Scale with `uScale`; feed the shared hue ramp.** Keep `uSat` semantics: 0 is
   silver.
8. **Do not sample `uFace`.** One documented exception exists, ever, and it is
   `detective-pikachu`, whose identity *is* beam × photograph.
9. **At most four parameters**, each with a real label, range, step and default.
10. **Match your family's constants**, and set the art gate by physics: window
    and full foils want it, mirror and reverse sheets do not. Start from full
    saturation and a wide hue spread — full spectral character is the baseline.
    Only override a family constant after looking at two or more assigned cards.
11. **Structural locks belong in GLSL; slider-reachable styling belongs in
    uniforms.** A gold pattern gets a private two-stop ramp function rather than
    a pinned hue-spread uniform.
12. **Platform constraints.** GLSL ES 1.00 under WebGL2: no fragment-stage LOD
    sampling, so no mip tricks. Use fixed UV taps in resolution-independent
    card-space units. This runs per fragment, every frame, on a phone, and the
    ink estimate already costs eight texture taps.
13. **Shared GLSL is banked-verdict territory.** Before touching a shared body,
    list which patterns' verification verdicts it invalidates and either re-judge
    them or leave it alone. Cosmetic sharpening of a passing pattern is
    deliberately not taken.

---

## Related

- [Foil Taxonomy](Foil-Taxonomy) — what the recipes are modelling
- [Provenance Model](Provenance-Model) — the mask tier that beats the layout tier
- [Pre-History](Pre-History) — rounds R0–R7, where this contract was argued into shape

_Last updated by Claude Fable 5 on behalf of @cheyras — 2026-08-31_

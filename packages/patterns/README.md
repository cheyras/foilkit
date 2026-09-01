# `@foilkit/patterns`

The 45 foil recipes, as data.

```ts
import { PATTERNS, patternById, canonicalPatternId } from '@foilkit/patterns'
```

Each recipe is a `FoilPattern`: a stable id, a taxonomy name, a composite
family, a note on which physical printings use it, a block of GLSL defining
`vec3 foilPattern(vec2 uv, vec2 tilt)`, the core-uniform defaults it tunes away
from the globals, and its labelled `uP0`–`uP5` parameters.

## The purity rule, and its one exception

A recipe is a **pure function of `(uv, tilt)`**. It draws light; it does not read
the card. That is what lets one shader assembly serve every pattern, and what
makes a recipe reviewable on its own.

`detective-pikachu` is the exception: it samples `uFace` inside `foilPattern()`,
because the treatment it models genuinely keys off the printed art. It is the
only one, it is documented at the recipe, and it stays documented — an
undocumented exception is how a rule stops being one.

## Aliases never orphan data

`PATTERN_ALIASES` keeps old slugs resolving forever, because saved mask
sidecars, canon files and stored preferences reference them. `sv-holo` →
`vertical-sheen` is the live case, from the 2026-08-02 correction. **Never
repurpose an old id for a different pattern**, and resolve through
`canonicalPatternId()` on read.

`canonFor()` and `referenceSlug()` live here rather than in `@foilkit/core` for
the same reason: both resolve an id through those aliases, and core does not
depend on this package at runtime, so the recipe corpus stays separately
versioned and individually importable.

## What each pattern IS

`docs/TAXONOMY.md` — one section per pattern: the physical process, which
printings carry it, and what the recipe does and does not model. Read that
before changing a recipe. The shader is a model of a thing, and the thing is
described there.

MIT. See `REUSE.toml`.

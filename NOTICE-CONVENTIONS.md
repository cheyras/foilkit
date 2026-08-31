# Notice-file conventions

The standing ownership rule (`AGENTS.md` F2) is: **ship nothing we do not own
outright; third-party material enters by source and reference, never by copy.**

This document specifies the artifact that proves the rule was followed.

## When a notice file is required

Any asset that is not obviously code, and that a reader might reasonably suspect
came from somewhere else, carries a notice. In practice:

- Original artwork, glyphs, icons or geometry authored to replace a third-party
  asset that was investigated and rejected.
- Any directory that accepts dropped-in assets, where files can land without
  review — the notice sets the rule *before* the first file arrives, not after.
- Any reference corpus that is cited rather than vendored, where the notice
  records what is cited and how to fetch it locally.
- Synthetic or demo content standing in for real cards.

Code files do not need one; their `SPDX-License-Identifier` header says
everything.

## Where it lives

Next to what it describes, named for what it covers:

```
data/foil-masks/MASKS-NOTICE.md
research/foil-glyphs/GLYPHS-NOTICE.md
packages/patterns/src/PATTERNS-NOTICE.md
```

Not in a central `licenses/` folder. A notice that is not adjacent to the asset
is a notice nobody finds when they are looking at the asset.

## The shape

Five sections, in this order. The template is DeckPal's
`apps/web/src/components/ENERGY-ICONS-NOTICE.md`, which this repository inherits
as convention.

### 1. What this covers — and the claim

Name the exact files or the exact directory. Then state the claim plainly:
authored for this project, not copied, traced or extracted from any third-party
asset set, game rip or scan.

Be specific about the method. "Hand-written inline SVG paths" is a checkable
claim; "original artwork" is not.

### 2. Why it is original — the research trail

**This is the section that does the work.** List what was investigated, in the
order it was investigated, and for each one: what it was, what was probed or
tested, the concrete result, and the verdict.

Record the failures with their evidence:

> Probed the likely type/energy paths (`/en/types/<t>.png|webp`, `/types/...`,
> `/univ/types/...`) for fire/water/grass/lightning: **all 404**. TCGdex does not
> serve type/energy symbols. **Rejected.**

> Ships only the 18 video-game types (bug, electric, flying, ground, …). Does
> **not** contain the TCG's distinct energy set — `colorless`, `darkness`,
> `lightning`, `metal` are TCG-specific and absent. Not a match. **Rejected.**

> License resolves to **NOASSERTION** — no clear grant. Not redistributable.
> **Rejected.**

A rejection trail is what proves an investigation happened. A notice that names
only the winner reads exactly like a notice written after the fact to justify
something already committed, and it is worth very little to a reviewer.

Include permissively-licensed options that were rejected for *quality* or *fit*
reasons, and say which. "MIT but wrong set" and "right set but NOASSERTION" are
different rejections and both belong.

### 3. Who authored it

Name the author. For agent-authored assets, name the agent and the human it
worked on behalf of, matching the commit trailers. Link the pull request or the
commit if one exists.

### 4. License

State it explicitly, with an SPDX identifier and a link:

> Released into the public domain under **CC0 1.0**
> (<https://creativecommons.org/publicdomain/zero/1.0/>), SPDX `CC0-1.0`.

If the asset is CC0 it must also be covered by a `REUSE.toml` glob, since PNG
and SVG binaries cannot carry a header. Say which glob covers it.

### 5. Trademark note

Where the asset depicts or evokes a trademarked concept, say so and say what the
grant does not cover:

> "Pokémon" and the individual energy-type concepts are trademarks of Nintendo /
> The Pokémon Company. These glyphs are original artwork evoking those types; the
> CC0 grant covers this artwork only, and no third-party trademark.

Neither MIT nor CC0 can grant a right the grantor does not hold. Saying so
costs a sentence and removes an entire category of misunderstanding.

## Drop-slot directories

A directory designed so files land with no review step is the highest-risk shape
in the repository, because the rule has to be in place before anyone uses it.

Its notice states, in the README that already lives there:

1. **Originals only.** No traced, extracted or derived third-party marks.
2. **Every file arrives with its notice**, in the same commit — not "to be added
   later".
3. **The fallback if that cannot be met:** the directory stays gitignored and the
   assets resolve locally at development time, exactly as cited reference media
   does. Nothing ships.

The third point is the important one. A drop slot with no fallback is a slot that
will eventually receive something it should not, and the pressure at that moment
will be to ship it anyway.

## Reference corpora that are cited, not vendored

Where the working material is third-party media — video frames, scans — the
pixels do not ship. What ships:

- A **notice** naming every source: identifier or URL, creator, and what was used
  from it.
- A **fetch script** that reproduces the local corpus from those sources, with
  every parameter written down. A parameter recorded nowhere is a corpus that
  will not reproduce; frame width and keyframe-selection rule are exactly the
  ones that get forgotten.
- A **two-tier manifest**, committed even though the media is not:
  - **Sources — exact:** identifier, duration, sha256 of the fetched stream. A
    re-fetch that resolves to different content then fails loudly instead of
    quietly corrupting the corpus.
  - **Derived artifacts — structural:** file count per directory, dimensions, and
    the parent source's hash matching. Not byte hashes — different tool versions
    re-encode differently, and a naive hash gate fails on correct fetches.
- **Your own analysis**, which is the part that holds nearly all the working
  value and is entirely ours to publish.

Quotations of third-party material inside your own analysis are a much lower
exposure than reproduction, but decide rather than overlook: either attribute by
timestamp and keep the quote short, or write down why it stays. Record the
decision either way.

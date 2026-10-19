<!-- SPDX-License-Identifier: CC0-1.0 -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# Human etch records

`<cardId>/<variantId>.json` is a person's decision about one printing's etch plate. It always wins over the
generated etch in `data/generated-masks/`, and no regeneration touches it (AGENTS.md F4). Records are written
by the editor's etch mode through `PUT /api/etch`; `DELETE /api/etch` reverts a printing to its generated etch.

| File | What it is |
|---|---|
| `<variantId>.json` | the record (below) |
| `<variantId>.png` | the baked etch plate, 1008 × 1408, 8-bit grey: 255 = foil (no line), 0 = line or solid. Absent when the record only switches the etch on or off. |
| `<variantId>.segs.png` | the segment map it was baked from, 504 × 704, 8-bit labels (see `legend`) |

## The record

```json
{
  "version": 1,
  "cardId": "sv06-130",
  "variantId": 29851,
  "enabled": true,
  "base": { "kind": "generated", "sha256": "…" },
  "sections": {
    "A": { "pattern": "contour", "angle": 135, "pitch": 4.85, "weight": 0.55, "cx": 0.5, "cy": 0.35, "phase": 0, "amount": 0.5, "note": "body" },
    "B": { "pattern": "solid", "angle": 0, "pitch": 4.85, "weight": 0.55, "cx": 0.5, "cy": 0.35, "phase": 0, "amount": 0.5, "note": "eyes" }
  },
  "legend": { "0": "keep …", "1": "white …", "2": "black …", "3": "section A", "…": "…" },
  "files": { "etch": "29851.png", "segs": "29851.segs.png" },
  "savedAt": "…",
  "author": { "login": "…", "id": 1 }
}
```

- `enabled: false` means this printing shows **no etch**, whatever the generator produced.
- `base` says what label 0 (keep) shows: the generated etch it was edited over, by hash, or plain foil.
- `sections` are the **rules**. Each painted region names its pattern, line direction (degrees), pitch (px at
  1008 wide), line weight (dark fraction), centre (0..1, for `arcs` and `radial`), phase and amount. The optional
  `note` says what the region is ("eyes", "fire", "sky"). That is the signal an agent learns from: which pattern
  people choose for which kind of region.

## The patterns

`contour`, `arcs`, `parallel`, `wave`, `radial`, `crosshatch`, `chevron`, `shards`, `stipple`, `solid`, `clear`.
They are defined in `apps/editor/src/etch/patterns.ts`.

Defaults come from measuring 160 modern-era reference etches in 48 px patches. Those references are local and
never committed; only the numbers below carry over.

| Measure | Value |
|---|---|
| Blank (full foil) | 50% |
| Curved / concentric | 33% |
| Parallel | 10% |
| Cross-hatch | 3.7% |
| Stipple | 2.5% |
| Solid | 1% |
| Line pitch | median 4.85 px at 1008 wide (0.30 mm) |
| Line weight | 0.51–0.61 dark |
| Border band | diagonal (`chevron`) |
| Eyes | always solid |

# editor shell (staged port)

The five lab-surface files carried verbatim from DeckPal `foil/main` @ b803b43
(`apps/web/src/foil/`): `FoilLab.tsx`, `CanonLab.tsx`, `MaskProvenance.tsx`,
`ui.tsx`, `api.ts`. They are NOT wired into any build yet — subtask 7/8 turns
them into the hosted editor at foilkit.deckpal.app (static catalog, ownership
stripped, `BASE` seam swapped for the static reader, staging layer for writes).

Same-author code (see RELICENSE.md); MIT. Imports still reference DeckPal
package paths and will be repointed at `@foilkit/*` during the wiring.

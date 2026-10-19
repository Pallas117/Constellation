# Refined brand symbols (source copies)

Flat vector symbols from the Lightbound Design System artifact ("Symbols" group, refined 16–18 Oct 2026),
https://claude.ai/artifact/CvWgPQyJio2m5uHPyZZHdv. Copied unchanged; the Lightbound Brand Book (15 Oct, with
16 and 18 Oct updates) is the rule set:

- Lightbound "Black hole": the ray-traced silhouette, flat, 3-stop gradient, ring 7 units (no blur).
- Gauss Aurora "Radiation belts": two solid belts (outer lime, inner amber), one L 6.4 field line; reads at 16 px.
- Turnstone v6 (approved 18 Oct): ruddy turnstone landing at the tide line. Minimum 32 px; below that use the badge.
- Constellation: vector redraw of the Aug 2025 logo (navy disc, gold beaded ring, 3 gold + 4 white nodes);
  the 3-node icon is for 32 px and under.

`website/tools/make_lockups.py` builds the horizontal lockups from these; `build_assets.py` copies them into
`public/assets/marks/`. Do not edit the symbols here: update the Design System and copy them again.

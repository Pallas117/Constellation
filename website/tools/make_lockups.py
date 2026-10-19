"""Horizontal lockups for all four brands, built to the Lightbound Brand Book's lockup rule.

Brand Book, "Logo system (refined, 16 Oct)": symbol 56 px, wordmark IBM Plex Sans Medium 22 px caps, 20 px gap;
sublines JetBrains Mono 9 px. Tracking: Lightbound 24 %, Gauss 16 %, Turnstone 32 %, Constellation 20 %.
Text is outlined, so no font is needed. Gauss keeps the kit lockup's two-tone "GAUSS AURORA" (AURORA in lime).

usage: <python with fonttools> website/tools/make_lockups.py <Lightbound Brand Kit dir>
Reads website/tools/symbols/*.svg. Writes the Lightbound, Gauss and Constellation lockups to website/public/assets/marks/
and the Turnstone lockup to website/tools/symbols/ (reference only: the site shows Turnstone as mark + text wordmark).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "public" / "assets" / "marks"
WARM, MUTED, GOLD, LIME = "#f3f0e8", "#a9aba6", "#b0906f", "#ccff00"

LOCKUPS = {
    # name: (symbol file, wordmark segments [(text, colour)], tracking, subline or None, subline colour, accessible name)
    # Turnstone is endorsed ("a Lightbound company"); Constellation carries no Lightbound badge (Brand Book, architecture).
    "lightbound": ("lightbound-symbol-colour-dark.svg", [("LIGHTBOUND", WARM)], 0.24, None, None, "Lightbound"),
    "gauss-aurora": ("gauss-aurora-symbol-colour-dark.svg", [("GAUSS ", WARM), ("AURORA", LIME)], 0.16, None, None, "Gauss Aurora"),
    "turnstone": ("turnstone-symbol-colour-dark.svg", [("TURNSTONE", WARM)], 0.32, "A LIGHTBOUND COMPANY", MUTED, "Turnstone, a Lightbound company"),
    "constellation": ("constellation-symbol-colour-dark.svg", [("CONSTELLATION", WARM)], 0.20, "SPACE COMMUNITY GROUP", GOLD, "Constellation, space community group"),
}
SYMBOL, GAP, WORD_PX, SUB_PX, SUB_TRACK, LINE_GAP = 56.0, 20.0, 22.0, 9.0, 0.14, 7.0


def text_path(font: TTFont, text: str, size: float, tracking: float, x0: float, baseline: float) -> tuple[str, float]:
    """Outline `text` at a font size in px with letter-spacing in em; returns (path d, width)."""
    glyphs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm
    scale = size / upm
    pen = SVGPathPen(glyphs)
    x = x0
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        x += glyphs[name].width * scale + (tracking * size if i < len(text) - 1 else 0)
    d = re.sub(r"-?\d+\.\d+", lambda m: f"{float(m.group()):.2f}".rstrip("0").rstrip("."), pen.getCommands())
    return d, x - x0


def cap(font: TTFont, size: float) -> float:
    return font["OS/2"].sCapHeight / font["head"].unitsPerEm * size


def nested_symbol(svg: str) -> str:
    """The symbol as a nested <svg> sized 56 x 56 at the origin."""
    view_box = re.search(r'viewBox="([^"]+)"', svg).group(1)
    inner = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", svg.strip())
    return f'<svg x="0" y="0" width="{SYMBOL:g}" height="{SYMBOL:g}" viewBox="{view_box}">{inner}</svg>'


def main(kit: Path) -> None:
    plex = TTFont(kit / "fonts" / "IBMPlexSans-Medium.ttf")
    mono = TTFont(kit / "fonts" / "JetBrainsMono-Regular.ttf")
    for name, (symbol, segments, track, sub, sub_colour, label) in LOCKUPS.items():
        block = cap(plex, WORD_PX) + ((LINE_GAP + cap(mono, SUB_PX)) if sub else 0)
        word_base = SYMBOL / 2 - block / 2 + cap(plex, WORD_PX)
        x0 = SYMBOL + GAP
        x, paths = x0, []
        for i, (text, colour) in enumerate(segments):
            d, w = text_path(plex, text, WORD_PX, track, x, word_base)
            paths.append(f'<path d="{d}" fill="{colour}"/>')
            x += w + (track * WORD_PX if i < len(segments) - 1 else 0)
        word_w = x - x0
        sub_w = 0.0
        if sub:
            sub_base = word_base + LINE_GAP + cap(mono, SUB_PX)
            sub_d, sub_w = text_path(mono, sub, SUB_PX, SUB_TRACK, x0 + 1, sub_base)
            paths.append(f'<path d="{sub_d}" fill="{sub_colour}"/>')
            sub_w += 1
        width = round(x0 + max(word_w, sub_w), 2)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:g} {SYMBOL:g}" width="{width:g}" height="{SYMBOL:g}" '
               f'role="img" aria-label="{label}"><title>{label}</title>'
               f'{nested_symbol((HERE / "symbols" / symbol).read_text(encoding="utf-8"))}{"".join(paths)}</svg>\n')
        (HERE / "symbols" if name == "turnstone" else OUT).joinpath(f"{name}-horizontal-colour-dark.svg").write_text(svg, encoding="utf-8")
        print(f"{name}: {width:g} x {SYMBOL:g}, {len(svg)} bytes")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

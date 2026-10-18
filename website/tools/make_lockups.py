"""Horizontal lockups for Turnstone and Constellation, built to the Lightbound Brand Book's lockup rule.

Brand Book, "Logo system (refined, 16 Oct)": symbol 56 px, wordmark IBM Plex Sans Medium 22 px caps, 20 px gap;
sublines JetBrains Mono 9 px. Tracking: Turnstone 32 %, Constellation 20 %. Text is outlined, so no font is needed.

usage: <python with fonttools> website/tools/make_lockups.py <Lightbound Brand Kit dir>
Reads website/tools/symbols/*.svg. Writes the Constellation lockup to website/public/assets/marks/ (used on the site) and
the Turnstone lockup to website/tools/symbols/ (reference only: the site keeps Turnstone to its mark and a text wordmark).
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
WARM, MUTED, GOLD = "#f3f0e8", "#a9aba6", "#b0906f"

LOCKUPS = {
    # name: (symbol file, wordmark, tracking, subline, subline colour, accessible name)
    # Turnstone is endorsed ("a Lightbound company"); Constellation carries no Lightbound badge (Brand Book, architecture).
    "turnstone": ("turnstone-symbol-colour-dark.svg", "TURNSTONE", 0.32, "A LIGHTBOUND COMPANY", MUTED, "Turnstone, a Lightbound company"),
    "constellation": ("constellation-symbol-colour-dark.svg", "CONSTELLATION", 0.20, "SPACE COMMUNITY GROUP", GOLD, "Constellation, space community group"),
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
    for name, (symbol, word, track, sub, sub_colour, label) in LOCKUPS.items():
        block = cap(plex, WORD_PX) + LINE_GAP + cap(mono, SUB_PX)
        word_base = SYMBOL / 2 - block / 2 + cap(plex, WORD_PX)
        sub_base = word_base + LINE_GAP + cap(mono, SUB_PX)
        x0 = SYMBOL + GAP
        word_d, word_w = text_path(plex, word, WORD_PX, track, x0, word_base)
        sub_d, sub_w = text_path(mono, sub, SUB_PX, SUB_TRACK, x0 + 1, sub_base)
        width = round(x0 + max(word_w, sub_w + 1), 2)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:g} {SYMBOL:g}" width="{width:g}" height="{SYMBOL:g}" '
               f'role="img" aria-label="{label}"><title>{label}</title>'
               f'{nested_symbol((HERE / "symbols" / symbol).read_text(encoding="utf-8"))}'
               f'<path d="{word_d}" fill="{WARM}"/><path d="{sub_d}" fill="{sub_colour}"/></svg>\n')
        (OUT if name == "constellation" else HERE / "symbols").joinpath(f"{name}-horizontal-colour-dark.svg").write_text(svg, encoding="utf-8")
        print(f"{name}: {width:g} x {SYMBOL:g}, {len(svg)} bytes")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

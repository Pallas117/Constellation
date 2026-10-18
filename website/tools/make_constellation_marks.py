"""Constellation mark, 2026 refresh: generates the mark and lockups in the Lightbound kit's style.

Keeps the original's identity (night-sky disc, the constellation figure with gold nodes, the orbit
ring with planets) and redraws it the way the 2026 kit draws its marks: thin warm-white line art on
black, one accent colour (kit amber #E7B14A, the closest kit colour to the old gold), and the
wordmark as IBM Plex Sans outlines so no font is needed.

usage: <python with fonttools> website/tools/make_constellation_marks.py <brand kit>/fonts/IBMPlexSans-Medium.ttf <out_dir>
Writes marks/constellation-mark-<variant>.svg and lockups/constellation-{horizontal,stacked}-<variant>.svg
for variant in colour-dark, colour-light, white, black.
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

WARM_WHITE, BLACK, CHARCOAL, AMBER, GREY = "#F3F0E8", "#050505", "#252A2A", "#E7B14A", "#A9ABA6"

VARIANTS = {
    #               lines inside disc, disc fill, disc edge, orbit,      accent, wordmark,   subtitle
    "colour-dark": (WARM_WHITE, BLACK, WARM_WHITE, WARM_WHITE, AMBER, WARM_WHITE, GREY),
    "colour-light": (WARM_WHITE, BLACK, BLACK, CHARCOAL, AMBER, BLACK, CHARCOAL),
    "white": (WARM_WHITE, "none", WARM_WHITE, WARM_WHITE, WARM_WHITE, WARM_WHITE, WARM_WHITE),
    "black": (BLACK, "none", BLACK, BLACK, BLACK, BLACK, BLACK),
}

C, R_DISC, R_ORBIT = 100.0, 56.0, 77.0
# The original figure's nodes, in disc radii from the disc centre (read off Constellation Logo 1/Logo.png).
NODES = {"A": (-0.54, -0.50), "B": (0.35, -0.65), "C": (0.50, -0.05), "D": (0.09, 0.35),
         "E": (-0.62, -0.04), "F": (-0.65, 0.27), "G": (0.65, 0.41)}
GOLD = {"A", "C", "D"}
EDGES = [("A", "B"), ("B", "C"), ("A", "C"), ("C", "D"), ("D", "F"), ("D", "G"), ("A", "E")]
EDGE_ANGLE = -5.0          # C runs out to the disc edge here
H_ANGLE = 116.0            # D runs out past the disc to a planet on the orbit: per aspera ad astra
PLANETS = [(-90.0, 3.4), (-7.0, 2.8), (180.0, 2.8), (37.0, 2.4), (H_ANGLE, 4.0)]
GAP = 7.0                  # degrees of orbit left open around each planet
STARS = [(-0.20, -0.20), (0.12, -0.32), (-0.30, 0.62), (0.40, 0.70), (-0.78, 0.40), (0.78, -0.30),
         (0.05, 0.05), (-0.10, -0.80), (0.62, 0.12), (-0.42, 0.10), (0.25, 0.55), (-0.60, -0.70)]


def pt(nx: float, ny: float, r: float = R_DISC) -> tuple[float, float]:
    return C + nx * r, C + ny * r


def polar(deg: float, r: float) -> tuple[float, float]:
    a = math.radians(deg)
    return C + r * math.cos(a), C + r * math.sin(a)


def f(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def mark_body(variant: str) -> str:
    line, disc_fill, disc_edge, orbit, accent, _, _ = VARIANTS[variant]
    out = [f'<circle cx="{f(C)}" cy="{f(C)}" r="{f(R_DISC)}" fill="{disc_fill}" stroke="{disc_edge}" stroke-width="1.8"/>']
    if disc_fill != "none":
        for sx, sy in STARS:
            x, y = pt(sx, sy)
            out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="0.8" fill="{line}" opacity="0.55"/>')
    # Orbit ring, broken around each planet.
    stops = sorted(a % 360 for a, _ in PLANETS)
    for i, a in enumerate(stops):
        b = stops[(i + 1) % len(stops)] + (360 if i == len(stops) - 1 else 0)
        start, end = a + GAP, b - GAP
        x1, y1 = polar(start, R_ORBIT)
        x2, y2 = polar(end, R_ORBIT)
        large = 1 if (end - start) > 180 else 0
        out.append(f'<path d="M{f(x1)} {f(y1)} A{f(R_ORBIT)} {f(R_ORBIT)} 0 {large} 1 {f(x2)} {f(y2)}" '
                   f'fill="none" stroke="{orbit}" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>')
    # Constellation figure.
    pts = {k: pt(*v) for k, v in NODES.items()}
    segs = [(pts[a], pts[b]) for a, b in EDGES]
    segs.append((pts["C"], polar(EDGE_ANGLE, R_DISC)))
    segs.append((pts["D"], polar(H_ANGLE, R_ORBIT)))
    for (x1, y1), (x2, y2) in segs:
        out.append(f'<line x1="{f(x1)}" y1="{f(y1)}" x2="{f(x2)}" y2="{f(y2)}" stroke="{line}" stroke-width="1.6" stroke-linecap="round"/>')
    for k, (x, y) in pts.items():
        gold = k in GOLD
        out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{3.4 if gold else 2.4}" fill="{accent if gold else line}"/>')
    for a, r in PLANETS:
        x, y = polar(a, R_ORBIT)
        out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{r}" fill="{accent}"/>')
    return "\n".join(out)


def text_path(font: TTFont, text: str, cap_px: float, tracking_em: float, x0: float, baseline: float) -> tuple[str, float]:
    """Outline `text` at a given cap height; returns (path d, advance width in px)."""
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    cap = font["OS/2"].sCapHeight
    scale = cap_px / cap
    pen = SVGPathPen(glyphs)
    x = x0
    upem = font["head"].unitsPerEm
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        tpen = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
        glyphs[name].draw(tpen)
        x += glyphs[name].width * scale
        if i < len(text) - 1:
            x += tracking_em * upem * scale
    # One decimal is sub-pixel at any size we show; it roughly halves the file.
    d = re.sub(r"-?\d+\.\d+", lambda m: f"{float(m.group()):.1f}".rstrip("0").rstrip("."), pen.getCommands())
    return d, x - x0


def svg(view_w: float, view_h: float, body: str, title: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f(view_w)} {f(view_h)}" '
            f'width="{f(view_w)}" height="{f(view_h)}" role="img" aria-label="{title}">\n'
            f"<title>{title}</title>\n{body}\n</svg>\n")


def main(font_path: str, out_dir: str) -> None:
    font = TTFont(font_path)
    out = Path(out_dir)
    (out / "marks").mkdir(parents=True, exist_ok=True)
    (out / "lockups").mkdir(parents=True, exist_ok=True)
    for variant in VARIANTS:
        _, _, _, _, _, word, sub = VARIANTS[variant]
        body = mark_body(variant)
        (out / "marks" / f"constellation-mark-{variant}.svg").write_text(
            svg(200, 200, body, "Constellation"), encoding="utf-8")

        # Horizontal: mark 320 px tall at left; wordmark caps 84 px; subtitle caps 28 px (a third, as in the Turnstone lockup).
        scale = 320 / 200
        word_d, word_w = text_path(font, "CONSTELLATION", 84, 0.42, 0, 0)
        sub_d, sub_w = text_path(font, "SPACE COMMUNITY GROUP", 28, 0.40, 0, 0)
        text_x, base = 30 + 320 + 56, 286
        word_d, _ = text_path(font, "CONSTELLATION", 84, 0.42, text_x, base)
        sub_d, _ = text_path(font, "SPACE COMMUNITY GROUP", 28, 0.40, text_x + 4, base + 78)
        w = text_x + max(word_w, sub_w) + 40
        horiz = (f'<g transform="translate(30 96) scale({f(scale)})">\n{body}\n</g>\n'
                 f'<path d="{word_d}" fill="{word}"/>\n<path d="{sub_d}" fill="{sub}"/>')
        (out / "lockups" / f"constellation-horizontal-{variant}.svg").write_text(
            svg(w, 512, horiz, "Constellation, space community group"), encoding="utf-8")

        # Stacked: mark centred above, then wordmark and subtitle centred.
        sw = max(word_w, sub_w) + 80
        mx = (sw - 320) / 2
        word_d, _ = text_path(font, "CONSTELLATION", 84, 0.42, (sw - word_w) / 2, 320 + 60 + 84)
        sub_d, _ = text_path(font, "SPACE COMMUNITY GROUP", 28, 0.40, (sw - sub_w) / 2, 320 + 60 + 84 + 72)
        stacked = (f'<g transform="translate({f(mx)} 20) scale({f(scale)})">\n{body}\n</g>\n'
                   f'<path d="{word_d}" fill="{word}"/>\n<path d="{sub_d}" fill="{sub}"/>')
        (out / "lockups" / f"constellation-stacked-{variant}.svg").write_text(
            svg(sw, 320 + 60 + 84 + 72 + 40, stacked, "Constellation, space community group"), encoding="utf-8")
    print(f"wrote {len(VARIANTS) * 3} SVGs to {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

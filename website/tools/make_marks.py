"""Constellation, Turnstone and Argo symbols and the Gauss icon, generated on a strict grid.

Constellation (refined 4 Nov 2026, Josh: "more clean and professional"):
- Constellation: navy disc; one gold ring broken by five stars spaced exactly 72 degrees apart; three gold key stars on
  an equilateral triangle, each with one white star off it. One stroke weight per colour, one size per kind of star.
  Below 32 px use the icon: solid ring and the bold triangle only.
- Turnstone v11 (5 Nov 2026): one stroke weight, the bird implied inside its orbit ring; see turnstone_body.
- Argo: a square sail in the wind, set by Canopus; see argo.

Colours are the Brand Book tokens; the light variants use the "on light" tokens (gold-700, earth-700, signal-700).
usage: python3 website/tools/make_marks.py      (writes website/tools/symbols/; build_assets.py and make_lockups.py
take them from there)
"""
from __future__ import annotations

import math
from pathlib import Path

OUT = Path(__file__).resolve().parent / "symbols"
DARK = {"star": "#ccff00", "navy": "#081c4d", "gold": "#b0906f", "ring": "#b0906f", "warm": "#f3f0e8", "blue": "#318ada", "orange": "#f0782a", "cut": "#050505"}
LIGHT = {**DARK, "star": "#3f7a26", "ring": "#86684a", "warm": "#050505", "blue": "#2170b7", "orange": "#b44f0d", "cut": "#ffffff"}
# On light grounds the disc stays navy, so its stars keep the dark-theme colours; only the ring outside it changes.
LIGHT_DISC = {"gold": DARK["gold"], "star": DARK["warm"]}


def num(v: float) -> str:
    return f"{v:.1f}".rstrip("0").rstrip(".")


def polar(cx: float, cy: float, r: float, deg: float) -> tuple[float, float]:
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def svg(view_box: str, body: list[str]) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}">{"".join(body)}</svg>\n'


def constellation(c: dict[str, str], icon: bool = False, light: bool = False) -> str:
    centre, disc, ring = 400, 300, 352
    gold, star = (LIGHT_DISC["gold"], LIGHT_DISC["star"]) if light else (c["gold"], c["warm"])
    body = [f'<circle cx="{centre}" cy="{centre}" r="{disc}" fill="{c["navy"]}"/>']
    if icon:
        body.append(f'<circle cx="{centre}" cy="{centre}" r="{ring}" fill="none" stroke="{c["ring"]}" stroke-width="28"/>')
    else:
        gap = 9  # degrees of ring left open either side of each ring star
        for i in range(5):
            (x0, y0), (x1, y1) = polar(centre, centre, ring, -90 + 72 * i + gap), polar(centre, centre, ring, -90 + 72 * (i + 1) - gap)
            body.append(f'<path d="M{num(x0)} {num(y0)}A{ring} {ring} 0 0 1 {num(x1)} {num(y1)}" fill="none" stroke="{c["ring"]}" stroke-width="14" stroke-linecap="round"/>')
            x, y = polar(centre, centre, ring, -90 + 72 * i)
            body.append(f'<circle cx="{num(x)}" cy="{num(y)}" r="20" fill="{c["ring"]}"/>')
    angles = (-105, 15, 135)  # an equilateral triangle, turned 15 degrees so it doesn't sit flat
    keys = [polar(centre, 412, 150, a) for a in angles]  # centred a touch low: the optical centre of the disc
    outs = [polar(x, y, 112, a + 22) for (x, y), a in zip(keys, angles)]
    if not icon:
        body += [f'<line x1="{num(kx)}" y1="{num(ky)}" x2="{num(ox)}" y2="{num(oy)}" stroke="{star}" stroke-width="8" stroke-linecap="round"/>'
                 for (kx, ky), (ox, oy) in zip(keys, outs)]
    points = " ".join(f"{num(x)} {num(y)}" for x, y in keys)
    body.append(f'<polygon points="{points}" fill="none" stroke="{gold}" stroke-width="{26 if icon else 12}" stroke-linejoin="round"/>')
    if not icon:
        body += [f'<circle cx="{num(x)}" cy="{num(y)}" r="13" fill="{star}"/>' for x, y in outs]
    body += [f'<circle cx="{num(x)}" cy="{num(y)}" r="{46 if icon else 24}" fill="{gold}"/>' for x, y in keys]
    return svg("20 20 760 760", body)


def poly(points: list[tuple[float, float]], fill: str) -> str:
    return f'<polygon points="{" ".join(f"{num(x)} {num(y)}" for x, y in points)}" fill="{fill}"/>'


MIRROR = '<g transform="matrix(-1 0 0 1 240 0)">'  # mirror about x = 120

# Turnstone wing sweeps, right side: (shoulder, control, tip). The leading feather first; each starts lower and ends
# shorter, so the three read as one wing caught mid-beat.
TURNSTONE_WING = [((128, 110), (150, 46), (218, 26)), ((132, 124), (160, 72), (208, 52)), ((136, 138), (166, 98), (198, 78))]


def both(el: str) -> list[str]:
    """An element and its mirror image: the bird is exactly symmetric."""
    return [el, MIRROR + el + "</g>"]


def turnstone_body(c: dict[str, str], small: bool = False) -> list[str]:
    """Turnstone v11 (5 Nov 2026, Josh: "We need a more uniform structure with motion, mystique that embodies the
    lightbound brand").

    Built from the Lightbound mark system instead of drawn as an illustration: one stroke weight throughout, like the
    Gauss field lines and the Constellation ring. The orbit ring is the original Turning-tide mark's tide; the head is
    its Moon point, in signal orange. Three nested sweeps per wing are a wingbeat caught mid-stroke, and the wingtips
    break out of the ring: carry hope, go beyond. The body is an almond of two arcs, open, so the bird is implied rather
    than drawn. Where a wing crosses the ring, the ring breaks (a ground-coloured underlay drawn first). `small` is the
    same drawing with a heavier stroke, for 32 px and below.
    """
    w = 10 if small else 7

    def stroke(d: str, colour: str, width: float = w) -> str:
        return f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}" stroke-linecap="round"/>'

    wings = [f"M{sx} {sy}Q{qx} {qy} {tx} {ty}" for (sx, sy), (qx, qy), (tx, ty) in TURNSTONE_WING]
    out = [f'<circle cx="120" cy="120" r="96" fill="none" stroke="{c["blue"]}" stroke-width="{w}"/>']  # the turning tide
    for d in wings:
        out += both(stroke(d, c["cut"], w + 10))  # breaks in the ring where the wings cross it
    for d in wings:
        out += both(stroke(d, c["warm"]))
    out += both(stroke("M120 100C131 114 133 140 120 164", c["warm"]))  # the body
    out.append(f'<circle cx="120" cy="82" r="{10 if small else 9}" fill="{c["orange"]}"/>')  # the Moon point
    return out


def turnstone(c: dict[str, str]) -> str:
    return svg("12 8 216 216", turnstone_body(c))


def turnstone_badge(c: dict[str, str]) -> str:
    """The mark is already a ringed emblem; at 32 px and below it is drawn with a heavier stroke."""
    return svg("12 8 216 216", turnstone_body(DARK, small=True))


def star4(cx: float, cy: float, r: float, waist: float, fill: str) -> str:
    """A four-point star: long points on the axes, the waist between them."""
    pts = [polar(cx, cy, r if i % 2 == 0 else waist, -90 + 45 * i) for i in range(8)]
    return poly(pts, fill)


def argo(c: dict[str, str], icon: bool = False) -> str:
    """Argo: a square sail in the wind, set by Canopus (Josh, 5 Nov 2026: "Argo could be just a sail", then "a sail in
    the wind"; approved the same day).

    Argo is the ship of the old constellation Argo Navis; its brightest star, Canopus, has been a spacecraft's
    reference star since Mariner 3 and 4 carried the first Canopus star trackers (1964). So the one lime element is the
    star the sail is set by. Seen from the side: the luff on the mast, every seam sagging down-wind and the free edge
    (leech) bellied out most at two-thirds height, where the cloth fills. Three panels with fine real gaps (no ground-coloured
    cuts, so it sits on any surface), a fine mast and braced yard, and the sheet from the clew (Josh: "more realistic
    and less chunky"). The icon drops the sheet and opens the gaps for 16 px.
    """
    gap = 7 if icon else 4.5  # fine seams; the icon opens them so they survive 16 px
    mast = 92

    def leech(y: float) -> float:
        t = min(max((y - 40) / 150, 0), 1)
        return 152 + 40 * math.sin(math.pi * t * 0.8)

    def seam(y: float) -> tuple[tuple[float, float], ...]:
        x1 = leech(y)
        return (mast, y), (mast + (x1 - mast) * 0.45, y + 2), (x1 - 10, y + 15), (x1, y + 19)

    def pt(p: tuple[float, float]) -> str:
        return f"{num(p[0])} {num(p[1])}"

    rows = [42, 92, 142, 190]
    w = 6 if icon else 4  # a fine mast and yard, not a post
    body = [f'<path d="M{mast} 20V218" fill="none" stroke="{c["warm"]}" stroke-width="{w}" stroke-linecap="round"/>',  # the mast
            f'<path d="M80 37L164 28" fill="none" stroke="{c["warm"]}" stroke-width="{w}" stroke-linecap="round"/>']  # the yard
    if not icon:
        body.append(f'<path d="M188 208L{mast + 6} 216" fill="none" stroke="{c["warm"]}" stroke-width="2.5" stroke-linecap="round"/>')  # the sheet
    for i in range(3):
        y0, y1 = rows[i] + (gap / 2 if i else 0), rows[i + 1] - (gap / 2 if i < 2 else 0)
        a0, c1, c2, a1 = seam(y0)
        b0, d1, d2, b1 = seam(y1)
        belly = ((a1[0] + b1[0]) / 2 + 8, (a1[1] + b1[1]) / 2)
        body.append(f'<path d="M{pt(a0)}C{pt(c1)} {pt(c2)} {pt(a1)}Q{pt(belly)} {pt(b1)}C{pt(d2)} {pt(d1)} {pt(b0)}Z" fill="{c["warm"]}"/>')
    body.append(star4(198, 40, 28 if icon else 20, 6 if icon else 3.5, c["star"]))
    return svg(ARGO_ICON_BOX if icon else "60 10 166 214", body)


ARGO_ICON_BOX = "40 12 200 200"  # square, centred on the sail and star, for the favicon tile


def body_of(svg_text: str) -> str:
    return svg_text.split(">", 1)[1].rsplit("</svg>", 1)[0]


def tile(inner: str, view_box: str, size: int = 64, pad: float = 6, ground: str = "#050505") -> str:
    """An app icon / favicon: a symbol centred on a black rounded square (radius 14 of 64)."""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}"><rect width="{size}" height="{size}" rx="14" fill="{ground}"/>'
            f'<svg x="{pad}" y="{pad}" width="{size - 2 * pad}" height="{size - 2 * pad}" viewBox="{view_box}">{inner}</svg></svg>\n')


def gauss_icon() -> str:
    """Gauss Aurora at favicon size, from the Design System symbol: its two belts, and Earth as a solid warm disc.

    The full mark is 2.45:1 wide, so in a square it fell to 6 px tall and its L = 6.4 field line and 4-unit Earth outline
    vanished. The icon keeps only what reads at 16 px and crops to the belts.
    """
    import re
    src = (OUT / "gauss-aurora-symbol-colour-dark.svg").read_text(encoding="utf-8")
    belts = "".join(re.findall(r'<path d="[^"]+" fill="#(?:ccff00|e7b14a)"></path>', src))
    inner = belts + '<circle cx="320" cy="200" r="36" fill="#f3f0e8"/>'
    return tile(inner, "146 126 348 148", pad=4)


FILES = {
    "constellation-symbol-colour-dark.svg": constellation(DARK),
    "constellation-symbol-colour-light.svg": constellation(LIGHT, light=True),
    "constellation-icon-symbol-colour-dark.svg": constellation(DARK, icon=True),
    "turnstone-symbol-colour-dark.svg": turnstone(DARK),
    "turnstone-symbol-colour-light.svg": turnstone(LIGHT),
    "turnstone-badge-symbol-colour-dark.svg": turnstone_badge(DARK),
    "argo-symbol-colour-dark.svg": argo(DARK),
    "argo-symbol-colour-light.svg": argo(LIGHT),
    "argo-icon-symbol-colour-dark.svg": tile(body_of(argo(DARK, icon=True)), ARGO_ICON_BOX),
    "gauss-aurora-icon-colour-dark.svg": gauss_icon(),
}

if __name__ == "__main__":
    for name, text in FILES.items():
        (OUT / name).write_text(text, encoding="utf-8")
        print(f"{len(text):>6}  {name}")

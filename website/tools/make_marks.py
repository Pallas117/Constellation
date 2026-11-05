"""Constellation and Turnstone symbols, redrawn on a strict grid (refined 4 Nov 2026, Josh: "more clean and professional").

Both keep their identity and lose the noise that made them fall apart at small sizes:
- Constellation: navy disc; one gold ring broken by five stars spaced exactly 72 degrees apart; three gold key stars on
  an equilateral triangle, each with one white star off it. One stroke weight per colour, one size per kind of star.
  Below 32 px use the icon: solid ring and the bold triangle only.
- Turnstone: drawn as the right half and mirrored, so it is exactly symmetric. Wing, underwing band and the three
  primaries share one angle family; no hairline details (they vanished under 72 px); one rock, one tide line.
  Below 32 px use the badge: the bird in a ring.

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


def mirrored(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [(240 - x, y) for x, y in points]


def whole(half: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """A shape on the centre line from its right half (first and last points on x = 120)."""
    return half + mirrored(half)[::-1][1:-1]


def turnstone_body(c: dict[str, str]) -> list[str]:
    wing = [(128, 100), (196, 38), (190, 60), (138, 112)]
    band = [(142, 116), (192, 70), (204, 68), (152, 126)]
    primaries = [[(196, 38), (226, 10), (200, 46)], [(194, 48), (230, 30), (196, 56)], [(192, 58), (226, 52), (192, 64)]]
    body: list[str] = []
    for shape, fill in [(wing, c["warm"]), (band, c["blue"])] + [(p, c["warm"]) for p in primaries]:
        body += [poly(shape, fill), poly(mirrored(shape), fill)]
    body.append(poly(whole([(120, 98), (132, 108), (136, 128), (126, 152), (120, 156)]), c["warm"]))
    body.append(poly(whole([(120, 68), (128, 74), (128, 88), (120, 94)]), c["warm"]))
    body.append(poly([(112, 78), (98, 84), (112, 84)], c["warm"]))  # the short, upturned bill
    body.append(poly([(110, 110), (120, 122), (130, 110), (132, 120), (120, 132), (108, 120)], c["cut"]))  # breast band
    body.append(f'<path d="M115 154 113 178M125 154 127 178M106 180H118M122 180H134" fill="none" stroke="{c["orange"]}" stroke-width="5" stroke-linecap="square"/>')
    body.append(poly([(98, 186), (142, 186), (150, 198), (90, 198)], c["warm"]))  # the rock
    tide = "M68 212" + "".join(f"L{78 + 10 * i} {206 if i % 2 == 0 else 212}" for i in range(11))
    body.append(f'<path d="{tide}" fill="none" stroke="{c["blue"]}" stroke-width="4" stroke-linecap="square"/>')
    return body


def turnstone(c: dict[str, str]) -> str:
    return svg("4 2 232 222", turnstone_body(c))


def turnstone_badge(c: dict[str, str]) -> str:
    ring = f'<circle cx="120" cy="114" r="110" fill="{DARK["cut"]}" stroke="{DARK["warm"]}" stroke-width="4"/>'
    return svg("6 0 228 228", [ring, f'<g transform="translate(120 114) scale(.74) translate(-120 -112)">', *turnstone_body(DARK), "</g>"])


def star4(cx: float, cy: float, r: float, waist: float, fill: str) -> str:
    """A four-point star: long points on the axes, the waist between them."""
    pts = [polar(cx, cy, r if i % 2 == 0 else waist, -90 + 45 * i) for i in range(8)]
    return poly(pts, fill)


def argo(c: dict[str, str], icon: bool = False, star: bool = True) -> str:
    """Argo: a square sail full of wind, steering by Canopus (Josh, 5 Nov: "Argo could be just a sail").

    Argo is the ship of the old constellation Argo Navis; its brightest star, Canopus, has been a spacecraft's
    reference star since Mariner 3 and 4 carried the first Canopus star trackers (1964). So the one lime element is the
    star the sail is set by. Three panels with real gaps (no ground-coloured cuts, so it sits on any surface), each
    wider than the last down to the belly, the foot tucked back in: the billow from straight edges only, like the
    Turnstone; every seam dips at the mast, so the cloth reads as filled. The yard stands clear of the sail; the mast shows through the gaps. Square, so one drawing is both the
    mark and the favicon; the icon only opens the gaps so they survive 16 px.
    """
    gap = 10 if icon else 7
    # (y, half-width) down the sail's edge: top, belly, foot. Panels split the height into thirds.
    edge = [(52, 46), (132, 62), (172, 56)]

    def half(y: float) -> float:
        (y0, w0), (y1, w1) = (edge[0], edge[1]) if y <= edge[1][0] else (edge[1], edge[2])
        return w0 + (w1 - w0) * (y - y0) / (y1 - y0)

    cuts = [52 + (172 - 52) * k / 3 for k in range(4)]
    body = [f'<path d="M108 24V196" fill="none" stroke="{c["warm"]}" stroke-width="7"/>',  # the mast
            poly([(56, 34), (160, 34), (160, 42), (56, 42)], c["warm"])]  # the yard
    sag = 12  # each seam dips at the mast: the cloth filled from behind, still drawn with straight edges
    for i in range(3):
        y0, y1 = cuts[i] + (gap / 2 if i else 0), cuts[i + 1] - (gap / 2 if i < 2 else 0)
        mid = [edge[1][0]] if y0 < edge[1][0] < y1 else []
        ys = [y0, *mid, y1]
        right = [(108 + half(y), y) for y in ys]
        left = [(108 - half(y), y) for y in reversed(ys)]
        body.append(poly([(108, y0 + sag), *right, (108, y1 + sag), *left], c["warm"]))
    if star:
        body.append(star4(190, 46, 30 if icon else 24, 7 if icon else 5, c["star"]))
    return svg("28 12 196 196", body)


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
    "argo-icon-symbol-colour-dark.svg": tile(body_of(argo(DARK, icon=True)), "28 12 196 196"),
    "gauss-aurora-icon-colour-dark.svg": gauss_icon(),
}

if __name__ == "__main__":
    for name, text in FILES.items():
        (OUT / name).write_text(text, encoding="utf-8")
        print(f"{len(text):>6}  {name}")

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
DARK = {"navy": "#081c4d", "gold": "#b0906f", "ring": "#b0906f", "warm": "#f3f0e8", "blue": "#318ada", "orange": "#f0782a", "cut": "#050505"}
LIGHT = {**DARK, "ring": "#86684a", "warm": "#050505", "blue": "#2170b7", "orange": "#b44f0d", "cut": "#ffffff"}
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


FILES = {
    "constellation-symbol-colour-dark.svg": constellation(DARK),
    "constellation-symbol-colour-light.svg": constellation(LIGHT, light=True),
    "constellation-icon-symbol-colour-dark.svg": constellation(DARK, icon=True),
    "turnstone-symbol-colour-dark.svg": turnstone(DARK),
    "turnstone-symbol-colour-light.svg": turnstone(LIGHT),
    "turnstone-badge-symbol-colour-dark.svg": turnstone_badge(DARK),
}

if __name__ == "__main__":
    for name, text in FILES.items():
        (OUT / name).write_text(text, encoding="utf-8")
        print(f"{len(text):>6}  {name}")

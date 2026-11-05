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


MIRROR = '<g transform="matrix(-1 0 0 1 240 0)">'  # mirror about x = 120


def both(path_d: str, fill: str) -> list[str]:
    """A right-half path and its mirror image: the bird is exactly symmetric."""
    p = f'<path d="{path_d}" fill="{fill}"/>'
    return [p, MIRROR + p + "</g>"]


def turnstone_body(c: dict[str, str], small: bool = False) -> list[str]:
    """Turnstone v8 (5 Nov 2026, Josh: "more realistic and less chunky", then "cute but deadly").

    The ruddy turnstone landing, drawn from the bird: a big round head sitting low on a plump body, a large eye with a
    catch-light (cute); four swept blade primaries, a hard angled brow and small talons (deadly). Curved arm and
    secondaries; the earth-blue rear feathers tucked under the trailing edge; the black breast band, a real field mark;
    short orange legs; the Book's two-step tide line. `small` drops the catch-light and thickens strokes (the badge).
    """
    out: list[str] = []
    # Wing: grows from inside the shoulder; the arm curves up, the hand ends in four swept blades.
    wing = ("M122 112C138 96 160 70 184 44C194 34 204 26 218 16"   # leading edge
            "L210 38L230 30L212 52L232 48L210 64L228 66L202 76"     # four blade primaries, same sweep
            "C188 92 170 110 150 126C140 126 130 122 122 112Z")      # secondaries back into the body
    out += both(wing, c["warm"])
    # Rear feathers: an earth-blue crescent tucked under the trailing edge, one fine cut away.
    out += both("M202 81C188 97 170 115 152 131C158 135 164 135 168 133C184 119 198 103 208 87Z", c["blue"])
    # Body: plump, widest low at the breast.
    out.append(f'<path d="M120 92C138 92 150 108 150 128C150 148 138 164 120 174C102 164 90 148 90 128C90 108 102 92 120 92Z" fill="{c["warm"]}"/>')
    # Head: big and round, sitting low on the body; bill short, sharp, turned a touch up.
    out.append(f'<circle cx="120" cy="74" r="19" fill="{c["warm"]}"/>')
    out.append(f'<path d="M104 72L87 71L103 80Z" fill="{c["warm"]}"/>')
    # Eye with a catch-light (cute), under a hard angled brow (deadly).
    out.append(f'<circle cx="112" cy="74" r="{5 if small else 4.6}" fill="{c["cut"]}"/>')
    if not small:
        out.append(f'<circle cx="110.6" cy="72.6" r="1.5" fill="{c["warm"]}"/>')
    out.append(f'<path d="M103 66L122 70L121 73L104 69Z" fill="{c["cut"]}"/>')
    # Harlequin mask: the dark stripe from the eye down the cheek, and the breast band below.
    out.append(f'<path d="M98 112C106 117 113 123 120 131C127 123 134 117 142 112L145 118C136 124 128 132 120 143C112 132 104 124 95 118Z" fill="{c["cut"]}"/>')
    # Short orange legs ending in small talons.
    w = 5 if small else 4
    out.append(f'<path d="M114 170L112 188M126 170L128 188M112 188L104 194M112 188L114 196M128 188L136 194M128 188L126 196" '
               f'fill="none" stroke="{c["orange"]}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>')
    out.append(f'<path d="M70 202Q120 197 170 202M92 210Q120 207 148 210" fill="none" stroke="{c["blue"]}" stroke-width="{5 if small else 3.5}" stroke-linecap="round"/>')
    return out


def turnstone(c: dict[str, str]) -> str:
    return svg("6 8 228 210", turnstone_body(c))


def turnstone_badge(c: dict[str, str]) -> str:
    ring = f'<circle cx="120" cy="112" r="108" fill="{DARK["cut"]}" stroke="{DARK["warm"]}" stroke-width="4"/>'
    return svg("8 0 224 224", [ring, '<g transform="translate(120 116) scale(.72) translate(-120 -112)">', *turnstone_body(DARK, small=True), "</g>"])


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

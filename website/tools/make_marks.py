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
    """Turnstone v9 (5 Nov 2026, Josh: "more realistic and less chunky", "cute but deadly", then "Look again at images
    of the turnstone bird"), drawn from photos of the ruddy turnstone on Wikimedia Commons.

    Wings raised in a V, long, narrow and pointed like a sandpiper's, with the dark leading edge in earth blue; the
    harlequin face: a black band from the bill through the eye to the nape (its top edge angled down to the bill) and
    the cheek stripe dropping into the black breast band; a catch-light in the masked eye; a plump white belly; short
    orange legs with talons; the two-step tide line. Exactly symmetric except the head, which looks along the bill.
    `small` simplifies the leading edge, thickens strokes and enlarges the catch-light (the badge).
    """
    o: list[str] = []
    # Wing raised in a V, long, narrow and pointed like a sandpiper's: white underwing, a short step where the
    # primaries begin, one sharp tip.
    o += both("M124 110C140 92 164 64 196 34C204 27 212 21 222 14"
              "C220 26 216 36 210 44L216 46C206 58 196 70 184 82"
              "C170 98 156 114 142 128C134 124 128 118 124 110Z", c["warm"])
    # The dark leading edge of the wing, in earth blue, one fine cut in from the edge.
    if not small:
        o += both("M131 106C146 90 168 64 198 36C206 29 213 23 221 17C214 26 206 34 200 40C172 68 150 92 136 110Z", c["blue"])
    else:
        o += both("M130 106C150 86 176 58 220 16C208 34 186 58 138 110Z", c["blue"])
    # Body: plump, white belly.
    o.append(f'<path d="M120 94C137 94 148 108 148 127C148 147 137 163 120 172C103 163 92 147 92 127C92 108 103 94 120 94Z" fill="{c["warm"]}"/>')
    # Head: smaller and rounded, the short dark wedge bill turned a touch up.
    o.append(f'<path d="M120 60C130 60 136 68 136 77C136 87 129 94 120 94C111 94 104 87 104 77C104 68 110 60 120 60Z" fill="{c["warm"]}"/>')
    o.append(f'<path d="M106 74L88 73L105 81Z" fill="{c["warm"]}"/>')
    # Harlequin mask, as on the bird: a black band from the bill through the eye to the nape, its top edge angled down
    # to the bill (the fierce brow); and the cheek stripe dropping from under the eye into the bib.
    o.append(f'<path d="M105 71L132 69L134 75L123 76L106 80Z" fill="{c["cut"]}"/>')
    o.append(f'<path d="M110 79L116 78C117 85 119 91 123 96L116 98C113 92 111 86 110 79Z" fill="{c["cut"]}"/>')
    # Catch-light in the masked eye: cute.
    o.append(f'<circle cx="113" cy="74.2" r="{2.2 if small else 1.8}" fill="{c["warm"]}"/>')
    # Black breast band curving up the sides of the neck, white belly below.
    o.append(f'<path d="M100 104C106 112 112 118 120 122C128 118 134 112 140 104L146 112C138 122 130 130 120 136C110 130 102 122 94 112Z" fill="{c["cut"]}"/>')
    w = 5 if small else 4
    o.append(f'<path d="M114 168L112 186M126 168L128 186M112 186L105 191M112 186L114 193M128 186L135 191M128 186L126 193" '
             f'fill="none" stroke="{c["orange"]}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>')
    o.append(f'<path d="M72 199Q120 194 168 199M94 207Q120 204 146 207" fill="none" stroke="{c["blue"]}" stroke-width="{5 if small else 3.5}" stroke-linecap="round"/>')
    return o


def turnstone(c: dict[str, str]) -> str:
    return svg("8 8 224 206", turnstone_body(c))


def turnstone_badge(c: dict[str, str]) -> str:
    ring = f'<circle cx="120" cy="112" r="108" fill="{DARK["cut"]}" stroke="{DARK["warm"]}" stroke-width="4"/>'
    return svg("8 0 224 224", [ring, '<g transform="translate(120 114) scale(.74) translate(-120 -112)">', *turnstone_body(DARK, small=True), "</g>"])


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

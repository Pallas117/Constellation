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
TURNSTONE_WING = [((130, 108), (156, 52), (222, 20)), ((134, 122), (164, 76), (210, 48)), ((137, 136), (168, 102), (196, 76))]  # roots tuck behind the body


def both(el: str) -> list[str]:
    """An element and its mirror image: the bird is exactly symmetric."""
    return [el, MIRROR + el + "</g>"]


def taper(p0: tuple[float, float], q: tuple[float, float], p1: tuple[float, float], w0: float, w1: float = 0.6) -> str:
    """A quadratic sweep drawn as a filled shape whose width runs from w0 at p0 to w1 at p1 (a feather, not a tube)."""
    n = 24
    left, right = [], []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * q[0] + t ** 2 * p1[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * q[1] + t ** 2 * p1[1]
        dx = 2 * (1 - t) * (q[0] - p0[0]) + 2 * t * (p1[0] - q[0])
        dy = 2 * (1 - t) * (q[1] - p0[1]) + 2 * t * (p1[1] - q[1])
        length = math.hypot(dx, dy) or 1
        half = (w0 + (w1 - w0) * t ** 0.9) / 2
        nx, ny = -dy / length * half, dx / length * half
        left.append((x + nx, y + ny))
        right.append((x - nx, y - ny))
    pts = left + right[::-1]
    return "M" + "L".join(f"{num(x)} {num(y)}" for x, y in pts) + "Z"


def turnstone_body(c: dict[str, str], small: bool = False) -> list[str]:
    """Turnstone v11 (5-6 Nov 2026, Josh: "We need a more uniform structure with motion, mystique that embodies the
    lightbound brand"; approved 6 Nov).

    Built from the Lightbound mark system instead of drawn as an illustration: one stroke weight throughout, like the
    Gauss field lines and the Constellation ring. The orbit ring is the original Turning-tide mark's tide; its Moon point is
    replaced by the bird's own head (Josh: "make it resemble the bird a little bit more"): round, with the short upturned
    wedge bill and the dark eye of the harlequin mask; the breast band is a chevron across the body and the orange is
    on the short legs, as on the bird. Three nested sweeps per wing are a wingbeat caught mid-stroke, and the wingtips
    break out of the ring: carry hope, go beyond. The body is stocky like the bird's, and only its white belly is filled: the dark breast patch
    is the ground inside the outline, so the bird is partly implied. Where a wing crosses the ring, the ring breaks (a ground-coloured underlay drawn first). `small` is the
    same drawing with a heavier stroke, for 32 px and below.
    """
    w = 10 if small else 7

    def stroke(d: str, colour: str, width: float = w) -> str:
        return f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}" stroke-linecap="round"/>'

    wings = [f"M{sx} {sy}Q{qx} {qy} {tx} {ty}" for (sx, sy), (qx, qy), (tx, ty) in TURNSTONE_WING]
    ring_w = 6 if small else 4  # lighter than the bird, like the Lightbound photon ring: the bird leads, the orbit recedes
    out = [f'<circle cx="120" cy="120" r="96" fill="none" stroke="{c["blue"]}" stroke-width="{ring_w}"/>']  # the turning tide
    for d in wings:
        out += both(stroke(d, c["cut"], w + 16))  # one clean break in the ring across the whole wing
    # Each sweep tapers from the shoulder to a sharp feather tip, in the bird's own colours (Josh: "Add some of the extra
    # colours"): white leading feathers, the ruddy chestnut that names the bird (Turnstone signal orange), earth blue.
    for (p0, q, p1), colour in zip(TURNSTONE_WING, ("warm", "orange", "blue")):
        out += both(f'<path d="{taper(p0, q, p1, w * 1.6)}" fill="{c[colour]}"/>')
    # The body, stocky and round-chested as on the bird. Only the white belly is filled; above the breast line the dark
    # breast patch is left as the ground inside the outline, as the bird's black breast is.
    out.append(f'<path d="M120 100C136 104 144 118 144 132C144 148 134 158 120 162C106 158 96 148 96 132C96 118 104 104 120 100Z" '
               f'fill="{c["cut"]}" stroke="{c["warm"]}" stroke-width="{w - 1}"/>')  # filled with the ground: the wings tuck behind
    out.append(f'<path d="M100 124L120 136L140 124C143 131 143 140 140 147C134 156 127 160 120 161C113 160 106 156 100 147C97 140 97 131 100 124Z" fill="{c["warm"]}"/>')
    # The head: small and compact, sitting on the dark breast; the short bill; the dark eye of the harlequin mask.
    out.append(f'<circle cx="120" cy="91" r="{12 if small else 11}" fill="{c["warm"]}"/>')
    out.append(stroke("M111 92L100 89", c["warm"]))
    if not small:
        out.append(f'<circle cx="116.5" cy="87.5" r="2.8" fill="{c["cut"]}"/>')
    # Short orange legs, feet spread.
    out.append(stroke("M114 161L111 178M126 161L129 178M111 178L104 182M111 178L113 184M129 178L136 182M129 178L127 184",
                      c["orange"], w - 2))
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
    """Argo: one sail like a sweeping wind, a wing (Josh, 5-6 Nov 2026: "Argo could be just a sail", "a sail in the
    wind", then "I think one sail", "Sail like a sweeping wind", "Wing"; approved 6 Nov).

    Argo is the ship of the old constellation Argo Navis; its brightest star, Canopus, has been a spacecraft's
    reference star since Mariner 3 and 4 carried the first Canopus star trackers (1964), so the one lime element is the
    star across the mast. The sail is a single crescent: hoisted at the masthead, its leading edge bellied far out
    like a wing, sharp at the head and at the clew, where the sheet runs back to the mast. It tapers the way the
    Turnstone's wing sweeps do, so the two marks are siblings. The icon drops the sheet and thickens the mast for 16 px.
    """
    w = 6 if icon else 4
    body = [f'<path d="M96 18V216" fill="none" stroke="{c["warm"]}" stroke-width="{w}" stroke-linecap="round"/>',  # the mast
            f'<path d="M100 24C178 26 224 104 202 202C180 140 150 80 100 24Z" fill="{c["warm"]}"/>']  # the sail
    if not icon:
        body.append(f'<path d="M202 202L100 214" fill="none" stroke="{c["warm"]}" stroke-width="2.5" stroke-linecap="round"/>')  # the sheet
    body.append(star4(54, 46, 28 if icon else 20, 6 if icon else 3.5, c["star"]))  # Canopus, across the mast
    return svg(ARGO_ICON_BOX if icon else "28 10 204 212", body)


ARGO_ICON_BOX = "24 8 212 216"  # square-ish, centred on the sail and star, for the favicon tile


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

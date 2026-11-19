"""Draw the landing backdrop's magnetic field lines: website/public/assets/media/fields.svg.

Dipole field lines, r = L cos^2(latitude) (the same physics as the descent, tools/make_descent.py), with the dipole
axis vertical and its centre below the frame, so the lines rise across the screen as wide arches. Faint warm-white
strokes only; the stylesheet fades them in near the foot of the landing page. A sketch, not a model or to scale.

usage: python3 website/tools/make_fields.py
"""
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "assets" / "media" / "fields.svg"
CX, CY = 500, 1060  # dipole centre, just below the 1000 x 1000 frame
LINES = ((480, .15), (700, .125), (960, .10), (1280, .08), (1680, .06))  # L (frame units), stroke opacity


def line(L, side):
    pts = []
    for deg in range(90, -1, -3):  # pole to equator, upper hemisphere
        lat = math.radians(deg)
        r = L * math.cos(lat) ** 2
        pts.append((CX + side * r * math.cos(lat), CY - r * math.sin(lat)))
    return "M" + "L".join(f"{x:.0f} {y:.0f}" for x, y in pts)


def main():
    paths = "".join(f'<path d="{line(L, s)}" stroke-opacity="{op}"/>' for L, op in LINES for s in (1, -1))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMax slice">'
           f'<g fill="none" stroke="#F3F0E8" stroke-width="1.2">{paths}</g></svg>\n')
    OUT.write_text(svg)
    print(f"{OUT.name}: {len(svg)} bytes")


if __name__ == "__main__":
    main()

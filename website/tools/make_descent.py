"""The landing page's descent: the black hole's ring shrinks into Earth's aurora, then the field and the
Van Allen belts draw in. Drawn from the dipole field-line equation, so nothing is traced by hand.

A dipole field line is r = L cos^2(lat) (r in Earth radii; L is the line's distance at the equator).
In the meridian plane that gives x = L cos^3(lat), z = L cos^2(lat) sin(lat); a line meets the surface
at cos^2(lat) = 1/L. Earth's real field is squashed on the day side and stretched on the night side, so
this is a sketch of the inner magnetosphere, not a model (the page says so).

Belts, from NASA Earth Observatory, "Probing the Electric Space Around Earth" (earthobservatory.nasa.gov/
images/78985): an inner belt of protons and electrons, an outer belt mainly of energetic electrons, and
a sparsely filled slot between them. The L ranges here are rounded for the drawing.
Aurora: the outer lines (L about 5.5 to 9) meet the atmosphere at about 65-71 degrees magnetic latitude.

usage: python3 website/tools/make_descent.py   (rewrites the block between <!--descent--> markers in
public/index.html; the animation lives in public/assets/site.css under "Descent")
"""
from __future__ import annotations

import math
import re
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "public" / "index.html"
R = 40.0  # Earth radius in SVG units; the view box is 640 x 400 around Earth's centre
LINES = [1.6, 2.4, 3.4, 4.6, 6.0, 7.5]
INNER, OUTER = (1.25, 2.2, 45), (3.2, 6.2, 55)  # (L from, L to, latitude cap in degrees)
AURORA = (5.5, 9.0)
POSTER_RING = 177 / 1280  # the photon ring's radius as a share of the poster's width (blackhole-poster.jpg)
RING = 150.0              # the ring's starting radius in SVG units


def f(v: float) -> str:
    return f"{v:.1f}".rstrip("0").rstrip(".")


def point(L: float, lat: float, side: int) -> tuple[float, float]:
    c = math.cos(lat)
    return side * L * c ** 3 * R, -L * c * c * math.sin(lat) * R


def foot(L: float) -> float:
    """Latitude where the line meets the surface."""
    return math.acos(math.sqrt(1 / L))


def run(L: float, lat0: float, lat1: float, side: int, n: int = 36) -> list[tuple[float, float]]:
    return [point(L, lat0 + (lat1 - lat0) * i / n, side) for i in range(n + 1)]


def d(points: list[tuple[float, float]], close: bool = False) -> str:
    head, *rest = points
    return f"M{f(head[0])} {f(head[1])}" + "".join(f"L{f(x)} {f(y)}" for x, y in rest) + ("Z" if close else "")


def belt(lo: float, hi: float, cap_deg: float, side: int) -> str:
    cap = math.radians(cap_deg)
    above = lambda L: min(cap, math.acos(math.sqrt(1.04 / L)))  # stay just above the surface
    outer = run(hi, -above(hi), above(hi), side)
    inner = run(lo, above(lo), -above(lo), side)
    return d(outer + inner, close=True)


def arc(lat0: float, lat1: float, side: int, south: bool) -> str:
    pts = []
    for i in range(13):
        lat = lat0 + (lat1 - lat0) * i / 12
        pts.append((side * R * math.cos(lat), (1 if south else -1) * R * math.sin(lat)))
    return d(pts)


def svg() -> str:
    # Drawn from the north footpoint (where the aurora is) towards the south, so the lines grow out of the halo.
    lines = "".join(f'<path d="{d(run(L, foot(L), -foot(L), s))}" pathLength="1"/>' for L in LINES for s in (1, -1))
    a0, a1 = foot(AURORA[0]), foot(AURORA[1])
    halo_lat = (a0 + a1) / 2
    hx, hy = R * math.cos(halo_lat), R * math.sin(halo_lat)
    aurora = "".join(f'<path d="{arc(a0, a1, s, south)}"/>' for s in (1, -1) for south in (False, True))
    # Trapped particles bounce along a field line between mirror points, slowing as they turn.
    bounce = [(1.7, 22, -1, 2.6, "p"), (4.6, 34, 1, 4.2, "e"), (5.4, 38, -1, 5.1, "e")]
    particles = "".join(
        f'<circle class="d-p {k}" r="{2.2 if k == "p" else 1.6}"><animateMotion dur="{dur}s" repeatCount="indefinite" '
        f'keyPoints="0;1;0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" '
        f'path="{d(run(L, -math.radians(m), math.radians(m), s, 24))}"/></circle>'
        for L, m, s, dur, k in bounce)
    w = RING / POSTER_RING
    h = w * 720 / 1280
    tags = (f'<text x="{f(1.75 * R)}" y="-6" text-anchor="middle">INNER · PROTONS</text>'
            f'<text x="{f(-4.3 * R)}" y="-6" text-anchor="middle">OUTER · ELECTRONS</text>'
            f'<text x="{f(2.7 * R)}" y="14" text-anchor="middle">SLOT</text>'
            f'<text x="0" y="{f(-hy - 14)}" text-anchor="middle">AURORA</text>')
    return (
        '<svg class="descent-art" viewBox="-320 -200 640 400" role="img" aria-labelledby="descent-t descent-d">'
        '<title id="descent-t">From a black hole to Earth&rsquo;s radiation belts</title>'
        '<desc id="descent-d">A black hole&rsquo;s ring of light shrinks into the aurora above Earth&rsquo;s pole. '
        'Earth&rsquo;s magnetic field lines loop from pole to pole, holding an inner belt of protons and an outer belt of '
        'electrons with a slot between them. Particles bounce along the lines. A sketch, not to scale in time or brightness.</desc>'
        f'<g class="d-belts"><path class="d-belt in" d="{belt(*INNER, 1)} {belt(*INNER, -1)}"/>'
        f'<path class="d-belt out" d="{belt(*OUTER, 1)} {belt(*OUTER, -1)}"/></g>'
        f'<g class="d-lines">{lines}</g>'
        f'<g class="d-earth"><circle r="{f(R)}"/><path class="d-axis" d="M0 {f(-R - 12)}V{f(R + 12)}"/></g>'
        f'<g class="d-aurora">{aurora}<ellipse class="d-halo" cx="0" cy="{f(-hy)}" rx="{f(hx)}" ry="{f(hx * .3)}"/></g>'
        f'<g class="d-particles">{particles}</g>'
        f'<g class="d-tags">{tags}</g>'
        # The black hole: the hero's poster, placed so its photon ring sits on the ring, then both shrink into the halo.
        # A radial mask fades the poster out past its disk, so it floats on black with no rectangle edge.
        f'<defs><radialGradient id="d-fade" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="{f(RING * 2.6)}">'
        '<stop offset=".6" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'
        f'<mask id="d-mask"><rect x="{f(-w / 2)}" y="{f(-h / 2)}" width="{f(w)}" height="{f(h)}" fill="url(#d-fade)"/></mask></defs>'
        f'<g class="d-bh"><image href="/assets/media/blackhole-poster.jpg" x="{f(-w / 2)}" y="{f(-h / 2)}" width="{f(w)}" height="{f(h)}" preserveAspectRatio="none" mask="url(#d-mask)"/>'
        f'<ellipse class="d-ring" cx="0" cy="0" rx="{f(RING)}" ry="{f(RING)}"/></g>'
        '</svg>'
    ), (hx, hy)


def main() -> None:
    art, (hx, hy) = svg()
    page = PAGE.read_text(encoding="utf-8")
    new, n = re.subn(r"<!--descent-->.*?<!--/descent-->", lambda _: f"<!--descent-->{art}<!--/descent-->", page, flags=re.S)
    assert n == 1, "public/index.html needs one <!--descent--><!--/descent--> block"
    PAGE.write_text(new, encoding="utf-8")
    # The CSS end state for the ring: translate to the north halo, scale the 150-unit circle down to it.
    print(f"descent: {len(art)} bytes; ring end: translate(0,{f(-hy)}) scale({hx / RING:.4f},{hx * .3 / RING:.4f})")


if __name__ == "__main__":
    main()

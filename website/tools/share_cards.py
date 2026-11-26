"""Share cards: one 1200x630 card per public section, rendered by headless Chrome from the site's own fonts,
colour tokens and brand still, then saved as high-quality JPEG in public/assets/media/share/.

usage: python3 website/tools/share_cards.py        (needs Pillow and Google Chrome; about 10 s)

Why Chrome: the brand type (IBM Plex Sans as "Lightbound Sans", JetBrains Mono) ships only as woff2 subsets,
which Pillow can't read. Chrome renders the same @font-face files the site uses, so the cards match the pages.
Share cards are fetched by social sites, never by visitors' browsers, so they sit outside the site's 1 MB weight
budget (Josh, 24 Nov 2026) and have their own cap in website/test/site.test.mjs. Headlines are each page's own h1,
so a card never says more than its page. The output is committed; deploying needs no build step.
"""
from __future__ import annotations

import html
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

PUB = Path(__file__).resolve().parent.parent / "public"
OUT = PUB / "assets" / "media" / "share"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H, QUALITY = 1200, 630, 90

# Site palette (assets/site.css): --black, --warm, --muted, --lime, --danger; Constellation: .brand-constellation.
LIGHTBOUND = {"bg": "#050505", "ink": "#F3F0E8", "muted": "#87938E", "accent": "#CCFF00", "band": None}
STORM = {**LIGHTBOUND, "band": "#D4673B"}
CONSTELLATION = {"bg": "#081C4D", "ink": "#F3F0E8", "muted": "#A9ABA6", "accent": "#B0906F", "band": None,
                 "mark": "constellation-horizontal-colour-dark-v3.svg"}

# id, kicker, headline lines (the page's h1), foot line, palette
CARDS = [
    ("lightbound", "LIGHTBOUND", ["Carry hope,", "go beyond."], "lightbound.space", LIGHTBOUND),
    ("gauss", "GAUSS", ["Know which satellite", "data and onboard-AI", "outputs you can trust."], "lightbound.space/gauss", LIGHTBOUND),
    ("evidence", "GAUSS  ·  SAMPLE EVIDENCE REPORT", ["Sample evidence", "report."], "lightbound.space/gauss/evidence   ·   Synthetic sample", LIGHTBOUND),
    ("storms", "GAUSS  ·  STORM STORY", ["The night", "the sky", "went red."], "10–11 MAY 2024  ·  G5  ·  KP 9  ·  X5.8   ·   Data: NOAA SWPC", STORM),
    ("constellation", "CONSTELLATION", ["Watch space together,", "in the open."], "lightbound.space/constellation", CONSTELLATION),
    ("education", "GAUSS FOR EDUCATION", ["Teach space with", "real space weather."], "lightbound.space/education", LIGHTBOUND),
]


def page(kicker: str, lines: list[str], foot: str, p: dict) -> str:
    assets = (PUB / "assets").as_uri()
    longest = max(map(len, lines))
    size = 104 if len(lines) <= 2 and longest <= 14 else 84 if longest <= 18 else 64
    shift = -250 if longest <= 18 else -470  # long headlines: the ring moves right, clear of the words
    band = (f'<div class="band" style="background:linear-gradient(to top,{p["band"]}66,transparent 55%)"></div>'
            if p["band"] else "")
    head = "".join(f"<div>{html.escape(t)}</div>" for t in lines)
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face{{font-family:"Lightbound Sans";font-weight:600;src:url({assets}/fonts/plex-sans-600.woff2) format("woff2")}}
@font-face{{font-family:"Lightbound Sans";font-weight:400;src:url({assets}/fonts/plex-sans-400.woff2) format("woff2")}}
@font-face{{font-family:"JetBrains Mono";font-weight:700;src:url({assets}/fonts/jetbrains-mono-700.woff2) format("woff2")}}
html,body{{margin:0;width:{W}px;height:{H}px;overflow:hidden;background:{p["bg"]}}}
.still{{position:absolute;inset:0 {shift}px 0 auto;width:1120px;height:{H}px;object-fit:cover;
  -webkit-mask-image:linear-gradient(to right,transparent 0,transparent 30%,#000d 62%);opacity:.95}}
.depth{{position:absolute;inset:0;background:radial-gradient(120% 90% at 0% 50%,{p["bg"]} 35%,transparent 70%)}}
.band{{position:absolute;inset:0}}
.k,.f{{position:absolute;left:72px;font:700 24px/1 "JetBrains Mono";letter-spacing:.04em}}
.k{{top:72px;color:{p["accent"]}}}
.f{{bottom:72px;color:{p["muted"]};font-size:21px}}
.rule{{position:absolute;left:72px;top:112px;width:48px;height:2px;background:{p["accent"]}}}
h1{{position:absolute;left:68px;top:150px;margin:0;font:600 {size}px/1.02 "Lightbound Sans";letter-spacing:-.02em;color:{p["ink"]}}}
.mark{{position:absolute;right:72px;bottom:66px;height:28px;opacity:.9}}
</style>
<img class="still" src="{assets}/media/blackhole-poster.jpg"><div class="depth"></div>{band}
<div class="k">{html.escape(kicker)}</div><div class="rule"></div><h1>{head}</h1>
<div class="f">{html.escape(foot)}</div>
<img class="mark" src="{assets}/marks/{p.get("mark", "lightbound-horizontal-colour-dark.svg")}">"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="share-cards-"))
    try:
        for cid, kicker, lines, foot, p in CARDS:
            src, png = tmp / f"{cid}.html", tmp / f"{cid}.png"
            src.write_text(page(kicker, lines, foot, p), encoding="utf-8")
            subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                            f"--window-size={W},{H}", "--force-device-scale-factor=1", "--virtual-time-budget=3000",
                            f"--screenshot={png}", src.as_uri()], check=True, capture_output=True, timeout=60)
            img = Image.open(png).convert("RGB").crop((0, 0, W, H))
            jpg = OUT / f"{cid}.jpg"
            img.save(jpg, "JPEG", quality=QUALITY, optimize=True, progressive=True, subsampling=0)
            print(f"share/{cid}.jpg {jpg.stat().st_size} bytes")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()

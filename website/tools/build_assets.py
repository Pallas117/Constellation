"""Copy brand assets from the Lightbound Brand Kit into website/public/assets, ready for the web.

Run it again whenever the kit changes; the outputs are committed, so deploying needs no build step.

usage: <python with fonttools+brotli> website/tools/build_assets.py <Lightbound Brand Kit dir> [--fonts-only]
Then run make_lockups.py for the Turnstone and Constellation lockups.

- Marks: the refined flat symbols for all four brands in tools/symbols/ (Design System, 16-18 Oct 2026),
  copied unchanged; they supersede the kit's glow marks for web. Lockups come from make_lockups.py.
- Fonts: IBM Plex Sans 400/500/600 (500 = Constellation display) and JetBrains Mono 700, subset to Latin + the punctuation the site
  uses, as woff2. Both are SIL OFL 1.1, so self-hosting is allowed, with two conditions. Every copy carries the copyright
  notice and the licence: kept in the name table, and as OFL-*.txt beside the fonts. A subset is a Modified Version, and
  IBM reserves the font name "Plex", so the Plex subsets are renamed "Lightbound Sans" (the glyphs are unchanged).
  JetBrains Mono has no reserved name and keeps its own.
- Film: the kit's 720p web loop as is; the poster is re-encoded as JPEG (macOS sips), 532 KB down to about 45 KB.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

from fontTools import subset

OUT = Path(__file__).resolve().parent.parent / "public" / "assets"

KIT_MARKS: list[str] = []  # all marks now come from tools/symbols (the kit keeps fonts, film and favicons)
# Refined symbols (tools/symbols) -> published names.
SYMBOLS = {
    "lightbound-symbol-colour-dark.svg": "lightbound-mark-colour-dark.svg",
    "gauss-aurora-symbol-colour-dark.svg": "gauss-aurora-mark-colour-dark.svg",
    "turnstone-symbol-colour-dark.svg": "turnstone-mark-colour-dark.svg",
    "turnstone-badge-symbol-colour-dark.svg": "turnstone-badge-colour-dark.svg",
    "constellation-symbol-colour-dark.svg": "constellation-mark-colour-dark.svg",
    "constellation-icon-symbol-colour-dark.svg": "constellation-icon-colour-dark.svg",
}
# Source -> (published name, new family or None to keep the font's own name).
FONTS = {"IBMPlexSans-Regular.ttf": ("plex-sans-400.woff2", "Lightbound Sans"),
         "IBMPlexSans-Medium.ttf": ("plex-sans-500.woff2", "Lightbound Sans"),
         "IBMPlexSans-SemiBold.ttf": ("plex-sans-600.woff2", "Lightbound Sans"),
         "JetBrainsMono-Bold.ttf": ("jetbrains-mono-700.woff2", None)}
OFL_DESCRIPTION = "This Font Software is licensed under the SIL Open Font License, Version 1.1."
OFL_URL = "https://openfontlicense.org"
# Basic Latin, Latin-1, typographic punctuation, arrows, minus, approx, bullet.
UNICODES = "U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2010-2027,U+2030-203A,U+2190-2193,U+2197,U+2212,U+2248,U+2264-2265,U+25CF"


def strip_svg(src: Path, dst: Path) -> None:
    text = src.read_text(encoding="utf-8")
    text = re.sub(r"<metadata>.*?</metadata>", "", text, flags=re.S)
    text = text.replace(' xmlns:c2pa="http://c2pa.org/manifest"', "")
    dst.write_text(text, encoding="utf-8")


def rename(font, family: str) -> None:
    """Give a subset its own family name (OFL condition 3), keeping the weight the source named."""
    name = font["name"]
    style = name.getDebugName(4).split(" ")[-1]  # "Regular", "Medium", "SemiBold"
    full = f"{family} {style}"
    ps = f"{family.replace(' ', '')}-{style}"
    new = {1: full if style != "Regular" else family, 3: f"{name.getDebugName(5)};{ps}", 4: full, 6: ps}
    for rec in list(name.names):
        if rec.nameID in new:
            name.setName(new[rec.nameID], rec.nameID, rec.platformID, rec.platEncID, rec.langID)


def build_fonts(kit: Path, fonts: Path) -> None:
    fonts.mkdir(parents=True, exist_ok=True)
    for ttf, (woff2, family) in FONTS.items():
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["kern", "liga", "calt", "tnum", "case"]
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]  # copyright and names; the licence fields are set below
        font = subset.load_font(str(kit / "fonts" / ttf), opts)
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=subset.parse_unicodes(UNICODES))
        sub.subset(font)
        if family:
            rename(font, family)
        for nid, value in {13: OFL_DESCRIPTION, 14: OFL_URL}.items():
            font["name"].setName(value, nid, 3, 1, 0x409)
        subset.save_font(font, str(fonts / woff2), opts)


def main(kit: Path, fonts_only: bool = False) -> None:
    marks, fonts, media = OUT / "marks", OUT / "fonts", OUT / "media"
    build_fonts(kit, fonts)
    if fonts_only:
        return
    for d in (marks, media):
        d.mkdir(parents=True, exist_ok=True)
    for rel in KIT_MARKS:
        strip_svg(kit / "2026 marks" / rel, marks / Path(rel).name)
    for src, dst in SYMBOLS.items():
        shutil.copyfile(Path(__file__).resolve().parent / "symbols" / src, marks / dst)
    anim = kit / "animations"
    shutil.copyfile(anim / "lightbound-blackhole-720p-web.mp4", media / "blackhole-720p.mp4")
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "62", "-Z", "1280",
                    str(anim / "lightbound-blackhole-poster.png"), "--out", str(media / "blackhole-poster.jpg")],
                   check=True, capture_output=True)
    app = kit / "2026 marks" / "app"
    shutil.copyfile(app / "lightbound-favicon.ico", OUT.parent / "favicon.ico")
    # PNG/ICO favicons stay for old browsers; modern ones use the flat SVG symbols.
    shutil.copyfile(app / "lightbound-favicon-180.png", OUT / "apple-touch-icon.png")
    for f in sorted(p for p in OUT.parent.rglob("*") if p.is_file() and p.suffix in {".svg", ".woff2", ".mp4", ".jpg", ".png", ".ico"}):
        print(f"{f.stat().st_size:>8}  {f.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), fonts_only="--fonts-only" in sys.argv[2:])

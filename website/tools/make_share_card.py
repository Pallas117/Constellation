"""Share card for /gauss/storms/: 1200x630, the headline over the brand film's still frame.

usage: python3 website/tools/make_share_card.py        (needs Pillow; macOS system fonts)

Built from the site's own media (assets/media/blackhole-poster.jpg) and palette. The site's whole weight is tested
to stay under 1 MB (website/test/site.test.mjs), so the card is held to 30 KB: the quality steps down until it fits.
The output is committed; deploying needs no build step. Type: Arial Bold and Menlo Bold stand in for the web fonts
(the repo carries those only as woff2 subsets, which Pillow can't read).
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

MEDIA = Path(__file__).resolve().parent.parent / "public" / "assets" / "media"
W, H, PAD, LIMIT = 1200, 630, 72, 30_000
BLACK, WARM, MUTED, LIME, DANGER = (5, 5, 5), (243, 240, 232), (135, 147, 142), (204, 255, 0), (212, 103, 59)


def gradient(size: tuple[int, int], horizontal: bool, stops: list[tuple[float, int]]) -> Image.Image:
    """An 8-bit mask running through (position 0..1, value 0..255) stops."""
    n = size[0] if horizontal else size[1]
    line = []
    for i in range(n):
        t = i / (n - 1)
        for (t0, v0), (t1, v1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                line.append(round(v0 + (v1 - v0) * (t - t0) / (t1 - t0 or 1)))
                break
    strip = Image.new("L", (n, 1) if horizontal else (1, n))
    strip.putdata(line)
    return strip.resize(size)


def main() -> None:
    card = Image.new("RGB", (W, H), BLACK)
    still = Image.open(MEDIA / "blackhole-poster.jpg").convert("RGB")
    still = still.resize((round(still.width * H / still.height), H), Image.LANCZOS)
    # The hole sits right of centre; the left half stays black for the words.
    card.paste(still, (W - still.width + 250, 0), gradient(still.size, True, [(0, 0), (0.3, 0), (0.62, 215), (1, 215)]))
    # The red sky: a flat band rising from the foot, as on the page. A gradient, not a glow.
    card.paste(Image.new("RGB", (W, H), DANGER), (0, 0), gradient((W, H), False, [(0, 0), (0.45, 0), (1, 96)]))

    d = ImageDraw.Draw(card)
    sans = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 104)
    mono = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 24, index=1)
    d.text((PAD, PAD), "GAUSS  ·  STORM STORY", font=mono, fill=LIME)
    y = 136
    for line in ("The night", "the sky", "went red."):
        d.text((PAD - 4, y), line, font=sans, fill=WARM)
        y += 106
    d.text((PAD, H - PAD - 64), "10–11 MAY 2024  ·  G5  ·  KP 9  ·  X5.8", font=mono, fill=WARM)
    d.text((PAD, H - PAD - 24), "lightbound.space/gauss/storms   ·   Data: NOAA SWPC", font=mono, fill=MUTED)

    for quality in range(86, 30, -2):
        buf = io.BytesIO()
        card.save(buf, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=2)
        if buf.tell() <= LIMIT:
            break
    (MEDIA / "storms-share.jpg").write_bytes(buf.getvalue())
    print(f"storms-share.jpg {buf.tell()} bytes at quality {quality}")


if __name__ == "__main__":
    main()

"""Pre-rendered frames of the Gauss live view for the landing page's sign-in gate (Josh, 4 Nov 2026: "land into the
live view after the black hole animation with a login window to block, then we have pre-render and less latency").

Opens a running Gauss app's public landing view in Chrome on the real GPU (Metal; the software renderer is too slow
and draws a different scene), hides every bit of the HUD so no frozen reading or "LIVE" chip ends up in a still, and
saves one wide (16:10) and one portrait frame as WebP. The page labels them as a frame, not live data.

usage: <python with playwright + pillow> website/tools/capture_live_view.py [app URL, default http://127.0.0.1:8080/]
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent.parent / "public" / "assets" / "media"
HIDE_HUD = "body *{visibility:hidden!important} canvas{visibility:visible!important}"
FRAMES = {"gauss-live-wide.webp": (1600, 1000, 1.25), "gauss-live-tall.webp": (750, 1300, 1)}


def main(url: str) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"])
        for name, (w, h, scale) in FRAMES.items():
            page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
            page.goto(url, wait_until="load", timeout=60_000)
            page.wait_for_selector("canvas", timeout=60_000)
            page.wait_for_function("!/preparing the field model/i.test(document.body.innerText)", timeout=120_000, polling=500)
            page.wait_for_timeout(6_000)  # field lines and belt particles settle
            page.add_style_tag(content=HIDE_HUD)
            page.wait_for_timeout(300)
            shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
            shot.save(OUT / name, "WEBP", quality=72, method=6)
            print(f"{(OUT / name).stat().st_size:>8}  {name}  {shot.size[0]}x{shot.size[1]}")
            page.close()
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080/")

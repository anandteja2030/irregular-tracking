"""Phase 5 browser inspection: capture the console shell on every surface.

Run with the Vite dev server and the FastAPI service already listening:

    .venv/bin/python scripts/phase5_inspect.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase5")
OUT.mkdir(parents=True, exist_ok=True)

SURFACES = [
    ("01_overview", "/"),
    ("02_video_studio", "/video-studio"),
    ("03_track_explorer", "/tracks"),
    ("04_anomaly_center", "/anomalies"),
    ("05_scene_intelligence", "/scene"),
    ("06_evaluation", "/evaluation"),
    ("07_settings", "/settings"),
]

errors: list[str] = []


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
        context = browser.new_context(
            viewport={"width": 1512, "height": 950}, device_scale_factor=2)
        page = context.new_page()
        page.on("console", lambda m: errors.append(f"console: {m.text[:220]}")
                if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        for name, path in SURFACES:
            page.goto(f"{BASE}{path}", wait_until="networkidle", timeout=60_000)
            page.wait_for_timeout(1200)
            page.screenshot(path=str(OUT / f"{name}.png"))
            heading = page.locator("h1").first.inner_text()
            print(f"captured {name}: h1={heading!r}")

        # Command palette overlay
        page.goto(f"{BASE}/", wait_until="networkidle", timeout=60_000)
        page.wait_for_timeout(600)
        page.keyboard.press("Meta+k")
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "08_palette.png"))
        print("captured 08_palette")

        # Narrow viewport: rail collapses to a bottom dock
        narrow = browser.new_context(
            viewport={"width": 430, "height": 900}, device_scale_factor=2)
        mobile = narrow.new_page()
        mobile.on("pageerror", lambda e: errors.append(f"mobile pageerror: {e}"))
        mobile.goto(f"{BASE}/", wait_until="networkidle", timeout=60_000)
        mobile.wait_for_timeout(900)
        mobile.screenshot(path=str(OUT / "09_mobile_overview.png"))
        print("captured 09_mobile_overview")

        # Live data assertions in the rendered DOM
        page.goto(f"{BASE}/", wait_until="networkidle", timeout=60_000)
        page.wait_for_timeout(1200)
        body = page.locator("body").inner_text()
        facts = {
            "engine online pill": "Engine online" in body,
            "uptime reading": "Uptime" in body,
            "sources count": "Sample sources" in body,
            "runtime panel": "Measured host facts" in body,
        }
        for label, ok in facts.items():
            print(f"dom check {label}: {'ok' if ok else 'MISSING'}")

        browser.close()

    if errors:
        print("browser errors:")
        for line in errors:
            print(" -", line)
        return 1
    print("no console or page errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())

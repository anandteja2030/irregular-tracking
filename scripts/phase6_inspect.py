"""Capture the session-intelligence surfaces against the live API."""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase6")
VIEW = {"width": 1512, "height": 950}
SID = "api_20261031_180059_96c60e"
ROUTES = [
    ("01_overview", "/"),
    ("02_tracks", f"/tracks?session={SID}"),
    ("03_anomalies", f"/anomalies?session={SID}"),
    ("04_scene", f"/scene?session={SID}"),
    ("05_evaluation", f"/evaluation?session={SID}"),
    ("06_anomalies_filter", f"/anomalies?session={SID}"),
    ("07_mobile_tracks", f"/tracks?session={SID}"),
]

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
        for name, path in ROUTES:
            mobile = "mobile" in name
            ctx = browser.new_context(
                viewport={"width": 430, "height": 900} if mobile else VIEW,
                device_scale_factor=2,
            )
            page = ctx.new_page()
            page.on("console", lambda m: problems.append(f"{name} console {m.type}: {m.text}") if m.type == "error" else None)
            page.on("pageerror", lambda e: problems.append(f"{name} pageerror: {e}"))
            page.goto(f"{BASE}{path}", wait_until="networkidle", timeout=60000)
            page.wait_for_timeout(1400)
            if name == "06_anomalies_filter":
                page.get_by_role("button", name="Irregular", exact=True).click()
                page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / f"{name}.png"))
            print(f"captured {name}: h1={page.inner_text('h1')!r}")
            ctx.close()
        browser.close()

    if problems:
        print("PROBLEMS:")
        for item in problems:
            print(" -", item)
        return 1
    print("no console or page errors")
    return 0

if __name__ == "__main__":
    sys.exit(main())

"""Phase 1 visual verification: capture the shell pages in headless Chromium.

Usage (from project root):
    export LD_LIBRARY_PATH=$PWD/tools/chromelibs/usr/lib/x86_64-linux-gnu:...
    export FONTCONFIG_PATH=$PWD/tools/fonts
    .venv/bin/python scripts/phase1_inspect.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase1")
OUT.mkdir(parents=True, exist_ok=True)
ERRORS: list[str] = []


def shoot(page, name: str) -> None:
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
    print(f"captured {name}")


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.on("console",
                lambda m: ERRORS.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: ERRORS.append(str(e)))
        page.on("response",
                lambda r: ERRORS.append(f"HTTP {r.status} {r.url}")
                if r.status >= 400 else None)

        page.goto(BASE, wait_until="networkidle", timeout=60000)
        shoot(page, "01_overview_empty")

        # navigate like a user: click the sidebar links (deep-linking a
        # subpage makes Streamlit's frontend probe relative _stcore URLs,
        # which 404 by design - in-app navigation does not)
        def nav(title: str) -> None:
            page.get_by_role("link", name=title).first.click()
            page.wait_for_timeout(1800)

        nav("Video Studio")
        # source selectbox (first select on the page)
        selects = page.get_by_role("combobox")
        selects.nth(0).click()
        page.wait_for_timeout(500)
        opts = page.get_by_role("option")
        for i in range(opts.count()):
            if "anomaly_clip" in (opts.nth(i).inner_text() or ""):
                opts.nth(i).click()
                break
        page.wait_for_timeout(800)
        shoot(page, "02_studio_before")

        # run the analysis (default 450-frame budget) and wait for the
        # success banner that only appears after the deferred rerun completes
        page.get_by_role("button", name="Analyze", exact=True).click()
        try:
            page.wait_for_selector("text=Explore results in the other pages",
                                   timeout=120000)
        except Exception as exc:               # noqa: BLE001
            print("WARN analysis did not confirm:", exc)
        page.wait_for_timeout(1500)
        shoot(page, "03_studio_results")

        nav("Overview")
        shoot(page, "04_overview_session")

        nav("Settings")
        shoot(page, "05_settings")

        nav("Anomaly Center")
        shoot(page, "06_anomaly_center")

        browser.close()

    print("console/page errors:", ERRORS if ERRORS else "none")
    return 1 if ERRORS else 0


if __name__ == "__main__":
    sys.exit(main())

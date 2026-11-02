"""Focused probe: does the 'Jump to anomaly' control really move the viewer
in a real browser? Reads the combobox value and the Frame KPI before/after.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase2")
OUT.mkdir(parents=True, exist_ok=True)
ERRORS: list[str] = []
R: dict = {}


def frame_kpi(page) -> str:
    labs = page.locator(".kpi .lab")
    vals = page.locator(".kpi .val")
    for i in range(labs.count()):
        if labs.nth(i).inner_text().strip().lower() == "frame":
            return vals.nth(i).inner_text().strip()
    return "?"


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.on("console",
                lambda m: ERRORS.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: ERRORS.append(str(e)))

        try:
            page.goto(BASE, wait_until="networkidle", timeout=60000)
            page.get_by_role("link", name="Video Studio").first.click()
            page.wait_for_timeout(1800)

            page.get_by_role("combobox").nth(0).click()
            page.wait_for_timeout(500)
            opts = page.get_by_role("option")
            for i in range(opts.count()):
                if "anomaly_clip" in (opts.nth(i).inner_text() or ""):
                    opts.nth(i).click()
                    break
            page.wait_for_timeout(800)
            page.get_by_role("button", name="Analyze", exact=True).click()
            page.wait_for_selector("text=Explore results in the other pages",
                                   timeout=180000)
            page.wait_for_timeout(1500)

            cb = page.get_by_role("combobox", name="Jump to anomaly")
            R["value_before"] = cb.input_value()
            R["frame_before"] = frame_kpi(page)

            # open the listbox (retry: the widget may still be re-rendering)
            opened = False
            for attempt in range(4):
                cb.click()
                page.wait_for_timeout(700)
                if page.get_by_role("option").count() == 0:
                    cb.press("ArrowDown")
                    page.wait_for_timeout(700)
                if page.get_by_role("option").count() > 0:
                    opened = True
                    break
            R["dropdown_opened"] = opened
            if opened:
                opts = page.get_by_role("option")
                R["n_options"] = opts.count()
                R["first_option"] = opts.nth(0).inner_text()
                R["last_option"] = opts.nth(opts.count() - 1).inner_text()
                opts.nth(opts.count() - 1).click()
                page.wait_for_timeout(3500)
                R["value_after"] = cb.input_value()
                R["frame_after"] = frame_kpi(page)
            page.screenshot(path=str(OUT / "08_jump_probe.png"))
        finally:
            browser.close()

    print(json.dumps(R, indent=2))
    print("errors:", ERRORS if ERRORS else "none")
    return 0


if __name__ == "__main__":
    sys.exit(main())

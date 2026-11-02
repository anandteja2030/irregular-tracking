"""Phase 4 visual verification: NEURAL COMMAND redesign, all pages.

Launches headless Chromium, walks all seven pages in empty and
post-analysis states, exercises key interactions, and records console/page
errors plus per-page screenshots.

Usage (from project root):
    .venv/bin/streamlit run src/ui/dashboard.py --server.port 3000 &
    .venv/bin/python scripts/phase4_inspect.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase4")
OUT.mkdir(parents=True, exist_ok=True)
ERRORS: list[str] = []
R: dict = {"steps": [], "brand": {}}


def shoot(page, name: str) -> None:
    page.wait_for_timeout(1300)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
    print(f"captured {name}", flush=True)


def nav(page, title: str) -> str:
    page.get_by_role("link", name=title).first.click()
    page.wait_for_timeout(1800)
    return page.inner_text("h1").strip()


def step(name, fn, *args) -> None:
    try:
        fn(*args)
        R["steps"].append(f"ok: {name}")
    except Exception as exc:                       # noqa: BLE001
        R["steps"].append(f"FAILED: {name}: {exc}")
        print(f"FAILED step {name}: {exc}", flush=True)


def select_source(page, needle: str) -> None:
    page.get_by_role("combobox").nth(0).click()
    page.wait_for_timeout(500)
    opts = page.get_by_role("option")
    for i in range(opts.count()):
        if needle in (opts.nth(i).inner_text() or ""):
            opts.nth(i).click()
            page.wait_for_timeout(800)
            return
    raise AssertionError(f"option {needle!r} not found")


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

        # identity check: sidebar brand + gradient h1
        lum = page.inner_text("[data-testid='stSidebar']").lower()
        R["brand"]["sidebar_neural_command"] = "neural" in lum and "command" in lum
        R["brand"]["overview_h1"] = page.inner_text("h1").strip()
        shoot(page, "01_overview_empty")

        for title, key in [("Track Explorer", "02_tracks_empty"),
                           ("Anomaly Center", "03_anomaly_empty"),
                           ("Scene Intelligence", "04_scene_empty"),
                           ("Evaluation & Reports", "05_eval_empty"),
                           ("Settings", "06_settings_empty")]:
            step(f"nav_{title}", lambda t=title: R.setdefault(
                f"h1_{t}", nav(page, t)))

        nav(page, "Settings")
        shoot(page, "06_settings_empty")

        # real analysis run (animated plasma progress visible mid-run)
        nav(page, "Video Studio")
        R["studio_h1"] = page.inner_text("h1").strip()
        select_source(page, "anomaly_clip")
        page.get_by_role("button", name="Analyze", exact=True).click()
        page.wait_for_timeout(1500)
        shoot(page, "07_studio_processing")          # animated progress state
        page.wait_for_selector("text=Explore results in the other pages",
                               timeout=180000)
        page.wait_for_timeout(1500)
        R["studio_labels"] = ("ANNOTATED" in page.inner_text("body"))
        shoot(page, "08_studio_results")

        step("studio_both_view", lambda: (
            page.get_by_role("radiogroup", name="View")
            .get_by_text("Both", exact=True).first.click(),
            page.wait_for_timeout(1500)))
        shoot(page, "09_studio_both")

        for title, key in [("Overview", "10_overview_session"),
                           ("Track Explorer", "11_tracks_session"),
                           ("Anomaly Center", "12_anomaly_session"),
                           ("Scene Intelligence", "13_scene_session"),
                           ("Evaluation & Reports", "14_eval_session")]:
            step(f"nav_{title}", lambda t=title: R.setdefault(f"h1_{t}", nav(page, t)))
            shoot(page, key)

        # one anomaly-center interaction: pick the last visible event
        def _pick_event():
            nav(page, "Anomaly Center")
            cb = page.get_by_role("combobox", name="Selected event")
            cb.click()
            page.wait_for_timeout(600)
            if page.get_by_role("option").count() == 0:
                cb.press("ArrowDown")
                page.wait_for_timeout(600)
            page.get_by_role("option").last.click()
            page.wait_for_timeout(2000)
            R["event_chips"] = ("Isolation Forest" in page.inner_text("body")
                                or "Evidence streams" in page.inner_text("body"))
        step("pick_anomaly_event", _pick_event)
        shoot(page, "15_anomaly_investigation")

        browser.close()

    (OUT / "report.json").write_text(json.dumps(R, indent=2))
    print(json.dumps(R, indent=2))
    print("console/page errors:", ERRORS if ERRORS else "none")
    return 1 if ERRORS else 0


if __name__ == "__main__":
    sys.exit(main())

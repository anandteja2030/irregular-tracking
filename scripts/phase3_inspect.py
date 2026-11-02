"""Phase 3 visual verification: Track Explorer with empty and analyzed
sessions, the filterable track table, severity filters, event selection and
cross-page frame navigation - all in headless Chromium.

Usage (from project root):
    .venv/bin/streamlit run src/ui/dashboard.py --server.port 3000 &
    .venv/bin/python scripts/phase3_inspect.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase3")
OUT.mkdir(parents=True, exist_ok=True)
ERRORS: list[str] = []
R: dict = {"steps": []}


def shoot(page, name: str) -> None:
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
    print(f"captured {name}", flush=True)


def nav(page, title: str) -> None:
    page.get_by_role("link", name=title).first.click()
    page.wait_for_timeout(1800)


def step(name, fn, *args):
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


def radio_choice(page, group: str, option: str) -> None:
    grp = page.get_by_role("radiogroup", name=group)
    grp.get_by_text(option, exact=True).first.click()
    page.wait_for_timeout(1000)


def chooser(page, name: str, pick_last: bool = True) -> str:
    cb = page.get_by_role("combobox", name=name)
    cb.click()
    page.wait_for_timeout(600)
    if page.get_by_role("option").count() == 0:
        cb.press("ArrowDown")
        page.wait_for_timeout(600)
    opts = page.get_by_role("option")
    target = opts.last if pick_last else opts.first
    val = target.inner_text()
    target.click()
    page.wait_for_timeout(1800)
    return val


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
        nav(page, "Track Explorer")
        lum = page.inner_text("body")
        R["empty_state_waiting"] = "waiting for an analysis run" in lum
        shoot(page, "01_track_explorer_empty")      # polished empty state

        # run a real analysis from Video Studio
        nav(page, "Video Studio")
        select_source(page, "anomaly_clip")
        page.get_by_role("button", name="Analyze", exact=True).click()
        page.wait_for_selector("text=Explore results in the other pages",
                               timeout=180000)
        page.wait_for_timeout(1200)

        nav(page, "Track Explorer")
        lum = page.inner_text("body")
        R["session_badge"] = "tracks in this session" in lum
        R["has_table"] = "Track table" in lum
        R["charts"] = page.locator(".stVegaLite, [data-testid='stVegaLiteChart'],"
                                   "canvas").count()
        page.wait_for_timeout(1500)
        shoot(page, "02_track_table")               # table + investigation

        def _flag():
            radio_choice(page, "Show", "Flagged only")
            R["flagged_note"] = "showing" in page.inner_text("body")
        step("filter_flagged", _flag)
        shoot(page, "03_filter_flagged")

        def _clean():
            radio_choice(page, "Show", "Clean only")
            body = page.inner_text("body")
            R["clean_empty_or_rows"] = ("No tracks match" in body
                                        or "Track table" in body)
        step("filter_clean", _clean)
        shoot(page, "04_filter_clean")

        # back to all + select an event and jump to Video Studio
        def _event_nav():
            radio_choice(page, "Show", "All")
            val = chooser(page, "Event on this track")
            R["event_selected"] = val
            frame = int(val.split("\u00b7", 1)[0][1:].strip())
            btns = page.get_by_role("button")
            for i in range(btns.count()):
                if btns.nth(i).inner_text().startswith("Inspect frame"):
                    btns.nth(i).click()
                    page.wait_for_selector(
                        "text=Annotated", timeout=60000)
                    page.wait_for_timeout(2500)
                    R["landed_page"] = page.inner_text("h1")[:40]
                    R["landed_frame"] = frame
                    return
            raise AssertionError("inspect button not found")
        step("event_navigation", _event_nav)
        shoot(page, "05_video_studio_landed")

        # navigation context: return to Track Explorer, selection persists
        def _context():
            nav(page, "Track Explorer")
            sel = page.locator("input[aria-expanded]").first
            R["picker_value_after_return"] = sel.input_value()
        step("context_return", _context)
        shoot(page, "06_context_return")

        browser.close()

    (OUT / "report.json").write_text(json.dumps(R, indent=2))
    print(json.dumps(R, indent=2))
    print("console/page errors:", ERRORS if ERRORS else "none")
    return 1 if ERRORS else 0


if __name__ == "__main__":
    sys.exit(main())

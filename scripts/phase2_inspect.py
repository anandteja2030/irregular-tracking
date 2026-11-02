"""Phase 2 visual verification: the Video Studio workspace in headless
Chromium - real analysis run, annotated/original labelling, frame navigation,
event jumps, evidence rail, cross-page links, staleness guard and playback.

Usage (from project root):
    .venv/bin/streamlit run src/ui/dashboard.py --server.port 3000 &
    export LD_LIBRARY_PATH=$PWD/tools/chromelibs/usr/lib/x86_64-linux-gnu:...
    export FONTCONFIG_PATH=$PWD/tools/fonts
    .venv/bin/python scripts/phase2_inspect.py
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
REPORT: dict = {}


def shoot(page, name: str) -> None:
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)
    print(f"captured {name}")


def kpis(page) -> dict:
    out = {}
    labs = page.locator(".kpi .lab")
    vals = page.locator(".kpi .val")
    for i in range(labs.count()):
        # the CSS uppercases labels in the DOM, so normalise the key
        out[labs.nth(i).inner_text().strip().lower()] = \
            vals.nth(i).inner_text().strip()
    return out


def select_option(page, index: int, needle: str) -> None:
    page.get_by_role("combobox").nth(index).click()
    page.wait_for_timeout(500)
    opts = page.get_by_role("option")
    for i in range(opts.count()):
        if needle in (opts.nth(i).inner_text() or ""):
            opts.nth(i).click()
            page.wait_for_timeout(800)
            return
    raise AssertionError(f"option containing {needle!r} not found")


def nav(page, title: str) -> None:
    page.get_by_role("link", name=title).first.click()
    page.wait_for_timeout(1800)


def set_view(page, option: str) -> None:
    """Streamlit renders radio inputs hidden behind their labels."""
    grp = page.get_by_role("radiogroup", name="View")
    try:
        grp.get_by_text(option, exact=True).first.click()
    except Exception:                             # noqa: BLE001
        page.get_by_role("radio", name=option).first.click(force=True)
    page.wait_for_timeout(1000)


def step(name: str, fn, *args) -> None:
    """Run one interaction, record failures, keep verifying the rest."""
    try:
        fn(*args)
        REPORT.setdefault("steps", []).append(f"ok: {name}")
    except Exception as exc:                      # noqa: BLE001
        REPORT.setdefault("steps", []).append(f"FAILED: {name}: {exc}")
        print(f"FAILED step {name}: {exc}")


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
        nav(page, "Video Studio")
        shoot(page, "01_studio_empty")          # polished pre-run state

        # choose the bundled anomaly sample and run the real pipeline
        select_option(page, 0, "anomaly_clip")
        page.get_by_role("button", name="Analyze", exact=True).click()
        try:
            page.wait_for_selector("text=Explore results in the other pages",
                                   timeout=180000)
        except Exception as exc:                # noqa: BLE001
            print("WARN analysis did not confirm:", exc)
        page.wait_for_timeout(1500)
        shoot(page, "02_studio_results")
        REPORT["kpis"] = kpis(page)
        REPORT["images_before"] = page.locator("img").count()
        REPORT["frame_kpi_before"] = kpis(page).get("frame")

        # annotated vs original, explicitly labelled
        step("view=Both", set_view, page, "Both")
        body = page.inner_text("body")
        REPORT["labels_both"] = ("ANNOTATED" in body and "ORIGINAL" in body)
        REPORT["images_both"] = page.locator("img").count()
        shoot(page, "03_studio_both_views")

        # frame navigation really moves the viewer
        step("view=Annotated", set_view, page, "Annotated")
        step("next_frame",
             lambda: (page.get_by_role("button", name="\u203a").first.click(),
                      page.wait_for_timeout(1200)))
        REPORT["frame_kpi_after_next"] = kpis(page).get("frame")

        # jump to the last anomaly event
        def _jump():
            page.get_by_role("combobox", name="Jump to anomaly").click()
            page.wait_for_timeout(500)
            page.get_by_role("option").last.click()
            page.wait_for_timeout(1800)
        step("jump_to_event", _jump)
        REPORT["frame_kpi_after_jump"] = kpis(page).get("frame")
        REPORT["evidence_panel"] = "Object evidence" in page.inner_text("body")
        shoot(page, "04_studio_event_jump")

        # playback: start, confirm it advances, stop
        def _play():
            page.get_by_role("button", name="\u25b6 Play").first.click()
            page.wait_for_timeout(2500)
            REPORT["frame_during_play"] = kpis(page).get("frame")
            stop = page.get_by_role("button", name="\u25a0 Stop")
            if stop.count():
                stop.first.click()
                page.wait_for_timeout(1200)
            REPORT["frame_after_stop"] = kpis(page).get("frame")
        step("playback", _play)
        shoot(page, "05_studio_playback")

        # cross-page link wired to the selected track
        def _open_track():
            btns = page.get_by_role("button")
            for i in range(btns.count()):
                if "in explorer" in (btns.nth(i).inner_text() or ""):
                    btns.nth(i).click()
                    page.wait_for_timeout(2500)
                    REPORT["track_link_opened"] = True
                    REPORT["track_link_page"] = page.inner_text("h1")[:60]
                    return
            raise AssertionError("track link button not found")
        step("track_link", _open_track)
        shoot(page, "06_track_explorer_from_studio")

        # staleness guard: point the source at a different sample
        nav(page, "Video Studio")
        step("stale_notice",
             lambda: (select_option(page, 0, "normal_traffic"),
                      page.wait_for_timeout(800),
                      REPORT.update({"stale_notice": "Showing results from"
                                     in page.inner_text("body")})))
        shoot(page, "07_studio_stale_notice")

        browser.close()

    print("console/page errors:", ERRORS if ERRORS else "none")
    return 1 if ERRORS else 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        (OUT / "report.json").write_text(json.dumps(REPORT, indent=2))
        print(json.dumps(REPORT, indent=2))
    sys.exit(code)

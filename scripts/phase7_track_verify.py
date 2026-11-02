"""Phase 7 live verification: drive the real Track Explorer against FastAPI.

Requires uvicorn on 127.0.0.1:8000 and Vite on 127.0.0.1:3000.
Run with the project venv and the Chromium library paths used by Phase 6.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright

BASE = "http://127.0.0.1:3000"
OUT = Path("artifacts/phase7/tracks")
REVIEW = OUT / "review"

ANOMALY = "api_20261102_053200_5b4db1"
NORMAL = "api_20261102_053228_195fd6"
EMPTY = "api_20261102_053736_2fbb5d"
HISTORICAL = "api_20261102_045234_b7b7fd"


def save(page: Page, name: str, full: bool = False) -> None:
    path = OUT / f"{name}.png"
    page.screenshot(path=str(path), full_page=full)
    image = Image.open(path)
    width = 1100 if image.width > 1100 else image.width
    image.resize(
        (width, int(image.height * width / image.width)), Image.LANCZOS
    ).save(REVIEW / f"{name}.png", optimize=True)


def track_ids(page: Page) -> list[str]:
    return [
        text.split()[0]
        for text in page.locator("button.track-row").all_inner_texts()
    ]


def run() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    REVIEW.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
        )
        context = browser.new_context(
            viewport={"width": 1512, "height": 950}, device_scale_factor=2
        )
        page = context.new_page()
        page.on("pageerror", lambda error: problems.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: problems.append(f"console: {message.text}")
            if message.type == "error"
            else None,
        )

        print("=== anomaly_clip ===")
        page.goto(f"{BASE}/tracks?session={ANOMALY}", wait_until="networkidle")
        page.wait_for_selector("button.track-row")
        page.wait_for_timeout(700)
        print("tracks:", track_ids(page))
        print("trajectory:", page.locator(".trajectory svg").get_attribute("aria-label"))
        print("telemetry:", " ".join(page.locator(".panel", has_text="Track telemetry").inner_text().split())[:220])
        print("anomaly rows:", page.locator(".track-event").count())
        print("frame:", " ".join(page.locator(".frame__caption").inner_text().split()))
        save(page, "01_anomaly_session")

        # Switch to the erratic track and inspect its trajectory.
        page.get_by_role("button", name="Track T02,").click()
        page.wait_for_selector("text=T02 · measured lifecycle and motion")
        page.wait_for_timeout(500)
        print("switched:", track_ids(page)[0], "active T02")
        print("T02 trajectory:", page.locator(".trajectory svg").get_attribute("aria-label"))
        print("T02 telemetry:", " ".join(page.locator(".panel", has_text="Track telemetry").inner_text().split())[:260])
        save(page, "02_track_switched_t02")

        # Search (client-side over loaded tracks).
        page.get_by_label("Search tracks").fill("red")
        page.wait_for_timeout(300)
        print("search 'red' rows:", track_ids(page))
        page.get_by_label("Search tracks").fill("")
        page.wait_for_timeout(300)

        # Server-side level filter and sort.
        page.get_by_label("Filter tracks by level").select_option("Irregular")
        page.wait_for_timeout(800)
        print("filter Irregular rows:", track_ids(page))
        page.get_by_label("Filter tracks by level").select_option("all")
        page.wait_for_timeout(600)
        page.get_by_label("Sort tracks").select_option("speed")
        page.wait_for_timeout(800)
        print("sort speed first:", track_ids(page)[0])
        save(page, "03_filtered_index")

        # Back to T00 for a full 420-point path, then inspect a recorded point.
        page.get_by_role("button", name="Track T00,").click()
        page.wait_for_selector("text=T00 · measured lifecycle and motion")
        page.wait_for_timeout(500)
        hits = page.locator(".trajectory__hit")
        print("trajectory hit targets:", hits.count())
        hits.nth(120).click(force=True)
        page.wait_for_timeout(400)
        print("readout:", " ".join(page.locator(".trajectory__readout").inner_text().split()))
        print("selected row:", page.locator(".table tr.is-active").count())
        save(page, "04_trajectory_point_selected")

        # Observation row + paging + related anomaly navigation.
        rows = page.locator(".table tbody tr.is-clickable")
        rows.nth(4).click()
        page.wait_for_timeout(300)
        print("selected row:", " ".join(page.locator(".table tr.is-active").inner_text().split()))
        page.locator(".pager").filter(has_text="observations").get_by_role("button", name="Next").click()
        page.wait_for_timeout(700)
        print("pager:", " ".join(page.locator(".pager").filter(has_text="observations").inner_text().split()))

        event = page.locator(".track-event").first
        event.click()
        page.wait_for_timeout(900)
        print("event frame:", " ".join(page.locator(".frame__caption").inner_text().split()))
        print("focus note:", page.locator(".hint--focus").inner_text() if page.locator(".hint--focus").count() else "none")

        payload = page.locator(".panel", has_text="Movement over time")
        payload.scroll_into_view_if_needed()
        page.wait_for_timeout(400)
        print("motion stats:", " | ".join(" ".join(x.split()) for x in page.locator(".motion-stat").all_inner_texts()))
        save(page, "05_movement_and_frames")

        # Related anomalies on track T02 and a frame that is not retained.
        page.get_by_role("button", name="Track T02,").click()
        page.wait_for_timeout(800)
        print("T02 anomaly events:", page.locator(".track-event").count())
        page.locator(".track-event").first.click()
        page.wait_for_timeout(800)
        print("T02 focus note:", page.locator(".hint--focus").inner_text() if page.locator(".hint--focus").count() else "none")
        save(page, "06_track_anomaly_jump")

        print("=== normal_traffic ===")
        page.goto(f"{BASE}/tracks?session={NORMAL}", wait_until="networkidle")
        page.wait_for_selector("button.track-row")
        page.wait_for_timeout(700)
        print("tracks:", track_ids(page))
        print("trajectory:", page.locator(".trajectory svg").get_attribute("aria-label"))
        print("motion:", " | ".join(" ".join(x.split()) for x in page.locator(".motion-stat").all_inner_texts()))
        print("frame:", " ".join(page.locator(".frame__caption").inner_text().split()))
        save(page, "07_normal_session")
        page.get_by_role("button", name="Track T00,").click()
        page.wait_for_timeout(700)
        print("normal T00 telemetry:", " ".join(page.locator(".panel", has_text="Track telemetry").inner_text().split())[:230])
        save(page, "08_normal_t00")

        print("=== historical session without artifacts ===")
        page.goto(f"{BASE}/tracks?session={HISTORICAL}", wait_until="networkidle")
        page.wait_for_selector("button.track-row")
        page.wait_for_timeout(900)
        print("tracks:", track_ids(page))
        print("trajectory empty:", " ".join(page.locator(".canvas-stub").inner_text().split())[:220])
        print("frames empty:", " ".join(page.locator(".investigator__stage").inner_text().split())[:220])
        save(page, "09_historical_no_trajectory")

        print("=== zero-track session ===")
        page.goto(f"{BASE}/tracks?session={EMPTY}", wait_until="networkidle")
        page.wait_for_timeout(900)
        print("page empty:", " ".join(page.locator(".state").first.inner_text().split())[:220] if page.locator(".state").count() else "no state")
        print("track workspace:", " ".join(page.locator(".panel", has_text="Track workspace").inner_text().split())[:120])
        save(page, "10_empty_session")

        print("=== API failure on track detail ===")
        page.route(
            f"**/api/v1/sessions/{ANOMALY}/tracks/1",
            lambda route: route.abort(),
        )
        page.goto(f"{BASE}/tracks?session={ANOMALY}", wait_until="networkidle")
        page.wait_for_selector("button.track-row")
        page.get_by_role("button", name="Track T01,").click()
        page.wait_for_timeout(900)
        print("failure title:", page.get_by_text("Track detail unavailable").count())
        print("failure body:", " ".join(page.locator(".state", has_text="Track detail unavailable").inner_text().split())[:200])
        save(page, "11_api_failure")
        page.unroute(f"**/api/v1/sessions/{ANOMALY}/tracks/1")

        print("=== mobile 390x844 ===")
        mobile = context.new_page()
        mobile.set_viewport_size({"width": 390, "height": 844})
        mobile.goto(f"{BASE}/tracks?session={ANOMALY}", wait_until="networkidle")
        mobile.wait_for_selector("button.track-row")
        mobile.wait_for_timeout(700)
        print("mobile picker visible:", mobile.locator(".track-mobile-select").is_visible())
        print("mobile picker options:", mobile.locator(".track-mobile-select option").count())
        save(mobile, "12_mobile_top")
        mobile.locator(".panel", has_text="Track index").scroll_into_view_if_needed()
        mobile.wait_for_timeout(400)
        save(mobile, "13_mobile_index")
        mobile.locator(".panel", has_text="Movement over time").scroll_into_view_if_needed()
        mobile.wait_for_timeout(400)
        save(mobile, "14_mobile_movement")
        mobile.locator("#track-frame-investigation").scroll_into_view_if_needed()
        mobile.wait_for_timeout(400)
        save(mobile, "15_mobile_frames")
        mobile.get_by_label("Selected track").select_option("2")
        mobile.wait_for_timeout(700)
        print("mobile switched:", mobile.locator(".panel", has_text="Track telemetry").inner_text().split()[0:3])

        print("console/page errors on clean pages:", problems or "none")
        context.close()
        browser.close()


if __name__ == "__main__":
    run()

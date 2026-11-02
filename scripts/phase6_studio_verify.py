"""Phase 6 browser verification for the Video Studio.

Drives the real UI against the real FastAPI service:
  * invalid file rejection
  * upload + analysis of samples/anomaly_clip.mp4 (live progress -> results)
  * frame investigation navigation
  * cancellation of a normal_traffic.mp4 run
  * a genuine engine failure (upload truncated before analysis)
  * a genuinely lost job after an API restart
  * historical session without retained media

Screenshots land in artifacts/phase6/studio (review copies downscaled).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "phase6" / "studio"
REVIEW = OUT / "review"
BASE = "http://127.0.0.1:3000"
API = "http://127.0.0.1:8000/api/v1"
UPLOADS = ROOT / "output" / "uploads"
PROBLEMS: list[str] = []


def shot(page: Page, name: str) -> None:
    path = OUT / name
    page.screenshot(path=str(path))
    print(f"  shot {name}")


def wait_text(page: Page, text: str, timeout: int = 120_000) -> None:
    page.get_by_text(text, exact=False).first.wait_for(timeout=timeout)


def scroll_to(page: Page, selector: str) -> None:
    page.locator(selector).first.scroll_into_view_if_needed()
    page.wait_for_timeout(450)


def jobs_list() -> list[dict]:
    import urllib.request

    with urllib.request.urlopen(f"{API}/jobs?limit=10", timeout=10) as response:
        return json.load(response)["jobs"]


def api_pid() -> int | None:
    """PID listening on 8000, from ss — never a pattern kill."""
    output = subprocess.run(
        ["ss", "-ltnp"], capture_output=True, text=True, check=False
    ).stdout
    for line in output.splitlines():
        if ":8000" in line:
            match = re.search(r"pid=(\d+)", line)
            if match:
                return int(match.group(1))
    return None


def api_running() -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen(f"{API}/health", timeout=3) as response:
            return response.status == 200
    except Exception:  # noqa: BLE001
        return False


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    REVIEW.mkdir(parents=True, exist_ok=True)
    notes = OUT / "notes.txt"
    notes.write_text("this is not a video\n", encoding="utf-8")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
        )
        context = browser.new_context(
            viewport={"width": 1512, "height": 950}, device_scale_factor=2
        )
        page = context.new_page()
        page.on("pageerror", lambda exc: PROBLEMS.append(f"pageerror: {exc}"))
        page.on(
            "console",
            lambda msg: PROBLEMS.append(f"console: {msg.text}")
            if msg.type == "error"
            else None,
        )

        # ---------------------------------------------------------- intake
        page.goto(f"{BASE}/video-studio", wait_until="networkidle")
        page.locator("h1").wait_for()
        print("studio:", page.locator("h1").inner_text())
        shot(page, "01_idle.png")

        page.set_input_files("input[type=file]", str(notes))
        wait_text(page, "Upload rejected", 20_000)
        shot(page, "02_invalid_format.png")
        print("invalid:", page.locator(".alert__text").first.inner_text()[:90])

        page.set_input_files("input[type=file]", str(ROOT / "samples" / "anomaly_clip.mp4"))
        wait_text(page, "Validated", 90_000)
        shot(page, "03_uploaded.png")
        print("uploaded:", page.locator(".clip__meta").first.inner_text())

        # ---------------------------------------------------------- sample run
        page.get_by_role("button", name="Start analysis").click()
        page.locator(".job-state__stage").wait_for(timeout=30_000)
        shot(page, "04_progress.png")
        print("stage at start:", page.locator(".job-state__stage").inner_text())
        wait_text(page, "Analysis complete", 240_000)
        shot(page, "05_complete.png")
        print("result:", " | ".join(page.locator(".job-result__meta").inner_text().split("\n")))

        scroll_to(page, "#studio-results")
        shot(page, "06_results.png")
        print("metrics:", page.locator(".metric-grid").first.inner_text().replace("\n", " "))
        print("envelope:", " | ".join(page.locator(".rows .row").all_inner_texts()[:6]))

        scroll_to(page, ".investigator")
        shot(page, "07_investigation.png")
        page.get_by_role("button", name="Original", exact=True).click()
        page.wait_for_timeout(600)
        shot(page, "08_original_frame.png")
        for _ in range(3):
            page.get_by_role("button", name="Next retained frame").click()
            page.wait_for_timeout(350)
        shot(page, "09_frame_stepped.png")
        print("frame caption:", " ".join(page.locator(".frame__caption").inner_text().split()))
        print("events on frame:", page.locator(".event-mini__item").count())

        # ---------------------------------------------------------- cancel
        page.goto(f"{BASE}/video-studio", wait_until="networkidle")
        row = page.locator(".sample-item", has_text="normal_traffic.mp4")
        row.get_by_role("button", name="Analyse").click()
        page.get_by_role("button", name="Cancel analysis").wait_for(timeout=20_000)
        page.get_by_role("button", name="Cancel analysis").click()
        wait_text(page, "Analysis cancelled", 120_000)
        shot(page, "10_cancelled.png")
        cancelled = jobs_list()[0]
        print("cancelled job:", cancelled["job_id"], cancelled["state"],
              cancelled["progress"]["processed"], "frames")

        # ---------------------------------------------------------- failure
        page.goto(f"{BASE}/video-studio", wait_until="networkidle")
        page.set_input_files("input[type=file]", str(ROOT / "samples" / "anomaly_clip.mp4"))
        wait_text(page, "Validated", 90_000)
        newest = max((p for p in UPLOADS.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)
        newest.write_bytes(b"")
        print("truncated upload:", newest.name)
        page.get_by_role("button", name="Start analysis").click()
        wait_text(page, "Analysis failed", 240_000)
        shot(page, "11_failed.png")
        print("failure:", page.locator(".alert--bad .alert__title").first.inner_text(),
              "|", page.locator(".alert--bad .alert__text").first.inner_text()[:80])

        # ---------------------------------------------------- lost after restart
        page.goto(f"{BASE}/video-studio", wait_until="networkidle")
        page.locator(".sample-item", has_text="normal_traffic.mp4").get_by_role(
            "button", name="Analyse"
        ).click()
        page.get_by_role("button", name="Cancel analysis").wait_for(timeout=20_000)
        pid = api_pid()
        print("killing API mid-run, pid", pid)
        if pid is not None:
            os_kill = subprocess.run(["kill", str(pid)], capture_output=True, text=True)
            if os_kill.returncode != 0:
                PROBLEMS.append(f"could not stop API pid {pid}: {os_kill.stderr.strip()}")
        time.sleep(2.0)
        subprocess.Popen(
            [str(ROOT / ".venv" / "bin" / "python"), "-m", "uvicorn",
             "src.api.main:app", "--host", "127.0.0.1", "--port", "8000"],
            cwd=ROOT, stdout=open("/tmp/api_p6f.log", "a"), stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        for _ in range(60):
            if api_running():
                break
            time.sleep(0.5)
        page.reload(wait_until="networkidle")
        wait_text(page, "no longer knows that job", 120_000)
        shot(page, "12_lost_job.png")

        # ------------------------------------------------- historical session
        page.goto(f"{BASE}/video-studio", wait_until="networkidle")
        historical = page.locator(
            ".table--sessions tbody tr", has_text="api_20261031_180059_96c60e"
        )
        historical.get_by_role("button", name=re.compile("Open session")).click()
        wait_text(page, "No preview frames are retained", 60_000)
        scroll_to(page, ".investigator")
        shot(page, "13_history_no_media.png")
        print("history note:", page.locator(".investigator .state__body").first.inner_text()[:100])

        # ---------------------------------------------------- console errors
        page.wait_for_timeout(600)
        context.close()
        browser.close()

    print("console/page errors:", PROBLEMS or "none")
    for name in sorted(p.name for p in OUT.glob("*.png")):
        image = Image.open(OUT / name)
        image.resize((1100, int(image.height * 1100 / image.width)), Image.LANCZOS).save(
            REVIEW / name, optimize=True
        )
    print("review copies:", len(list(REVIEW.glob("*.png"))))
    return 0 if not PROBLEMS else 1


if __name__ == "__main__":
    sys.exit(main())

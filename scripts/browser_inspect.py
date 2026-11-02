"""Browser inspection: drive the real dashboard, capture every page, and
survive renderer restarts (relaunch + re-analyze when disconnected)."""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path("artifacts")
OUT.mkdir(exist_ok=True)
URL = "http://127.0.0.1:3000"
errors: list[str] = []


class Driver:
    def __init__(self, pw):
        self.pw = pw
        self.browser = None
        self.page = None
        self._start()

    def _start(self):
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:
                pass
        self.browser = self.pw.chromium.launch(
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
        self.page = self.browser.new_page(
            viewport={"width": 1500, "height": 950})
        self.page.on("console", lambda m: errors.append(m.text[:200])
                     if m.type == "error" else None)
        self.page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        self.page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        self.page.wait_for_timeout(3500)

    def alive(self) -> bool:
        try:
            return self.browser.is_connected()
        except Exception:
            return False

    def ensure(self):
        if not self.alive():
            print("!! browser disconnected - relaunching")
            self._start()

    def shot(self, name):
        self.page.wait_for_timeout(1200)
        self.page.screenshot(path=str(OUT / f"{name}.png"))
        print(f"captured {name}")

    def nav(self, label):
        self.page.get_by_text(label, exact=True).first.click()
        self.page.wait_for_timeout(3500)

    def analyze(self, budget: int = 200):
        self.ensure()
        self.nav("Video Studio")
        self.shot("02_studio_before")
        self.page.get_by_text("Analyze", exact=True).first.click()
        self.page.wait_for_selector("text=Analyzed", timeout=180000)
        self.page.wait_for_timeout(3000)
        self.shot("03_studio_results")


with sync_playwright() as pw:
    d = Driver(pw)
    d.shot("01_overview_empty")

    # --- Video Studio analysis (real run in the browser)
    d.nav("Video Studio")
    d.shot("02_studio_before")
    d.page.get_by_text("Analyze", exact=True).first.click()
    try:
        d.page.wait_for_selector("text=Analyzed", timeout=180000)
        print("analysis completed in browser")
    except Exception as exc:
        print("analyze wait failed:", exc)
        d.ensure()
        d.nav("Video Studio")
        d.page.get_by_text("Analyze", exact=True).first.click()
        d.page.wait_for_selector("text=Analyzed", timeout=180000)
    d.page.wait_for_timeout(3000)
    d.shot("03_studio_results")

    # move the preview slider to a late frame so objects/trajectories show
    try:
        preview = d.page.locator("div[data-testid='stSlider']").filter(
            has_text="Preview frame")
        preview.locator("input").focus()
        preview.locator("input").press("End")
        d.page.wait_for_timeout(2500)
        d.shot("03b_studio_frame_end")
    except Exception as exc:
        print("slider jump failed:", exc)

    try:
        d.page.get_by_text("Original", exact=True).first.click()
        d.page.wait_for_timeout(2000)
        d.shot("04_studio_original")
    except Exception as exc:
        print("view toggle failed:", exc)

    for label, name in [("Overview", "05_overview_session"),
                        ("Track Explorer", "06_tracks"),
                        ("Anomaly Center", "07_anomaly"),
                        ("Scene Intelligence", "08_scene"),
                        ("Evaluation & Reports", "09_evaluation")]:
        try:
            d.ensure()
            d.nav(label)
            d.shot(name)
        except Exception as exc:
            print(f"nav {label} failed: {exc}")
            d.ensure()
            d.analyze()

    # --- evaluation flow: label both tracks, compute metrics, screenshot
    try:
        d.ensure()
        # Streamlit selectboxes are custom comboboxes: click then pick an option
        def pick(label_text, option):
            d.page.get_by_label(label_text, exact=True).first.click()
            d.page.wait_for_timeout(700)
            d.page.get_by_role("option", name=option, exact=True).first.click()
            d.page.wait_for_timeout(2200)

        pick("Track 0", "Normal")
        pick("Track 1", "Normal")
        pick("Track 2", "Anomaly")
        if d.page.get_by_label("Track 3", exact=True).count():
            pick("Track 3", "Anomaly")
        staged = d.page.get_by_text("observation labels staged").first.inner_text()
        print("staged:", staged[:70])
        d.page.get_by_text("Evaluate now").first.click()
        d.page.wait_for_timeout(3500)
        print("has harmonic-mean KPI:", d.page.get_by_text("harmonic mean").count())
        d.shot("10_evaluation_metrics")
    except Exception as exc:
        print("evaluate failed:", exc)
        d.shot("10_evaluation_metrics")

    d.browser.close()

print("console/page errors:", errors[:8] if errors else "none")
sys.exit(0)
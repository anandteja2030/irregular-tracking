"""Phase 7/8 tests: dashboard shell, pages, session engine, CLI contract and
persistence - everything the UI depends on, verified through
`streamlit.testing.v1.AppTest` (real script execution) plus unit checks.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.config import SETTINGS, AppPaths          # noqa: E402
from src.analysis.logger import ResultLogger          # noqa: E402
from src.ui import session                            # noqa: E402

APP = ROOT / "src" / "ui" / "dashboard.py"
SAMPLE = "sample: anomaly_clip.mp4"
SMALL_BUDGET = 50


def _apptest(timeout: int = 120):
    from streamlit.testing.v1 import AppTest
    at = AppTest.from_file(str(APP), default_timeout=timeout)
    at.run()
    assert not at.exception, [str(e.value) for e in at.exception]
    return at


def _analyze(at=None, budget: int = SMALL_BUDGET):
    """Drive Video Studio to a completed analysis and return the AppTest."""
    if at is None:
        at = _apptest()
    at.switch_page("pages/video_studio.py").run(timeout=90)
    at.selectbox[0].select(SAMPLE).run(timeout=90)
    at.slider[0].set_value(budget)
    idx = [i for i, b in enumerate(at.button) if b.label == "Analyze"][0]
    at.button[idx].click().run(timeout=180)
    assert not at.exception, [str(e.value) for e in at.exception]
    res = at.session_state["session_result"]
    assert res is not None and res.error is None
    assert res.frames_processed == budget
    assert len(res.previews) > 0
    return at, res


# ------------------------------------------------------------------ shell
def test_shell_navigation_covers_all_pages():
    at = _apptest()
    # default page is Overview with the sample gallery (no session yet)
    html = " ".join(m.value for m in at.markdown)
    assert "Bundled samples" in html
    assert any(b.label.startswith("Analyze") for b in at.button)
    for page in ("pages/overview.py", "pages/video_studio.py",
                 "pages/tracks.py", "pages/anomaly_center.py",
                 "pages/scene.py", "pages/evaluation.py",
                 "pages/settings.py"):
        at.switch_page(page).run(timeout=90)
        assert not at.exception, f"{page}: {[str(e.value) for e in at.exception]}"


def test_pages_without_session_show_empty_states_not_crashes():
    at = _apptest()
    for page in ("pages/tracks.py", "pages/anomaly_center.py",
                 "pages/scene.py", "pages/evaluation.py"):
        at.switch_page(page).run(timeout=90)
        assert not at.exception, f"{page}: {[str(e.value) for e in at.exception]}"
        html = " ".join(m.value for m in at.markdown)
        assert "waiting for an analysis run" in html, page


# ---------------------------------------------------------------- settings
def test_settings_page_apply_reject_invalid_and_reset():
    """Settings writes are real: apply mutates the live config, invalid
    threshold pairs are refused, reset restores the shipped defaults."""
    from config.config import AnomalyConfig, load_config

    cfg = load_config()
    at = _apptest()
    at.switch_page("pages/settings.py").run(timeout=90)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "Current configuration" in html and "Runtime" in html

    def _set(label: str, value) -> bool:
        for n in at.number_input:
            if n.label == label:
                n.set_value(value)
                return True
        return False

    try:
        assert _set("Suspicious threshold (fused score ≥)", 0.40)
        assert _set("Rule weight", 0.60)
        assert _set("Isolation Forest weight", 0.20)
        assert _set("Scene weight", 0.20)
        idx = [i for i, b in enumerate(at.button)
               if b.label == "Apply changes"][0]
        at.button[idx].click().run(timeout=90)
        assert not at.exception
        assert cfg.anomaly.threshold_suspicious == 0.40
        assert cfg.anomaly.weights == {"rule": 0.6, "ml": 0.2, "scene": 0.2}
        assert any("Applied" in s.value for s in at.success)

        # incoherent thresholds are refused and the config is untouched
        assert _set("Suspicious threshold (fused score ≥)", 0.90)
        assert _set("Irregular threshold (fused score ≥)", 0.30)
        at.button[idx].click().run(timeout=90)
        assert not at.exception
        assert any("lower than the Irregular" in e.value for e in at.error)
        assert cfg.anomaly.threshold_suspicious == 0.40   # unchanged
    finally:
        at2 = _apptest()
        at2.switch_page("pages/settings.py").run(timeout=90)
        ridx = [i for i, b in enumerate(at2.button)
                if b.label == "Reset to defaults"][0]
        at2.button[ridx].click().run(timeout=90)
        assert not at2.exception
        assert cfg.anomaly == AnomalyConfig()            # defaults restored


# --------------------------------------------------------------- studio
def test_studio_analyze_produces_session_and_viewer():
    at, res = _analyze()
    assert res.is_synthetic is True           # bundled sample disclosed
    assert len(res.tracks) >= 1
    assert not res.obs.empty
    assert list(res.obs.columns) == session.OBS_COLS
    assert len(res.previews) >= 1
    # viewer: KPI html + frame observation table present
    html = " ".join(m.value for m in at.markdown)
    assert "Frame" in html and "Tracks here" in html
    assert len(at.dataframe) >= 1
    # toggling the view mode must not crash
    at.radio(key="studio_mode").set_value("Both").run(timeout=60)
    assert not at.exception
    at.radio(key="studio_mode").set_value("Original").run(timeout=60)
    assert not at.exception


def test_studio_error_state_for_corrupt_source(tmp_path, monkeypatch):
    (tmp_path / "broken.mp4").write_bytes(b"not a video")
    monkeypatch.setattr(SETTINGS, "paths",
                        AppPaths(samples=tmp_path,
                                 output=SETTINGS.paths.output,
                                 db=SETTINGS.paths.db))
    at = _apptest()
    at.switch_page("pages/video_studio.py").run(timeout=90)
    at.selectbox[0].select("sample: broken.mp4").run(timeout=60)
    idx = [i for i, b in enumerate(at.button) if b.label == "Analyze"][0]
    at.button[idx].click().run(timeout=90)
    assert not at.exception, "corrupt input must not surface a traceback"
    assert any("Could not open" in e.value for e in at.error)


# ------------------------------------------- phase 2: studio workspace
from src.ui.pages.video_studio import _evidence_html, validate_upload  # noqa: E402


def _nearest(res, frame_idx: int) -> int:
    return min(range(len(res.previews)),
               key=lambda i: abs(res.previews[i].frame_idx - frame_idx))


def test_studio_upload_validation_is_specific():
    """Bad uploads get a human reason, good ones pass through."""
    assert validate_upload("clip.mp4", b"\x00\x01\x02") is None
    assert "Unsupported format" in validate_upload("clip.txt", b"x")
    assert "empty" in validate_upload("clip.mp4", b"")
    assert validate_upload("", b"x") is not None


def test_studio_evidence_panel_separates_rule_ml_scene_streams():
    """The evidence panel must distinguish the rule engine from the
    Isolation Forest and the scene-relative stream, and must never imply a
    model flag on a clean Normal row."""
    row = {
        "track_id": 4, "level": "Irregular", "frame": 42, "ts_s": 1.4,
        "fused_score": 0.72, "speed_px_s": 610.0, "direction_deg": 275.0,
        "color": "red", "shape": "circle", "why": "fast & against flow",
        "rules_json": json.dumps([{"rule": "excessive_speed", "severity": 0.8,
                                   "description": "speed 610 px/s is 2.9 SDs "
                                                  "above the mean"}]),
        "ml_score": 0.45, "ml_note": "rare for this track",
        "scene_score": 0.3, "scene_note": "unusual for this scene",
        "zone": None, "zone_dwell_s": 0.0,
    }
    out = _evidence_html(row)
    assert "Irregular" in out and "excessive_speed" in out
    assert "Isolation Forest" in out and "scene-relative" in out
    assert "fast &amp; against flow" in out      # escaped, not raw HTML

    normal = dict(row, level="Normal", fused_score=0.08, rules_json="[]",
                  ml_score=0.0, ml_note="", scene_score=0.0, scene_note="",
                  why="")
    out2 = _evidence_html(normal)
    assert "No rule fired and no model flag" in out2
    assert "Isolation Forest" not in out2 and "scene-relative" not in out2


def test_studio_workspace_investigation_and_stale_notice():
    """Phase 2 workspace: labelled footage, real frame KPIs, event jump that
    actually moves the viewer, evidence panel, page links and the guard that
    flags results from a previously analysed source."""
    # an interrupted run must never leave a stale "Processing\u2026" indicator
    at = _apptest()
    at.session_state["analysis_state"] = "running"
    at.switch_page("pages/video_studio.py").run(timeout=90)
    assert not at.exception
    assert at.session_state.get("analysis_state") is None

    at, res = _analyze(at)
    html = " ".join(m.value for m in at.markdown)
    assert "ANNOTATED" in html and "Tracks here" in html
    assert len(at.dataframe) >= 1                     # frame observation table

    # original vs annotated footage are explicitly labelled
    at.radio(key="studio_mode").set_value("Both").run(timeout=60)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "ANNOTATED" in html and "ORIGINAL" in html
    at.radio(key="studio_mode").set_value("Annotated").run(timeout=60)
    assert not at.exception

    # jump to an anomaly: the viewer must land on the preview carrying it
    jbox = [i for i, s in enumerate(at.selectbox)
            if s.label == "Jump to anomaly"]
    assert jbox, "an anomaly jump control must exist for a flagged session"
    opts = at.selectbox[jbox[0]].options
    pick = opts[-1]                       # last event, far from frame 0
    assert at.session_state["studio_index"] == 0
    at.selectbox[jbox[0]].select(pick).run(timeout=60)
    assert not at.exception
    frame = int(pick.split(" ·", 1)[0][1:])
    tid = int(pick.split("track ", 1)[1].split(" ·", 1)[0])
    # spec: land on the nearest preview where this track was actually seen
    seen = {int(f) for f in res.obs.loc[res.obs["track_id"] == tid, "frame"]}
    cand = [i for i, pv in enumerate(res.previews) if pv.frame_idx in seen]
    expected = (min(cand, key=lambda i: abs(res.previews[i].frame_idx - frame))
                if cand else _nearest(res, frame))
    assert at.session_state["studio_index"] == expected

    # evidence rail describes the landed frame
    html = " ".join(m.value for m in at.markdown)
    assert "Object evidence" in html
    objs = [s for s in at.selectbox if s.label == "Object on this frame"]
    if objs:
        assert "Why:" in html and "measured:" in html
    # links to the investigation pages exist and are wired to session state
    labels = [b.label for b in at.button]
    assert any("in explorer" in l for l in labels)
    assert any(l == "Anomaly Center →" for l in labels)

    # inspect-track jump: picking another track lands on that track's key
    # frame (the captured preview where its highest fused score was seen)
    def _tid(opt) -> int:
        # options may be raw ids or format_func labels like "#2 · red circle"
        return int(str(opt).lstrip("#").split()[0])

    tbox = [i for i, s in enumerate(at.selectbox)
            if s.label == "Inspect track"]
    assert tbox
    tids = list(at.selectbox[tbox[0]].options)
    current_id = _tid(at.session_state["studio_track"])
    others = [t for t in tids if _tid(t) != current_id]
    if others:
        other_opt = others[0]
        other = _tid(other_opt)
        at.selectbox[tbox[0]].select(other_opt).run(timeout=60)
        assert not at.exception
        rows = res.obs[res.obs["track_id"] == other]
        assert not rows.empty, "selected track must have observations"
        key_frame = int(rows.loc[rows["fused_score"].idxmax(), "frame"])
        seen = {int(f) for f in rows["frame"]}
        cand = [i for i, pv in enumerate(res.previews)
                if pv.frame_idx in seen]
        expected = (min(cand, key=lambda i: abs(res.previews[i].frame_idx
                                                - key_frame))
                    if cand else _nearest(res, key_frame))
        assert at.session_state["studio_index"] == expected

    # stale-result guard: switching the source must flag old results
    others = [o for o in at.selectbox[0].options if o != res.source_label]
    if others:
        at.selectbox[0].select(others[0]).run(timeout=60)
        assert not at.exception
        assert any("Showing results from" in i.value for i in at.info)


def test_studio_frame_player_and_prev_next_navigation():
    """The preview player advances exactly one frame per pass and stops at
    the end - no runaway rerun loop. Prev/next must really move the viewer
    (regression: a separate slider widget key used to revert them)."""
    at, res = _analyze()
    n = len(res.previews)
    assert n >= 2
    nxt = [i for i, b in enumerate(at.button) if b.label == "›"][0]
    at.button[nxt].click().run(timeout=60)
    assert not at.exception
    assert at.session_state["studio_index"] == 1
    prv = [i for i, b in enumerate(at.button) if b.label == "‹"][0]
    at.button[prv].click().run(timeout=60)
    assert not at.exception
    assert at.session_state["studio_index"] == 0

    at.session_state["studio_index"] = n - 2
    at.session_state["studio_playing"] = True
    at.run(timeout=60)
    assert not at.exception
    assert at.session_state["studio_index"] == n - 1
    assert at.session_state.get("studio_playing") is False
    assert any("finished" in c.value for c in at.caption)


# ----------------------------------------------------------- anomaly center
def test_anomaly_center_filtering_and_event_investigation():
    at, res = _analyze()
    at.switch_page("pages/anomaly_center.py").run(timeout=90)
    assert not at.exception
    assert any(s.label == "Selected event" for s in at.selectbox)
    # nonsense search -> explicit no-match empty state, not a crash
    at.text_input(key="ac_search").set_value("zzz-no-such-explanation").run(timeout=60)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "No events match the current filters" in html
    # clear search -> event selection + score breakdown chart render
    at.text_input(key="ac_search").set_value("").run(timeout=60)
    assert not at.exception
    assert len(at.get("vega_lite_chart")) >= 2
    # select an event that actually carries ML evidence and verify both
    # evidence streams are presented distinctly
    ev_sorted = res.events.sort_values("frame").reset_index(drop=True)
    ml_idx = [i for i, r in ev_sorted.iterrows() if r["ml_score"] > 0]
    boxes = [i for i, s in enumerate(at.selectbox)
             if s.label == "Selected event"]
    if ml_idx and boxes:
        option = (f"f{int(ev_sorted.loc[ml_idx[0], 'frame'])} · "
                  f"track {int(ev_sorted.loc[ml_idx[0], 'track_id'])} · "
                  f"{ev_sorted.loc[ml_idx[0], 'level']} · "
                  f"{ev_sorted.loc[ml_idx[0], 'fused_score']:.2f}")
        at.selectbox[boxes[0]].select(option).run(timeout=60)
        assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "Isolation Forest" in html and "scene-relative" in html
    assert "Evidence streams" in html


def test_anomaly_center_track_filter_from_overview():
    at, res = _analyze()
    tid = int(res.events["track_id"].iloc[0])
    at.session_state["anomaly_track_filter"] = [tid]
    at.switch_page("pages/anomaly_center.py").run(timeout=90)
    assert not at.exception
    df = at.dataframe[0].value  # filtered event table
    if not df.empty:
        assert set(df["track_id"]) == {tid}


# ---------------------------------------------------------------- tracks
def test_track_explorer_renders_trajectory_and_speed_charts():
    at, res = _analyze()
    at.switch_page("pages/tracks.py").run(timeout=90)
    assert not at.exception
    assert len(at.get("vega_lite_chart")) >= 2     # trajectory + speed series
    html = " ".join(m.value for m in at.markdown)
    assert "Duration" in html and "Mean speed" in html


def test_track_search_filters_options():
    at, res = _analyze()
    at.switch_page("pages/tracks.py").run(timeout=90)
    at.text_input(key="track_query").set_value("nonexistent-colour").run(timeout=60)
    assert not at.exception
    assert any("No tracks match that search" in w.value for w in at.warning)


# --------------------------------------------------- phase 3: track explorer
def test_track_table_filtering_and_selected_track():
    """The track table is built from the session's real tracks; severity and
    search filters narrow it; selecting a track drives the investigation."""
    at, res = _analyze()
    at.switch_page("pages/tracks.py").run(timeout=90)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "Track table" in html and "Track #" in html

    df = at.dataframe[0].value
    assert len(df) == len(res.tracks)
    assert set(df["track"].astype(int)) == set(res.tracks["track_id"].astype(int))

    # severity filter narrows the table and the picker
    flagged = res.tracks[res.tracks["n_events"] > 0]
    if 0 < len(flagged) < len(res.tracks):
        at.radio(key="track_filter").set_value("Flagged only").run(timeout=60)
        assert not at.exception
        df = at.dataframe[0].value
        assert len(df) == len(flagged)
        assert set(df["track"].astype(int)) == set(flagged["track_id"].astype(int))
        at.radio(key="track_filter").set_value("All").run(timeout=60)
    elif len(flagged) == len(res.tracks):
        at.radio(key="track_filter").set_value("Flagged only").run(timeout=60)
        assert not at.exception
        assert len(at.dataframe[0].value) == len(flagged)
        at.radio(key="track_filter").set_value("All").run(timeout=60)

    # search: a colour token taken from the real data matches exactly those
    color = str(res.tracks["color"].iloc[0])
    matching = res.tracks[res.tracks.apply(
        lambda r: color in f"{int(r['track_id'])} {r['color']} {r['shape']} "
                           f"{r['worst_level']}", axis=1)]
    at.text_input(key="track_query").set_value(color).run(timeout=60)
    assert not at.exception
    assert len(at.dataframe[0].value) == len(matching)
    at.text_input(key="track_query").set_value("").run(timeout=60)
    assert not at.exception

    # investigation panel reflects the freshly selected track
    other = int(res.tracks["track_id"].iloc[-1])
    at.session_state["track_select"] = other
    at.switch_page("pages/tracks.py").run(timeout=90)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert f"Track #{other} investigation" in html
    assert at.session_state["track_select"] == other


def test_track_event_selection_navigates_to_the_frame():
    """Selecting one of the track's flagged observations and pressing the
    inspect button carries the event's frame to Video Studio."""
    at, res = _analyze()
    at.switch_page("pages/tracks.py").run(timeout=90)
    tid = int(at.session_state["track_select"])

    def _track():
        at.switch_page("pages/tracks.py").run(timeout=90)

    _track()
    ev = res.obs[(res.obs["track_id"] == tid)
                 & (res.obs["level"] != "Normal")].sort_values("frame")
    if not ev.empty:
        boxes = [i for i, s in enumerate(at.selectbox)
                 if s.label == "Event on this track"]
        assert boxes
        opts = at.selectbox[boxes[0]].options
        opt = opts[len(opts) // 2]      # a mid-list event, not just the default
        at.selectbox[boxes[0]].select(opt).run(timeout=60)
        assert not at.exception
        frame = int(opt.split(" ·", 1)[0][1:])
        btn = [i for i, b in enumerate(at.button)
               if b.label.startswith("Inspect frame")][0]
        at.button[btn].click().run(timeout=90)
        assert not at.exception, "event navigation must not raise"
        nearest = min(range(len(res.previews)),
                      key=lambda i: abs(res.previews[i].frame_idx - frame))
        landed = (at.session_state["studio_index"]
                  if at.session_state.get("pending_frame") is None
                  else at.session_state["pending_frame"])
        if at.session_state.get("pending_frame") is not None:
            assert landed == frame          # still carried, not yet consumed
        else:
            assert landed == nearest        # consumed: viewer landed on it


# ---------------------------------------------------------------- scene
def test_scene_page_shows_baseline_and_zone_editor_works():
    at, res = _analyze()
    at.switch_page("pages/scene.py").run(timeout=90)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "How this baseline was learned" in html
    # zone editor: add + apply writes config, success message shown
    add = [i for i, b in enumerate(at.button) if b.label == "+ Add zone"][0]
    at.button[add].click().run(timeout=60)
    assert not at.exception
    apply_i = [i for i, b in enumerate(at.button)
               if b.label == "Apply to next run"][0]
    at.button[apply_i].click().run(timeout=60)
    assert not at.exception
    assert any("dwell threshold" in s.value for s in at.success)
    # restore global config mutated by the test
    SETTINGS.zone.enabled = False
    SETTINGS.zone.zones = []
    SETTINGS.zone.dwell_seconds = 3.0


# ------------------------------------------------------------ evaluation
def test_evaluation_metrics_and_honest_single_class_path():
    at, res = _analyze()
    at.switch_page("pages/evaluation.py").run(timeout=90)
    assert not at.exception
    html = " ".join(m.value for m in at.markdown)
    assert "Not evaluated yet" in html
    gt_boxes = [i for i, s in enumerate(at.selectbox)
                if s.label.startswith("Track ")]
    assert len(gt_boxes) == len(res.tracks)
    # both classes -> computable metrics
    at.selectbox[gt_boxes[0]].select("Normal").run(timeout=60)
    at.selectbox[gt_boxes[1]].select("Anomaly").run(timeout=60)
    ev = [i for i, b in enumerate(at.button) if b.label == "Evaluate now"][0]
    at.button[ev].click().run(timeout=60)
    assert not at.exception
    outcome = at.session_state["eval_outcome"]
    assert outcome.computable and outcome.metrics is not None
    m = outcome.metrics
    assert 0.0 <= m.precision <= 1.0 and 0.0 <= m.recall <= 1.0
    assert m.tp + m.fp + m.fn + m.tn == outcome.n_labeled
    html = " ".join(m.value for m in at.markdown)
    assert "Precision" in html and "Confusion" in html
    # single class -> explicit not-computable state, never fake numbers
    for gb in gt_boxes:
        at.selectbox[gb].select("Normal").run(timeout=60)
    ev = [i for i, b in enumerate(at.button) if b.label == "Evaluate now"][0]
    at.button[ev].click().run(timeout=60)
    outcome = at.session_state["eval_outcome"]
    assert outcome.metrics is None and outcome.reason
    html = " ".join(m.value for m in at.markdown)
    assert "Metrics not computable" in html


def test_evaluation_session_persistence_and_history(tmp_path, monkeypatch):
    monkeypatch.setattr(SETTINGS, "paths",
                        AppPaths(samples=SETTINGS.paths.samples,
                                 output=SETTINGS.paths.output,
                                 db=tmp_path / "hist.db"))
    at, res = _analyze()
    at.switch_page("pages/evaluation.py").run(timeout=90)
    save = [i for i, b in enumerate(at.button)
            if b.label == "Save this session to the database"][0]
    at.button[save].click().run(timeout=60)
    assert not at.exception
    assert any("Persisted" in s.value for s in at.success)
    # stored session now listed, separate from the live session
    assert any(s.label == "Stored session" for s in at.selectbox)
    # saving again replaces (idempotent) instead of duplicating
    save = [i for i, b in enumerate(at.button)
            if b.label == "Save this session to the database"][0]
    at.button[save].click().run(timeout=60)
    con = sqlite3.connect(tmp_path / "hist.db")
    n = con.execute("SELECT COUNT(*) FROM track_events").fetchone()[0]
    n_runs = con.execute("SELECT COUNT(*) FROM run_stats").fetchone()[0]
    con.close()
    assert n == len(res.obs) and n_runs == 1


# ------------------------------------------------------- session engine unit
def test_run_analysis_frames_and_evidence(tmp_path):
    calls: list[tuple[int, int]] = []
    res = session.run_analysis(
        str(ROOT / "samples" / "tiny_noise.mp4"), "sample: tiny_noise.mp4",
        "sample", None, "unit1", progress=lambda d, t: calls.append((d, t)))
    assert res.error is None
    assert res.frames_processed == 40
    assert res.is_synthetic is True
    assert list(res.obs.columns) == session.OBS_COLS
    assert list(res.tracks.columns) == session.TRACK_COLS
    assert calls and calls[-1][0] == 40        # progress finished at frame 40
    # noise clip: no detections at all -> empty tables, still valid
    assert res.obs.empty and res.tracks.empty
    assert res.level_counts == {"Normal": 0, "Suspicious": 0, "Irregular": 0}


def test_run_analysis_error_is_friendly(tmp_path):
    bad = tmp_path / "x.mp4"
    bad.write_bytes(b"garbage")
    res = session.run_analysis(str(bad), "upload: x.mp4", "upload", 10,
                               "unit2")
    assert res.error and "Could not open" in res.error
    assert res.frames_processed == 0
    assert res.obs.empty


def test_upload_path_sanitizes_and_cleanup(tmp_path):
    p = session.upload_path(tmp_path, "../../etc/passwd")
    assert p.parent == tmp_path and p.name.startswith("upload_")
    assert session.upload_path(tmp_path, "my video (1).mp4").name == \
        "upload_myvideo1.mp4"
    old = tmp_path / "upload_old.mp4"
    new = tmp_path / "upload_new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"y")
    os.utime(old, (1, 1))
    assert session.cleanup_stale_uploads(tmp_path) == 1
    assert not old.exists() and new.exists()


def test_is_synthetic_source_flags_bundled_samples_only():
    assert session.is_synthetic_source(ROOT / "samples" / "normal_traffic.mp4")
    assert not session.is_synthetic_source(Path("/tmp/other.mp4"))


def test_session_history_roundtrip(tmp_path):
    res = session.run_analysis(str(ROOT / "samples" / "tiny_noise.mp4"),
                               "sample: tiny_noise.mp4", "sample", None,
                               "hist1")
    res.obs = pd.DataFrame([{
        "frame": 1, "ts_s": 0.1, "track_id": 3, "color": "red",
        "shape": "circle", "level": "Irregular", "fused_score": 0.9,
        "rule_score": 1.0, "ml_score": 0.5, "scene_score": 0.2,
        "speed_px_s": 100.0, "direction_deg": 90.0, "cx": 10.0, "cy": 20.0,
        "zone": None, "zone_dwell_s": 0.0, "rules_json": "[]",
        "ml_note": "", "scene_note": "", "why": "test row"}],
        columns=session.OBS_COLS)
    db = tmp_path / "h.db"
    monkey_paths = AppPaths(samples=SETTINGS.paths.samples,
                            output=SETTINGS.paths.output, db=db)
    old = SETTINGS.paths
    SETTINGS.paths = monkey_paths
    try:
        counts = session.save_session_to_db(res)
        assert counts["events"] == 1
        hist = session.load_history(db)
        assert len(hist) == 1 and hist[0]["session"] == "hist1"
        ev, summ, run = session.load_session_data(db, "hist1")
        assert len(ev) == 1 and ev.iloc[0]["level"] == "Irregular"
        assert run["frames"] == res.frames_processed
        removed = session.delete_session(db, "hist1")
        assert removed["events"] == 1
        assert session.load_history(db) == []
    finally:
        SETTINGS.paths = old


# ------------------------------------------------------------------ CLI
def test_cli_invalid_source_exits_2_with_friendly_message(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"junk")
    proc = subprocess.run(
        [sys.executable, "-m", "scripts.run_pipeline", str(bad)],
        capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert proc.returncode == 2
    assert "error: cannot read source" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_missing_source_exits_2_with_friendly_message():
    proc = subprocess.run(
        [sys.executable, "-m", "scripts.run_pipeline", "does_not_exist.mp4"],
        capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr


def test_cli_rerun_replaces_rows_instead_of_duplicating(tmp_path):
    """Regression: a second CLI run on the same source used to append a full
    second copy of every observation (and never wrote run stats)."""
    import importlib
    gen = importlib.import_module("scripts.generate_samples")
    src = tmp_path / "cli_idem.mp4"
    gen._write(src, gen.normal_traffic(seconds=2.0, fps=15.0), 15.0)
    session = src.name

    def _run():
        return subprocess.run(
            [sys.executable, "-m", "scripts.run_pipeline", str(src)],
            capture_output=True, text=True, cwd=ROOT, timeout=300)

    def _cleanup():
        log = ResultLogger(SETTINGS.paths.db, session=session)
        try:
            log.clear_session_events(session)
            log.clear_session_summaries(session)
            log.close_session(session)
        finally:
            log.close()

    _cleanup()                      # idempotent pre-condition
    try:
        first, second = _run(), _run()
        assert first.returncode == 0, first.stderr[-500:]
        assert second.returncode == 0, second.stderr[-500:]
        con = sqlite3.connect(SETTINGS.paths.db)
        try:
            rows = con.execute(
                "SELECT COUNT(*) FROM track_events WHERE session=?",
                (session,)).fetchone()[0]
            dups = con.execute(
                "SELECT COUNT(*) FROM (SELECT frame_idx, track_id FROM"
                " track_events WHERE session=? GROUP BY frame_idx, track_id"
                " HAVING COUNT(*) > 1)", (session,)).fetchone()[0]
            runs = con.execute(
                "SELECT COUNT(*) FROM run_stats WHERE session=?",
                (session,)).fetchone()[0]
            frames = con.execute(
                "SELECT frames FROM run_stats WHERE session=?",
                (session,)).fetchone()[0]
        finally:
            con.close()
        assert rows > 0             # the clip really produced observations
        assert dups == 0            # second run replaced, not appended
        assert runs == 1            # run stats recorded (one row per session)
        assert frames == 30         # 2.0 s @ 15 fps actually processed
    finally:
        _cleanup()                  # leave the shared DB as we found it


# ------------------------------------------------------------------ logger
def test_logger_clear_session_events_makes_rewrites_idempotent(tmp_path):
    log = ResultLogger(tmp_path / "t.db", session="sA")
    entry = {"track_id": 1, "level": "Normal", "fused_score": 0.1,
             "rule_score": 0.0, "ml_score": 0.0, "scene_score": 0.0,
             "speed_px_s": 10.0, "direction_deg": 90.0, "why": "ok"}
    log.log_event(1, entry)
    log.log_event(2, entry)
    assert log.clear_session_events("sA") == 2
    assert log.counts_by_level() == {}
    assert log.clear_session_events("sA") == 0
    log.close()


def test_logger_sessions_are_isolated(tmp_path):
    a = ResultLogger(tmp_path / "t.db", session="sA")
    entry = {"track_id": 1, "level": "Irregular", "fused_score": 0.8,
             "rule_score": 1.0, "ml_score": 0.0, "scene_score": 0.0,
             "speed_px_s": 500.0, "direction_deg": 10.0, "why": "x"}
    a.log_event(1, entry)
    a.close()
    b = ResultLogger(tmp_path / "t.db", session="sB")
    b.log_event(1, entry)
    sessions = b.list_sessions()
    cols, rows = b.session_events("sA")
    b.close()
    assert {s["session"] for s in sessions} == {"sA", "sB"}
    assert len(rows) == 1 and rows[0][4] == "Irregular"
    assert b is not None


def test_logger_summaries_keyed_by_session_not_overwritten(tmp_path):
    stub = type("S", (), dict(track_id=7, n_points=10, n_seconds=1.0,
                               mean_speed_px_s=1.0, max_speed_px_s=2.0,
                               path_length_px=5.0, straightness=0.9,
                               direction_hist={"E": 9}))()
    a = ResultLogger(tmp_path / "t.db", session="sA")
    a.log_track_summary(stub, "green", "circle", 0, 9)
    a.close()
    b = ResultLogger(tmp_path / "t.db", session="sB")
    b.log_track_summary(stub, "blue", "square", 0, 9)
    rows = sorted(b._conn.execute(
        "SELECT session, color FROM track_summaries").fetchall())
    b.close()
    assert rows == [("sA", "green"), ("sB", "blue")]


def test_logger_migrates_legacy_track_summaries_schema(tmp_path):
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE track_summaries (
            track_id INTEGER PRIMARY KEY, session TEXT, color TEXT, shape TEXT,
            n_points INTEGER, n_seconds REAL, mean_speed_px_s REAL,
            max_speed_px_s REAL, path_length_px REAL, straightness REAL,
            directions TEXT, first_frame INTEGER, last_frame INTEGER);
        INSERT INTO track_summaries VALUES
            (1,'old','green','circle',10,1.0,1.0,2.0,5.0,0.9,'E',0,9);
    """)
    conn.commit()
    conn.close()
    log = ResultLogger(db, session="new")
    info = log._conn.execute("PRAGMA table_info(track_summaries)").fetchall()
    pk = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5] > 0]
    rows = log._conn.execute(
        "SELECT track_id, session FROM track_summaries").fetchall()
    log.close()
    assert pk == ["session", "track_id"]
    assert rows == [(1, "old")]
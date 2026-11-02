"""Phase 8 tests: analytical additions - evaluation metrics, ground truth
persistence, zone rules, pipeline evidence and the session report. These
cover the new scientific surface area end to end without the UI.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.config import SETTINGS, load_config          # noqa: E402
from src.analysis import ground_truth, metrics           # noqa: E402
from src.analysis.logger import ResultLogger             # noqa: E402
from src.pipeline import TrackingPipeline                # noqa: E402
from src.ui.report import build_session_report           # noqa: E402
from src.ui.session import run_analysis                  # noqa: E402
from src.video.video_input import VideoSource            # noqa: E402

SAMPLE = ROOT / "samples" / "anomaly_clip.mp4"


# ---------------------------------------------------------------- metrics
def test_classification_metrics_known_values():
    y_true = ["Anomaly", "Anomaly", "Normal", "Normal", "Normal"]
    y_pred = ["Irregular", "Normal", "Suspicious", "Normal", "Normal"]
    m = metrics.classification_metrics(y_true, y_pred)
    assert m is not None
    assert (m.tp, m.fp, m.fn, m.tn) == (1, 1, 1, 2)
    assert m.precision == pytest.approx(0.5)
    assert m.recall == pytest.approx(0.5)
    assert m.f1 == pytest.approx(0.5)
    assert m.fpr == pytest.approx(1 / 3)


def test_classification_metrics_rejects_single_class_and_empty():
    assert metrics.classification_metrics([], []) is None
    assert metrics.classification_metrics(["Anomaly"], ["Irregular"]) is None
    assert metrics.classification_metrics(["Normal", "Normal"],
                                          ["Normal", "Normal"]) is None
    assert metrics.classification_metrics(["Anomaly", "Normal"],
                                          ["Irregular"]) is None   # length mismatch


def test_evaluate_requires_labels_and_both_classes():
    obs = [{"frame": 1, "track_id": 0, "level": "Irregular"},
           {"frame": 2, "track_id": 1, "level": "Normal"}]
    out = metrics.evaluate(obs, [])
    assert out.metrics is None and "No ground-truth labels" in out.reason
    out = metrics.evaluate(obs, [{"frame_idx": 1, "track_id": 0,
                                  "label": "Anomaly"}])
    assert out.metrics is None and "one class" in out.reason
    assert out.n_labeled == 1
    out = metrics.evaluate(obs, [
        {"frame_idx": 1, "track_id": 0, "label": "Anomaly"},
        {"frame_idx": 2, "track_id": 1, "label": "Normal"}])
    assert out.metrics is not None
    assert out.metrics.tp == 1 and out.metrics.tn == 1
    assert out.extras["unlabeled_observations"] == 0


def test_evaluate_counts_unlabelled_observations():
    obs = [{"frame": 1, "track_id": 0, "level": "Irregular"},
           {"frame": 2, "track_id": 9, "level": "Normal"}]
    out = metrics.evaluate(obs, [
        {"frame_idx": 1, "track_id": 0, "label": "Anomaly"},
        {"frame_idx": 2, "track_id": 9, "label": "Normal"}])
    assert out.computable
    assert out.extras["unlabeled_observations"] == 0
    # labels that match no observation rows are reported honestly
    out = metrics.evaluate(obs, [{"frame_idx": 77, "track_id": 5,
                                  "label": "Anomaly"}])
    assert out.metrics is None and "none match" in out.reason


# ------------------------------------------------------------ ground truth
def test_ground_truth_roundtrip_and_validation(tmp_path):
    db = tmp_path / "gt.db"
    rows = [{"frame_idx": 5, "track_id": 1, "label": "Anomaly"},
            {"frame_idx": 6, "track_id": 1, "label": "Anomaly"},
            {"frame_idx": 6, "track_id": 2, "label": "Normal"}]
    n = ground_truth.save_labels(db, "s1", rows)
    assert n == 3
    loaded = ground_truth.load_labels(db, "s1")
    assert len(loaded) == 3
    assert ground_truth.load_labels(db, "other-session") == []
    with pytest.raises(ValueError):
        ground_truth.save_labels(db, "s1",
                                 [{"frame_idx": 1, "track_id": 1,
                                   "label": "maybe"}])
    # upsert, not duplicate
    ground_truth.save_labels(db, "s1", rows)
    assert len(ground_truth.load_labels(db, "s1")) == 3
    assert ground_truth.clear_labels(db, "s1") == 3
    assert ground_truth.load_labels(db, "s1") == []


# ------------------------------------------------------------- zone rules
def test_zone_rule_fires_only_when_enabled_and_past_threshold():
    cfg = load_config()
    try:
        cfg.zone.enabled = True
        cfg.zone.dwell_seconds = 2.0
        from src.anomaly.rules import RuleEngine
        engine = RuleEngine()
        assert engine.rule_zone_violation(("gate-A", 1.9)) == []
        sig = engine.rule_zone_violation(("gate-A", 2.5))
        assert len(sig) == 1 and sig[0].rule == "zone_violation"
        assert "gate-A" in sig[0].description and "2.5" in sig[0].description
        cfg.zone.enabled = False
        assert engine.rule_zone_violation(("gate-A", 99.0)) == []
    finally:
        cfg.zone.enabled = False
        cfg.zone.zones = []
        cfg.zone.dwell_seconds = 3.0


def test_pipeline_zones_produce_evidence_and_overlay():
    cfg = load_config()
    try:
        cfg.zone.enabled = True
        cfg.zone.dwell_seconds = 0.5
        cfg.zone.zones = [{"name": "right-half", "x1": 0.5, "y1": 0.0,
                           "x2": 1.0, "y2": 1.0}]
        seen_zone = None
        seen_rules: set = set()
        with VideoSource(str(SAMPLE)) as vs:
            pipe = TrackingPipeline(session="zone-test")
            for vf in vs:
                res = pipe.process_frame(vf.bgr, vf.index, vf.fps)
                for e in res.entries:
                    if e["in_zone"]:
                        seen_zone = e["in_zone"]
                        assert e["zone_dwell_s"] > 0
                    for r in e["rules"]:
                        seen_rules.add(r["rule"])
                if vf.index > 250:
                    break
        assert seen_zone == "right-half"
        assert "zone_violation" in seen_rules
    finally:
        cfg.zone.enabled = False
        cfg.zone.zones = []
        cfg.zone.dwell_seconds = 3.0


def test_pipeline_entries_carry_structured_evidence():
    with VideoSource(str(SAMPLE)) as vs:
        pipe = TrackingPipeline(session="evidence-test")
        res = None
        for vf in vs:
            if vf.index > 40:
                break
            res = pipe.process_frame(vf.bgr, vf.index, vf.fps)
    assert res.entries, "expected tracked objects"
    e = res.entries[0]
    for key in ("rules", "ml_note", "scene_note", "in_zone", "zone_dwell_s"):
        assert key in e
    assert isinstance(e["rules"], list)
    for r in e["rules"]:
        assert {"rule", "severity", "description"} <= set(r)
        assert 0.0 <= r["severity"] <= 1.0
    assert isinstance(e["ml_note"], str) and e["ml_note"]


# ------------------------------------------------------------------ report
@pytest.fixture(scope="module")
def small_session():
    return run_analysis(str(ROOT / "samples" / "tiny_noise.mp4"),
                        "sample: tiny_noise.mp4", "sample", 40, "report-fixture")


def test_report_contains_measured_values_and_disclosures(small_session):
    report = build_session_report(small_session, None)
    assert report.startswith("# Session Analysis Report")
    # real measured values
    assert "40" in report                       # frames processed
    assert "SYNTHETIC SAMPLE FOOTAGE" in report  # honest disclosure
    assert "tiny_noise.mp4" in report
    assert "No Suspicious/Irregular observations" in report
    # no metrics claimed without evaluation
    assert "no ground-truth labels provided" in report
    assert "Limitations" in report


def test_report_includes_metrics_only_when_provided(small_session):
    obs = [{"frame": 1, "track_id": 0, "level": "Normal"},
           {"frame": 2, "track_id": 1, "level": "Irregular"}]
    labels = [{"frame_idx": 1, "track_id": 0, "label": "Normal"},
              {"frame_idx": 2, "track_id": 1, "label": "Anomaly"}]
    outcome = metrics.evaluate(obs, labels)
    report = build_session_report(small_session, outcome)
    assert "| Precision |" in report
    assert "| F1 |" in report
    # and refuses when not computable
    outcome2 = metrics.evaluate(obs, [])
    report2 = build_session_report(small_session, outcome2)
    assert "Metrics not computed" in report2
    assert "| Precision |" not in report2
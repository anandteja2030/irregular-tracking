"""Session report generator - a professional markdown summary built strictly
from measured session data, the active configuration and (optionally) a real
evaluation outcome. Limitations are always disclosed; metrics are never
invented - if evaluation is not possible the report says so explicitly.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone

from config.config import load_config
from src.analysis.metrics import EvaluationOutcome
from src.ui.session import SessionResult

_LIMITATIONS = [
    "Bounding boxes and identities come from HSV colour + contour detection "
    "with Kalman/Hungarian association; two objects that overlap persistently "
    "can swap IDs (no appearance re-identification model is used).",
    "Speeds and distances are in image pixels per second (no camera "
    "calibration / homography to metric units).",
    "The Isolation Forest learns from the running session; early frames are "
    "scored with little history and are marked as 'collecting observations'.",
    "Restricted-zone dwell uses frame timestamps of the source video; zone "
    "coordinates are relative to the frame and scale with resolution.",
    "Precision/recall/F1 are reported only for observations that carry "
    "user-provided ground-truth labels covering both classes.",
    "Bundled sample videos are synthetic and disclosed as such; they are for "
    "regression testing, not evidence of real-world accuracy.",
]


def build_session_report(result: SessionResult,
                         outcome: EvaluationOutcome | None = None) -> str:
    cfg = load_config()
    counts = result.level_counts
    events = result.events
    lines: list[str] = []
    add = lines.append

    add("# Session Analysis Report")
    add("")
    add(f"- **Generated:** {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    add(f"- **Session:** `{result.session}`")
    add(f"- **Source:** {result.source_label} (`{result.source_kind}`)"
        + (" - **SYNTHETIC SAMPLE FOOTAGE**" if result.is_synthetic else ""))
    add(f"- **Analysis window:** {result.started_ts} -> {result.ended_ts}"
        f" ({result.wall_s:.1f} s wall)")
    add("")

    add("## 1. Input & processing statistics")
    add("")
    add("| Metric | Value |")
    add("| --- | --- |")
    add(f"| Source resolution | {result.frame_width} x {result.frame_height} px |")
    add(f"| Source fps | {result.fps:.2f} |")
    add(f"| Frames available | {result.frames_available} |")
    add(f"| Frames processed | {result.frames_processed} |")
    add(f"| Frame budget | {result.max_frames or 'unlimited'} |")
    add(f"| Wall time | {result.wall_s:.2f} s |")
    add(f"| Processing rate | {result.proc_fps:.1f} frames/s |")
    add(f"| Preview frames stored | {len(result.previews)} "
        f"(every {result.previews[1].frame_idx - result.previews[0].frame_idx if len(result.previews) > 1 else '-'} frames) |")
    add("")

    add("## 2. Detection & tracking")
    add("")
    add(f"- Distinct tracks: **{len(result.tracks)}**")
    add(f"- Per-object observations: **{len(result.obs)}**")
    if not result.obs.empty:
        moving = (result.obs["speed_px_s"] > 0).mean()
        add(f"- Observations with motion (speed > 0): **{moving:.1%}**")
    add("")
    add("| Level | Observations | Share |")
    add("| --- | --- | --- |")
    total = max(sum(counts.values()), 1)
    for lvl in ("Normal", "Suspicious", "Irregular"):
        add(f"| {lvl} | {counts[lvl]} | {counts[lvl] / total:.1%} |")
    add("")

    add("## 3. Anomaly events")
    add("")
    if events.empty:
        add("No Suspicious/Irregular observations were detected in this run.")
    else:
        rule_counter: Counter = Counter()
        for raw in events["rules_json"]:
            for r in json.loads(raw or "[]"):
                rule_counter[r["rule"]] += 1
        add(f"- Events (non-Normal observations): **{len(events)}** "
            f"across **{events['track_id'].nunique()}** tracks")
        add(f"- Fused score range: **{events['fused_score'].min():.2f} - "
            f"{events['fused_score'].max():.2f}**")
        add("- Triggered rules: "
            + (", ".join(f"`{k}` ({v})" for k, v in rule_counter.most_common())
               or "none - ML/scene score only"))
        worst = events.sort_values("fused_score", ascending=False).iloc[0]
        add(f"- Highest-severity observation: frame **{int(worst['frame'])}**, "
            f"track **{int(worst['track_id'])}**, level **{worst['level']}**, "
            f"fused **{worst['fused_score']:.2f}**")
        add(f"- Explanation: _{worst['why']}_")
    add("")

    add("## 4. Scene calibration")
    add("")
    scene = result.scene
    if scene is None:
        add("Scene statistics unavailable for this run.")
    else:
        add(f"- Calibration status: **{'ready' if scene.ready else 'warming up'}**")
        add(f"- Movement samples: **{scene.n_samples}** from "
            f"**{scene.n_tracks}** tracks over **{scene.observed_seconds:.1f} s**")
        add(f"- Speed baseline (px/s): p10 **{scene.speed_p10:.0f}**, median "
            f"**{scene.speed_p50:.0f}**, p90 **{scene.speed_p90:.0f}**, "
            f"mean **{scene.speed_mean:.0f} +/- {scene.speed_std:.0f}**")
        add(f"- Dominant flow directions: "
            f"**{', '.join(scene.dominant_directions) or 'n/a'}**")
        add(f"- Moving fraction: **{scene.moving_fraction:.1%}**")
    add("")

    add("## 5. Configuration snapshot")
    add("")
    w = cfg.anomaly.weights
    add("| Setting | Value |")
    add("| --- | --- |")
    add(f"| Fusion weights (rule / ML / scene) | {w['rule']} / {w['ml']} / {w['scene']} |")
    add(f"| Suspicious threshold | {cfg.anomaly.threshold_suspicious} |")
    add(f"| Irregular threshold | {cfg.anomaly.threshold_irregular} |")
    add(f"| Isolation Forest contamination | {cfg.anomaly.contamination} |")
    add(f"| Position gate / max age / min hits | {cfg.tracking.position_gate_px} px"
        f" / {cfg.tracking.max_age} / {cfg.tracking.min_hits} |")
    add(f"| Calibration warm-up | {cfg.calibration.warmup_tracks} tracks, "
        f"{cfg.calibration.tracks_seconds}s, {cfg.calibration.min_samples} samples |")
    add(f"| Zones enabled | {cfg.zone.enabled} "
        f"({len(cfg.zone.zones)} configured, dwell "
        f"{cfg.zone.dwell_seconds}s) |")
    add(f"| HSV colour ranges | {', '.join(cfg.color.ranges)} |")
    add("")

    add("## 6. Evaluation")
    add("")
    if outcome is None:
        add("_Not evaluated in this run (no ground-truth labels provided)._")
    elif outcome.metrics is None:
        add(f"_Metrics not computed: {outcome.reason}_")
    else:
        m = outcome.metrics
        add("| Metric | Value |")
        add("| --- | --- |")
        add(f"| Labeled observations | {outcome.n_labeled} |")
        add(f"| Precision | {m.precision:.3f} |")
        add(f"| Recall | {m.recall:.3f} |")
        add(f"| F1 | {m.f1:.3f} |")
        add(f"| False-positive rate | {m.fpr:.3f} |")
        add(f"| Accuracy | {m.accuracy:.3f} |")
        add(f"| Confusion (TP/FP/FN/TN) | {m.tp}/{m.fp}/{m.fn}/{m.tn} |")
        add("")
        if outcome.extras.get("unlabeled_observations"):
            add(f"_Note: {outcome.extras['unlabeled_observations']} observations "
                "were not labelled and are excluded from these metrics._")
    add("")

    add("## 7. Limitations")
    add("")
    for item in _LIMITATIONS:
        add(f"- {item}")
    add("")
    add("---")
    add("_Generated by Intelligent Irregular Object Tracking & Scene-Aware "
        "Anomaly Detection. All figures derive from this session's measured "
        "pipeline output._")
    return "\n".join(lines)

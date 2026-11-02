"""Markdown report built from persisted results for one session.

Rendered entirely from `analytics.report_payload`, so every figure is either a
row in SQLite, a measured run statistic, or an explicitly labelled in-process
artifact. Sections that cannot be produced are stated as unavailable - never
filled with zeros or sample values.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

_STANDARD_LIMITATIONS = [
    "Bounding boxes and identities come from HSV colour + contour detection "
    "with Kalman/Hungarian association; two objects that overlap persistently "
    "can swap IDs (no appearance re-identification model is used).",
    "Speeds and distances are in image pixels per second (no camera "
    "calibration / homography to metric units).",
    "The Isolation Forest learns from the running session; early frames are "
    "scored with little history.",
    "Precision/recall/F1 are shown only for observations that carry "
    "ground-truth labels covering both classes.",
    "Bundled sample videos are synthetic and are disclosed as such; they are "
    "regression fixtures, not evidence of real-world accuracy.",
]


def _fmt(value, digits: int = 2, suffix: str = "") -> str:
    if value is None:
        return "not recorded"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:.{digits}f}{suffix}"
    return f"{value}{suffix}"


def _table(rows: list[tuple[str, str]]) -> list[str]:
    lines = ["| Metric | Value |", "| --- | --- |"]
    lines.extend(f"| {key} | {value} |" for key, value in rows)
    lines.append("")
    return lines


def build_report(payload: dict) -> str:
    detail = payload["detail"]
    summary = payload["summary"]
    scene = payload["scene"]
    evaluation = payload["evaluation"]
    media = payload["media"]
    tracks = payload["tracks"]
    anomalies = payload["anomalies"]

    source = detail["source"]
    processing = detail["processing"]
    counts = detail["counts"]
    levels = counts["levels"]
    stats = summary["anomalies"]

    lines: list[str] = []
    add = lines.append

    add("# NEURAL COMMAND — Session Report")
    add("")
    add(f"- **Session:** `{detail['session']}`")
    add(f"- **Source:** {source['label'] or 'not recorded'} "
        f"(`{source['kind'] or 'unknown'}`)"
        + (" — **SYNTHETIC SAMPLE FOOTAGE**" if source["synthetic"] else ""))
    add(f"- **Analysed:** {_fmt(processing['started_ts'])} -> "
        f"{_fmt(processing['ended_ts'])} "
        f"({_fmt(processing['wall_s'], 2, ' s')} wall time)")
    add(f"- **Report generated:** "
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    add("")

    add("## 1. Input & processing statistics")
    add("")
    lines.extend(_table([
        ("Source resolution",
         (f"{processing['width']} x {processing['height']} px"
          if processing["width"] and processing["height"] else "not recorded")),
        ("Source fps", _fmt(processing["fps"], 2)),
        ("Frames processed", _fmt(processing["frames_processed"])),
        ("Frame budget", _fmt(processing["max_frames"])),
        ("Video duration", _fmt(processing["video_duration_s"], 2, " s")),
        ("Processing rate", _fmt(processing["processing_fps"], 1, " frames/s")),
        ("Run statistics stored", _fmt(processing["run_stats_available"])),
    ]))

    add("## 2. Detection & tracking")
    add("")
    add(f"- Distinct tracks: **{counts['tracks']}**")
    add(f"- Per-object observations: **{counts['observations']}**")
    add("")
    shares = summary["level_share"]
    lines.extend(_table([
        (level, f"{levels[level]} observations ({shares[level]:.1%})")
        for level in ("Normal", "Suspicious", "Irregular")
    ]))

    add("## 3. Anomalies")
    add("")
    if not anomalies:
        add("No Suspicious/Irregular observations were recorded for this "
            "session.")
        add("")
    else:
        add(f"- Events (non-Normal observations): **{len(anomalies)}** across "
            f"**{stats['tracks_affected']}** tracks")
        add(f"- Fused score range: **{_fmt(stats['score_min'], 3)} - "
            f"{_fmt(stats['score_max'], 3)}** (mean "
            f"{_fmt(stats['score_mean'], 3)})")
        highest = stats["highest"]
        if highest:
            add(f"- Highest-severity observation: frame **{highest['frame']}**, "
                f"track **{highest['track_id']}**, level **{highest['level']}**, "
                f"fused **{_fmt(highest['fused_score'], 3)}** "
                f"(event `{highest['event_id']}`)")
        rule_counter: Counter = Counter()
        for event in anomalies:
            rules = event.get("evidence", {}).get("rules") or []
            for rule in rules:
                rule_counter[rule.get("rule", "unknown")] += 1
        if rule_counter:
            add("- Triggered rules: " + ", ".join(
                f"`{name}` ({count})" for name, count in rule_counter.most_common()))
        else:
            add("- Triggered rules: not persisted for this session; the stored "
                "explanation and score streams are reported instead.")
        add("")

    add("## 4. Tracks")
    add("")
    if not tracks:
        add("No tracks were recorded for this session.")
        add("")
    else:
        add("| Track | Colour | Shape | Frames | Observations | Anomalies | "
            "Worst | Mean speed (px/s) | Straightness |")
        add("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        ordered = sorted(tracks, key=lambda t: (-t["observed"]["anomalies"],
                                               t["track_id"]))
        for track in ordered[:15]:
            add(f"| {track['track_id']} | {_fmt(track['appearance']['color'])} "
                f"| {_fmt(track['appearance']['shape'])} "
                f"| {track['frames']['first']}-{track['frames']['last']} "
                f"| {track['observed']['observations']} "
                f"| {track['observed']['anomalies']} "
                f"| {track['observed']['worst_level']} "
                f"| {_fmt(track['motion']['mean_speed_px_s'], 1)} "
                f"| {_fmt(track['motion']['straightness'], 3)} |")
        add("")
        if len(ordered) > 15:
            add(f"_{len(ordered) - 15} further tracks are available through "
                "the tracks endpoint._")
            add("")

    add("## 5. Scene intelligence")
    add("")
    calibration = scene["calibration"]
    if calibration["available"]:
        add(f"- Calibration status: **"
            f"{'ready' if calibration['ready'] else 'warming up'}**")
        add(f"- Calibration samples: **{_fmt(calibration['samples'])}** from "
            f"**{_fmt(calibration['tracks'])}** tracks over "
            f"**{_fmt(calibration['observed_seconds'], 2, ' s')}**")
    else:
        add(f"- Calibration state: **not available** — {calibration['reason']}")
    baseline = scene["speed_baseline"]
    if baseline:
        add(f"- Speed baseline ({baseline['source']}): p10 "
            f"**{_fmt(baseline['p10'], 1)}**, median "
            f"**{_fmt(baseline['p50'], 1)}**, p90 "
            f"**{_fmt(baseline['p90'], 1)}**, mean "
            f"**{_fmt(baseline['mean'], 1)} +/- {_fmt(baseline['std'], 1)}** px/s "
            f"over {baseline['samples']} samples")
    else:
        add("- Speed baseline: no speed observations were recorded.")
    directions = scene["directions"]
    if directions and directions["dominant"]:
        add(f"- Dominant flow directions ({directions['source']}): "
            f"**{', '.join(directions['dominant'])}**")
    deviations = scene["deviations"]
    add(f"- Scene-relative deviations: {deviations['scene_score']['samples']} "
        f"scored observations, {deviations['above_0_2']} at or above 0.20, "
        f"{deviations['above_0_3']} at or above 0.30, affecting "
        f"{deviations['affected_tracks']} tracks (max scene score "
        f"{_fmt(deviations['scene_score']['max'], 3)}).")
    add("")

    add("## 6. Evaluation")
    add("")
    if not evaluation["available"]:
        add(f"_Not available: {evaluation['reason']}_")
        add(f"**This is an absence of labels, not a zero score.** "
            f"{evaluation['labeled_observations']} of "
            f"{evaluation['total_observations']} observations are labelled.")
        add("")
    elif not evaluation["computable"]:
        add(f"_Not computed: {evaluation['reason']}_")
        add(f"Labels: {evaluation['label_counts']} "
            f"({evaluation['labeled_observations']} observations scored).")
        add("")
    else:
        metrics = evaluation["metrics"]
        lines.extend(_table([
            ("Labelled observations", str(evaluation["labeled_observations"])),
            ("Coverage", _fmt(evaluation["coverage"], 1)),
            ("Precision", _fmt(metrics["precision"], 3)),
            ("Recall", _fmt(metrics["recall"], 3)),
            ("F1", _fmt(metrics["f1"], 3)),
            ("False-positive rate", _fmt(metrics["fpr"], 3)),
            ("Accuracy", _fmt(metrics["accuracy"], 3)),
            ("Confusion (TP/FP/FN/TN)",
             f"{metrics['tp']}/{metrics['fp']}/{metrics['fn']}/{metrics['tn']}"),
        ]))
        add(f"_Predicted positives: {evaluation['predicted_positive']} "
            f"({evaluation['positive_rule']})._")
        add("")

    add("## 7. Media & data retention")
    add("")
    add(f"- Preview frames retained in this process: "
        f"**{media['preview_count']}**")
    if media["available"]:
        add(f"- Preview stride: every {media['preview_stride']}th frame")
    add(f"- Annotated video: **unavailable** — {media['annotated_video']['reason']}")
    for note in media["notes"]:
        add(f"- {note}")
    add("")

    add("## 8. Limitations")
    add("")
    for note in detail["limitations"]:
        add(f"- {note}")
    for note in _STANDARD_LIMITATIONS:
        add(f"- {note}")
    add("")
    add("---")
    add("_Generated from this session's persisted pipeline output; no value in "
        "this report is estimated or simulated._")
    return "\n".join(lines)

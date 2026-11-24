"""Human-readable rendering of a Phase 15 evaluation result."""
from __future__ import annotations

from pathlib import Path


def _metric(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def _table(headers: list[str], rows: list[list[object]]) -> list[str]:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    lines.extend("| " + " | ".join(str(cell) for cell in row) + " |"
                 for row in rows)
    return lines


def _overall_rows(overall: dict) -> list[list[object]]:
    detection = overall["detection"]
    tracking = overall["tracking"]
    anomaly = overall["anomaly"]
    return [
        ["Detection precision", _metric(detection["precision"])],
        ["Detection recall", _metric(detection["recall"])],
        ["Detection F1", _metric(detection["f1"])],
        ["Matched-box mean IoU", _metric(detection["mean_matched_iou"])],
        ["Tracking ID switches", tracking["id_switches"]],
        ["Track continuity", _metric(tracking["track_continuity"])],
        ["GT tracks fragmented", tracking["fragmented_tracks"]],
        ["Mostly tracked GT tracks", tracking["mostly_tracked_tracks"]],
        ["Anomaly precision", _metric(anomaly["precision"])],
        ["Anomaly recall", _metric(anomaly["recall"])],
        ["Anomaly F1", _metric(anomaly["f1"])],
        ["Anomaly false-positive rate", _metric(
            anomaly["false_positive_rate"])],
        ["Anomaly accuracy", _metric(anomaly["accuracy"])],
        ["GT observations", overall["counts"]["gt_observations"]],
        ["Predicted observations", overall["counts"]["predicted_observations"]],
        ["Matched observations", overall["counts"]["matched_observations"]],
        ["Unmatched GT observations",
         overall["counts"]["unmatched_gt_observations"]],
        ["Unmatched predictions", overall["counts"]["unmatched_predictions"]],
        ["Unmatched GT anomalies", anomaly["unmatched_gt_anomalies"]],
        ["Unmatched positive predictions",
         anomaly["unmatched_positive_predictions"]],
    ]


def _per_video_rows(videos: list[dict]) -> list[list[object]]:
    rows = []
    for video in videos:
        detection = video["detection"]
        tracking = video["tracking"]
        anomaly = video["anomaly"]
        rows.append([
            video["video_id"],
            video["counts"]["gt_observations"],
            video["counts"]["predicted_observations"],
            _metric(detection["precision"]),
            _metric(detection["recall"]),
            _metric(detection["f1"]),
            tracking["id_switches"],
            _metric(tracking["track_continuity"]),
            _metric(anomaly["precision"]),
            _metric(anomaly["recall"]),
            _metric(anomaly["f1"]),
            _metric(anomaly["false_positive_rate"]),
        ])
    return rows


def _confusion_rows(confusion: dict) -> list[list[object]]:
    normal = confusion["true_normal"]
    anomaly = confusion["true_anomaly"]
    return [
        ["True Normal", normal["predicted_normal"],
         normal["predicted_positive"]],
        ["True Anomaly", anomaly["predicted_normal"],
         anomaly["predicted_positive"]],
    ]


def render_report(result: dict) -> str:
    """Render a Markdown report from an evaluation result."""
    overall = result["overall"]
    matching = result["matching"]
    videos = result["videos"]
    anomaly = overall["anomaly"]
    lines = [
        "# Ground-Truth Evaluation Report",
        "",
        f"Generated: {result['generated_utc']}",
        f"Videos evaluated: {overall['videos']}",
        "",
        "## Matching criteria",
        "",
        f"- IoU threshold: **{matching['iou_threshold']}**",
        f"- Bounding boxes: `{matching['bbox_order']}`",
        f"- Matching: {matching['strategy']}",
        f"- Identity: {matching['identity_rule']}",
        f"- Positive prediction levels: "
        f"{', '.join(matching['positive_levels'])}",
        f"- Anomaly scope: {matching['anomaly_scope']}",
        "",
        "## Overall results",
        "",
    ]
    lines.extend(_table(["Metric", "Value"], _overall_rows(overall)))
    lines.extend([
        "",
        "### Anomaly confusion matrix",
        "",
    ])
    lines.extend(_table(
        ["Ground truth", "Predicted Normal", "Predicted Positive"],
        _confusion_rows(anomaly["confusion_matrix"])))
    lines.extend([
        "",
        "### Per-video results",
        "",
    ])
    lines.extend(_table(
        ["Video", "GT obs", "Pred obs", "Det P", "Det R", "Det F1",
         "ID switches", "Continuity", "Anom P", "Anom R", "Anom F1", "FPR"],
        _per_video_rows(videos)))
    category = anomaly["category"]
    lines.extend([
        "",
        "### Anomaly category results",
        "",
    ])
    if category["evaluated"]:
        lines.append(
            f"Category-labelled anomalous observations: "
            f"{category['evaluated']}; correct: {category['correct']}; "
            f"accuracy: {_metric(category['accuracy'])}.")
        rows = []
        for gt_category, predictions in category["confusion"].items():
            for predicted_category, count in predictions.items():
                rows.append([gt_category, predicted_category, count])
        lines.append("")
        lines.extend(_table(
            ["GT category", "Predicted category", "Count"], rows))
    else:
        lines.append("No matched, positively predicted GT anomalies carried a "
                     "category label.")
    lines.extend([
        "",
        "## Scope and limitations",
        "",
        "- Detection metrics count annotated object-frame boxes only; there "
        "is no background true-negative count.",
        "- Anomaly metrics are end-to-end over all GT object-frame "
        "observations: unmatched GT anomalies count as false negatives and "
        "unmatched positive predictions count as false positives. Detection "
        "metrics remain separately reported.",
        "- IoU matching is axis-aligned, one-to-one and greedy by descending "
        "IoU. Crowded or heavily occluded objects may be assigned differently "
        "than a global assignment would assign them.",
        "- ID switches are counted only across consecutive GT-visible frames "
        "with matches. An occlusion gap breaks the comparison rather than "
        "counting a re-entry as a switch.",
        "- Category accuracy is computed only for matched GT anomalies that "
        "were predicted positive and carry a category; a missing predicted "
        "category is reported as `<missing>`.",
        "- Trajectory points are validated and preserved for provenance, but "
        "tracking metrics use per-frame boxes; no trajectory-similarity metric "
        "is calculated.",
        "- These numbers describe the supplied annotations and predictions "
        "only. The baseline detector was not changed or replaced.",
        "",
    ])
    return "\n".join(lines)


def write_report(result: dict, path: Path | str) -> Path:
    """Write the Markdown report to ``path``."""
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_report(result), encoding="utf-8")
    return output

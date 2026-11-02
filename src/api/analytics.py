"""Analytics payload builders shared by the Phase 3 routes and the report.

The routes stay thin; every number assembled here comes from
`src.api.repository` (SQLite, always authoritative) or from
`src.api.session_store` (in-process artifacts that SQLite cannot hold).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable
from urllib.parse import quote

from config.config import load_config
from src.analysis.ground_truth import load_labels
from src.analysis.metrics import evaluate, predicted_positive
from src.api import repository as repo
from src.api.errors import api_error
from src.api.session_store import SessionArtifacts, store

SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
MAX_SESSION_LEN = 80

RULE_NAMES = ("excessive_speed", "direction_against_flow", "erratic_heading",
              "sudden_acceleration", "zone_violation", "loitering")
EVENT_TYPES = RULE_NAMES + ("ml", "scene")

MEDIA_LIMITATION = (
    "The pipeline does not write frames or an annotated video to disk. Preview "
    "frames (JPEG, every {stride}th frame, max 240 per session) are retained in "
    "memory only for sessions analysed by this API process, so they disappear "
    "on restart and are not available for CLI/Streamlit historical sessions.")
TRAJECTORY_LIMITATION = (
    "Centroid positions are not persisted in SQLite (the schema stores one row "
    "per observation with scores, speed and direction, plus per-track "
    "aggregates). A full trajectory is therefore only available for sessions "
    "analysed by this API process.")
EVIDENCE_LIMITATION = (
    "Structured rule evidence (per-rule severity and description) is not "
    "persisted; the database keeps the fused/rule/ML/scene scores and the "
    "generated explanation. Rule-level evidence is available only for sessions "
    "analysed by this API process.")
CALIBRATION_LIMITATION = (
    "The learned calibration baseline (sample count, ready flag, speed "
    "percentiles, dominant flow) is kept in memory during a run and is not "
    "written to SQLite, so it is unavailable for historical sessions. "
    "Observation-derived speed and direction distributions below are computed "
    "from persisted rows and are labelled as such.")


# --------------------------------------------------------------------- guards
def validate_session_id(session: str) -> str:
    if not session or len(session) > MAX_SESSION_LEN or not SESSION_RE.match(session):
        raise api_error(
            422, "invalid_session_id",
            "Session ids are 1-80 characters of letters, digits, '_', '.', ':' "
            "or '-' and must start with a letter or digit.")
    return session


def overview_or_404(session: str) -> dict:
    overview = repo.session_overview(session)
    if overview is None:
        raise api_error(404, "session_not_found",
                        f"No persisted session with id {session!r}.")
    return overview


def artifacts(session: str) -> SessionArtifacts | None:
    return store.get(session)


# ---------------------------------------------------------------------- media
def frame_url(session: str, frame: int, kind: str = "annotated") -> str:
    return (f"/api/v1/sessions/{quote(session, safe='')}"
            f"/frames/{int(frame)}?kind={kind}")


def realtime_frames(session: str) -> list[dict]:
    art = artifacts(session)
    if art is None:
        return []
    return [{"frame": p.frame, "ts_s": round(p.ts_s, 3),
             "annotated_url": frame_url(session, p.frame, "annotated"),
             "original_url": frame_url(session, p.frame, "original")}
            for p in sorted(art.previews.values(), key=lambda p: p.frame)]


def evidence_for(session: str, frame: int, track_id: int) -> dict | None:
    art = artifacts(session)
    if art is None:
        return None
    return art.evidence.get((int(frame), int(track_id)))


def evidence_payload(evidence: dict | None, *, session: str) -> dict:
    if evidence is None:
        return {"available": False, "source": "not_persisted", "rules": [],
                "ml_note": None, "scene_note": None, "zone": None,
                "zone_dwell_s": None, "appearance": None}
    return {
        "available": True,
        "source": "in_process_artifacts",
        "rules": evidence.get("rules") or [],
        "ml_note": evidence.get("ml_note") or None,
        "scene_note": evidence.get("scene_note") or None,
        "zone": evidence.get("zone"),
        "zone_dwell_s": evidence.get("zone_dwell_s"),
        "appearance": {"color": evidence.get("color"),
                       "shape": evidence.get("shape")},
    }


def media_payload(session: str) -> dict:
    art = artifacts(session)
    frames = realtime_frames(session)
    return {
        "session": session,
        "available": bool(frames),
        "preview_stride": art.preview_stride if art else None,
        "preview_count": len(frames),
        "source_resolution": ({"width": art.width, "height": art.height}
                              if art and art.width else None),
        "frames": frames,
        "annotated_video": {
            "available": False,
            "reason": "No annotated video is produced or stored by the "
                      "pipeline; annotations exist only in the live preview "
                      "frames and the Streamlit UI.",
        },
        "notes": [
            MEDIA_LIMITATION.format(stride=art.preview_stride if art else 6),
            "Frame access is scoped to the requested session; frame numbers "
            "outside the retained preview set return 404.",
        ],
    }


# ------------------------------------------------------------------- payloads
def _limitations(session: str) -> list[str]:
    art = artifacts(session)
    notes: list[str] = []
    if art is None:
        notes.append(EVIDENCE_LIMITATION)
        notes.append(TRAJECTORY_LIMITATION)
        notes.append(MEDIA_LIMITATION.format(stride=6))
        notes.append(CALIBRATION_LIMITATION)
    else:
        notes.append(
            "Structured evidence, trajectories and preview frames for this "
            "session are retained in memory by this API process only and are "
            "released on restart or after newer sessions replace them.")
        if not art.scene:
            notes.append(CALIBRATION_LIMITATION)
    return notes


def detail_payload(session: str) -> dict:
    overview = overview_or_404(session)
    art = artifacts(session)
    frames = realtime_frames(session)
    return {
        **overview,
        "artifacts": {
            "retained": art is not None,
            "trajectories": bool(art and art.has_trajectories),
            "structured_evidence": bool(art and art.has_evidence),
            "scene_calibration": bool(art and art.scene),
            "preview_frames": len(frames),
        },
        "media": {
            "preview_frames": len(frames),
            "available": bool(frames),
            "preview_stride": art.preview_stride if art else None,
        },
        "labels": {
            "labels": overview["counts"]["labels"],
            "evaluation_url": (f"/api/v1/sessions/{quote(session, safe='')}"
                               "/evaluation"),
        },
        "limitations": _limitations(session),
    }


def _shares(levels: dict[str, int]) -> dict[str, float]:
    total = sum(levels.values())
    if total <= 0:
        return {level: 0.0 for level in repo.LEVELS}
    return {level: round(levels[level] / total, 4) for level in repo.LEVELS}


def summary_payload(session: str) -> dict:
    overview = overview_or_404(session)
    stats = repo.session_summary_stats(session)
    processing = overview["processing"]
    fps = processing["fps"]
    first = overview["frame_range"]["first"]
    last = overview["frame_range"]["last"]
    observed = (round((last - first) / fps, 3)
                if fps and first is not None and last is not None else None)
    return {
        "session": overview["session"],
        "source": overview["source"],
        "processing": processing,
        "counts": overview["counts"],
        "level_share": _shares(overview["counts"]["levels"]),
        "anomalies": {
            "count": stats["count"],
            "tracks_affected": stats["tracks"],
            "score_min": stats["score_min"],
            "score_max": stats["score_max"],
            "score_mean": stats["score_mean"],
            "highest": stats["highest"],
        },
        "tracks": {
            "count": stats["track_total"],
            "with_anomalies": stats["with_anomalies"],
            "with_irregular": stats["with_irregular"],
        },
        "temporal": {
            "first_frame": first,
            "last_frame": last,
            "observed_seconds": observed,
        },
        "labels": {
            "labels": overview["counts"]["labels"],
            "evaluation_url": (f"/api/v1/sessions/{quote(session, safe='')}"
                               "/evaluation"),
        },
    }


# ---------------------------------------------------------------------- scene
def _deviation_payload(scene: dict) -> dict:
    scores = scene["scene_scores"]
    tracks = scene["tracks"]
    top = sorted(({"track_id": int(tid),
                   "max_scene_score": round(max(values), 4),
                   "observations": len(values)}
                  for tid, values in tracks.items() if values),
                 key=lambda item: -item["max_scene_score"])[:5]
    return {
        "scene_score": {
            "samples": len(scores),
            "mean": (repo.round_or_none(sum(scores) / len(scores), 4)
                     if scores else None),
            "p50": (repo.round_or_none(sorted(scores)[len(scores) // 2], 4)
                    if scores else None),
            "max": repo.round_or_none(max(scores), 4) if scores else None,
        },
        "above_0_2": sum(1 for s in scores if s >= 0.2),
        "above_0_3": sum(1 for s in scores if s >= 0.3),
        "affected_tracks": sum(1 for values in tracks.values()
                               if any(v > 0 for v in values)),
        "top_tracks": top,
    }


def scene_payload(session: str) -> dict:
    overview_or_404(session)
    art = artifacts(session)
    scene = repo.scene_observations(session)
    notes: list[str] = []
    recorded = art.scene if art and art.scene else None

    if recorded is None:
        calibration = {
            "available": False, "ready": None, "samples": None, "tracks": None,
            "observed_seconds": None, "reason": CALIBRATION_LIMITATION,
        }
        notes.append(
            "Speed distribution and directions below are derived from this "
            "session's persisted observations, not from the calibrator's "
            "internal state.")
        speeds = repo.speed_distribution(scene["speeds"])
        baseline = None
        if speeds is not None:
            moving = (sum(1 for s in scene["speeds"] if s > 0)
                      / len(scene["speeds"])) if scene["speeds"] else None
            baseline = {**speeds,
                        "moving_fraction": repo.round_or_none(moving, 4),
                        "source": "derived_event_observations"}
        directions = None
        if scene["angles"]:
            directions = {**repo.direction_profile(scene["angles"]),
                          "source": "derived_event_observations"}
        source = "derived_observations"
    else:
        calibration = {
            "available": True,
            "ready": bool(recorded.get("ready")),
            "samples": recorded.get("n_samples"),
            "tracks": recorded.get("n_tracks"),
            "observed_seconds": recorded.get("observed_seconds"),
            "reason": None,
        }
        speeds = {
            "samples": int(recorded.get("n_samples") or 0),
            "p10": repo.round_or_none(recorded.get("speed_p10"), 2),
            "p50": repo.round_or_none(recorded.get("speed_p50"), 2),
            "p90": repo.round_or_none(recorded.get("speed_p90"), 2),
            "mean": repo.round_or_none(recorded.get("speed_mean"), 2),
            "std": repo.round_or_none(recorded.get("speed_std"), 2),
            "min": None, "max": None,
        }
        baseline = {**speeds,
                    "moving_fraction": repo.round_or_none(
                        recorded.get("moving_fraction"), 4),
                    "source": "run_calibration"}
        histogram = recorded.get("direction_hist") or {}
        directions = {
            "samples": int(recorded.get("n_samples") or 0),
            "counts": None,
            "histogram": {k: repo.round_or_none(v, 4)
                          for k, v in histogram.items()},
            "dominant": list(recorded.get("dominant_directions") or []),
            "source": "run_calibration",
        }
        source = "run_calibration"
        notes.append(
            "Calibration values come from the calibrator at the end of the "
            "run (in-process artifact); deviations are computed from the "
            "persisted per-observation scene scores.")

    return {
        "session": session,
        "source": source,
        "calibration": calibration,
        "speed_baseline": baseline,
        "directions": directions,
        "deviations": _deviation_payload(scene),
        "notes": notes,
    }


# ----------------------------------------------------------------- evaluation
def evaluation_payload(session: str) -> dict:
    overview_or_404(session)
    rows = repo.evaluation_observations(session)
    labels = load_labels(Path(load_config().paths.db), session)
    label_counts: dict[str, int] = {"Normal": 0, "Anomaly": 0}
    for label in labels:
        value = label["label"]
        label_counts[value] = label_counts.get(value, 0) + 1
    outcome = evaluate(rows, labels)
    metrics = outcome.metrics.as_dict() if outcome.metrics is not None else None
    total = len(rows)
    labeled = outcome.n_labeled
    return {
        "session": session,
        "available": bool(labels),
        "computable": outcome.computable,
        "metrics": metrics,
        "reason": outcome.reason or None,
        "labeled_observations": labeled,
        "total_observations": total,
        "unlabeled_observations": int(
            outcome.extras.get("unlabeled_observations", total - labeled)),
        "coverage": (round(labeled / total, 4) if total else None),
        "label_counts": label_counts,
        "predicted_positive": sum(1 for row in rows
                                  if predicted_positive(row["level"])),
        "positive_rule": "Suspicious or Irregular counts as a positive prediction",
    }


# --------------------------------------------------------------------- report
def report_payload(session: str) -> dict:
    """Everything the markdown report needs, in one pass."""
    return {
        "detail": detail_payload(session),
        "summary": summary_payload(session),
        "tracks": repo.list_tracks(session, limit=1000)[1],
        "anomalies": repo.list_anomalies(session, limit=None)[1],
        "scene": scene_payload(session),
        "evaluation": evaluation_payload(session),
        "media": media_payload(session),
    }


def anomaly_evidence_map(session: str, rows: Iterable[dict]) -> list[dict]:
    """Attach structured evidence (when retained) to repository anomaly rows."""
    art = artifacts(session)
    out: list[dict] = []
    for row in rows:
        evidence = None
        if art is not None:
            evidence = art.evidence.get((int(row["frame"]), int(row["track_id"])))
        out.append({**row,
                    "evidence": evidence_payload(evidence, session=session)})
    return out


def filter_by_event_type(rows: list[dict], event_type: str, *,
                         session: str) -> list[dict]:
    """Filter anomaly rows by rule name, or by ML/scene score presence."""
    if event_type == "ml":
        return [r for r in rows if (r["scores"]["ml"] or 0) > 0]
    if event_type == "scene":
        return [r for r in rows if (r["scores"]["scene"] or 0) > 0]
    if artifacts(session) is None:
        raise api_error(
            400, "event_type_unavailable",
            f"Filtering by rule {event_type!r} needs structured rule evidence, "
            "which is only retained for sessions analysed by this API process. "
            "Use event_type=ml or event_type=scene, or filter by severity.")
    return [r for r in rows
            if any(rule.get("rule") == event_type
                   for rule in r["evidence"]["rules"])]

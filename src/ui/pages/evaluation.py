"""Evaluation & Reports - reproducible metrics computed ONLY from
user-provided ground-truth labels, processing performance, session report and
exports, plus a session-history browser that stays separate from the current
session.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import pandas as pd
import streamlit as st

from config.config import load_config
from src.analysis import ground_truth, metrics
from src.analysis.metrics import EvaluationOutcome
from src.ui.report import build_session_report
from src.ui.session import (SessionResult, delete_session, load_history,
                            load_session_data, save_session_to_db)
from src.ui.theme import (empty_state, kpi, page_header, panel,
                          require_result_or_hint, section)


# ------------------------------------------------------------- GT labelling
def _labels_from_tracks(res: SessionResult, track_labels: dict) -> list[dict]:
    rows: list[dict] = []
    for tid, label in track_labels.items():
        if label not in ground_truth.VALID_LABELS:
            continue
        frames = res.obs.loc[res.obs["track_id"] == tid, "frame"]
        rows.extend({"frame_idx": int(f), "track_id": int(tid), "label": label}
                    for f in frames)
    return rows


def _labeling_panel(res: SessionResult) -> list[dict]:
    section("Ground truth", "label what really happened - metrics only "
                            "exist where labels exist")
    st.caption("Example: mark the normal traffic objects 'Normal' and the "
               "runner/loiterer 'Anomaly' on the anomaly sample. Unlabelled "
               "tracks are excluded from all metrics.")
    gt = st.session_state.setdefault("gt_labels", {})
    if res.tracks.empty:
        st.caption("No tracks to label in this session.")
        return []
    cols = st.columns(min(4, max(1, len(res.tracks))))
    for i, tid in enumerate(res.tracks["track_id"].tolist()):
        with cols[i % len(cols)]:
            opts = ["Not labeled", "Normal", "Anomaly"]
            cur = gt.get(int(tid), "Not labeled")
            pick = st.selectbox(f"Track {tid}", opts,
                                index=opts.index(cur), key=f"gt_{tid}")
            gt[int(tid)] = pick
    labels = _labels_from_tracks(res, {t: l for t, l in gt.items()
                                       if l in ground_truth.VALID_LABELS})

    b1, b2, b3, b4 = st.columns([1.1, 1.1, 1.1, 1.7])
    with b1:
        if st.button("Evaluate now", type="primary"):
            outcome = metrics.evaluate(res.obs.to_dict("records"), labels)
            st.session_state["eval_outcome"] = outcome
    with b2:
        if st.button("Save labels to DB"):
            n = ground_truth.save_labels(load_config().paths.db, res.session,
                                         labels)
            st.success(f"Saved {n} labelled observations for session "
                       f"{res.session}.")
    with b3:
        if st.button("Load saved labels"):
            saved = ground_truth.load_labels(load_config().paths.db, res.session)
            if not saved:
                st.info("No stored labels for this session yet.")
            else:
                per_track: dict = {}
                for r in saved:
                    per_track[r["track_id"]] = r["label"]
                st.session_state["gt_labels"] = per_track
                st.rerun()
    with b4:
        saved = ground_truth.load_labels(load_config().paths.db, res.session)
        st.caption(f"{len(labels)} observation labels staged · "
                   f"{len(saved)} stored in the database for this session")
    return labels


def _metrics_panel() -> None:
    outcome: EvaluationOutcome | None = st.session_state.get("eval_outcome")
    section("Evaluation metrics", "frame-level, decision rule: "
                                  "Suspicious|Irregular = positive")
    if outcome is None:
        empty_state("Not evaluated yet",
                    "Label at least one normal and one anomalous track, then "
                    "press 'Evaluate now'. Until both classes are labelled, "
                    "precision/recall/F1 would be undefined - so we do not "
                    "display them.")
        return
    if outcome.metrics is None:
        empty_state("Metrics not computable", outcome.reason)
        return
    m = outcome.metrics
    cols = st.columns(5)
    cols[0].markdown(kpi("Precision", f"{m.precision:.3f}",
                         "of flagged observations that were correct"),
                     unsafe_allow_html=True)
    cols[1].markdown(kpi("Recall", f"{m.recall:.3f}",
                         "of labelled anomalies that were caught"),
                     unsafe_allow_html=True)
    cols[2].markdown(kpi("F1", f"{m.f1:.3f}", "harmonic mean"),
                     unsafe_allow_html=True)
    cols[3].markdown(kpi("False-positive rate", f"{m.fpr:.3f}",
                         "normal observations flagged"), unsafe_allow_html=True)
    cols[4].markdown(kpi("Accuracy", f"{m.accuracy:.3f}",
                         f"n = {m.n_labeled} labelled observations"),
                     unsafe_allow_html=True)

    cm = pd.DataFrame(
        {"predicted Normal": [m.tn, m.fp],
         "predicted Anomaly": [m.fn, m.tp]},
        index=["true Normal", "true Anomaly"])
    c1, c2 = st.columns([1, 1.4])
    with c1:
        st.markdown("<b style='font-size:.9rem'>Confusion matrix</b>",
                    unsafe_allow_html=True)
        st.dataframe(cm, width="stretch")
    with c2:
        st.markdown(panel(
            f"<div class='muted' style='font-size:.84rem;line-height:1.7;'>"
            f"TP {m.tp} · FP {m.fp} · FN {m.fn} · TN {m.tn}<br>"
            f"Predicted-positive observations: {outcome.n_predicted_positive}<br>"
            f"{outcome.extras.get('unlabeled_observations', 0)} unlabelled "
            f"observations excluded.<br>"
            "<b style='color:#e6e9f2'>Scope:</b> these metrics cover this "
            "session's labelled observations only - no claim of general "
            "accuracy is made beyond them.</div>"), unsafe_allow_html=True)


# ------------------------------------------------------------------ exports
def _exports_panel(res: SessionResult, labels: list[dict]) -> None:
    section("Reports & exports")
    outcome: EvaluationOutcome | None = st.session_state.get("eval_outcome")
    report = build_session_report(res, outcome)
    now = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    c1, c2, c3 = st.columns(3)
    with c1:
        st.download_button("Session report (Markdown)",
                           data=report, file_name=f"report_{now}.md",
                           mime="text/markdown", width="stretch")
        summary = {
            "generated_utc": now,
            "session": res.session,
            "source": res.source_label,
            "synthetic": res.is_synthetic,
            "frames_processed": res.frames_processed,
            "wall_s": res.wall_s,
            "proc_fps": round(res.proc_fps, 2),
            "level_counts": res.level_counts,
            "tracks": len(res.tracks),
            "observations": len(res.obs),
            "evaluation": (outcome.metrics.as_dict() if outcome and outcome.metrics
                           else {"computed": False,
                                 "reason": (outcome.reason if outcome else
                                            "not evaluated")}),
        }
        st.download_button("Session summary (JSON)",
                           data=json.dumps(summary, indent=2),
                           file_name=f"summary_{now}.json",
                           mime="application/json", width="stretch")
    with c2:
        st.download_button("Observations CSV",
                           data=res.obs.drop(columns=["rules_json"]).to_csv(index=False),
                           file_name=f"observations_{now}.csv",
                           mime="text/csv", width="stretch")
        st.download_button("Track summaries CSV",
                           data=res.tracks.to_csv(index=False),
                           file_name=f"tracks_{now}.csv", mime="text/csv",
                           width="stretch")
    with c3:
        st.download_button("Anomaly events CSV",
                           data=(res.events.drop(columns=["rules_json"])
                                 .to_csv(index=False)),
                           file_name=f"events_{now}.csv", mime="text/csv",
                           width="stretch")
        st.download_button("Ground-truth labels CSV",
                           data=pd.DataFrame(labels, columns=[
                               "frame_idx", "track_id", "label"]).to_csv(index=False),
                           file_name=f"ground_truth_{now}.csv", mime="text/csv",
                           width="stretch")

    if st.button("Save this session to the database", type="primary"):
        counts = save_session_to_db(res)
        st.success(f"Persisted {counts['events']} observations and "
                   f"{counts['summaries']} track summaries under session "
                   f"{res.session} (replaces that session's rows only - other "
                   "sessions are untouched).")


# ------------------------------------------------------------------ history
def _history_panel(current_session: str | None) -> None:
    section("Session history", "stored runs - separate from your current "
                               "session")
    sessions = load_history(load_config().paths.db)
    if not sessions:
        st.caption("No sessions stored yet. Save the current session above to "
                   "add one.")
        return
    names = [s["session"] for s in sessions]
    chosen = st.selectbox("Stored session", names, key="history_pick")
    s = next(x for x in sessions if x["session"] == chosen)
    cols = st.columns(5)
    cols[0].markdown(kpi("Events", str(s["events"]), "stored observations"),
                     unsafe_allow_html=True)
    cols[1].markdown(kpi("Anomalies", str(s["anomalies"]), "non-Normal rows"),
                     unsafe_allow_html=True)
    cols[2].markdown(kpi("Frames", str(s.get("frames") or "—"),
                         "from run stats"), unsafe_allow_html=True)
    cols[3].markdown(kpi("Wall time",
                         f"{s['wall_s']:.1f}s" if s.get("wall_s") else "—",
                         "processing"), unsafe_allow_html=True)
    cols[4].markdown(kpi("Source", (s.get("source") or "—")[:22],
                         "synthetic" if s.get("synthetic") else "recorded run"),
                     unsafe_allow_html=True)
    st.caption(f"last activity {s['last_ts']} · stored observations "
               f"{s['events']} · this is history, not the active session")

    ev, summ, run = load_session_data(load_config().paths.db, chosen)
    anomalies = ev[ev["level"] != "Normal"] if not ev.empty else ev
    with st.expander(f"Stored anomaly rows ({len(anomalies)})"):
        if anomalies.empty:
            st.caption("No anomaly rows in this stored session.")
        else:
            st.dataframe(anomalies[["ts_utc", "frame_idx", "track_id", "level",
                                    "fused_score", "why"]],
                         hide_index=True, width="stretch")
    h1, h2, h3 = st.columns(3)
    with h1:
        st.download_button("Export stored events (CSV)",
                           data=ev.to_csv(index=False),
                           file_name=f"{chosen}_events.csv", mime="text/csv",
                           width="stretch")
    with h2:
        confirm = st.checkbox(f"Confirm deletion of {chosen}",
                              key=f"del_confirm_{chosen}")
        if st.button("Delete stored session", disabled=not confirm,
                     width="stretch"):
            removed = delete_session(load_config().paths.db, chosen)
            st.success(f"Removed {removed['events']} events and "
                       f"{removed['summaries']} summaries for {chosen}.")
            st.rerun()
    with h3:
        if chosen == current_session:
            st.caption("This session is also the active one.")


def main() -> None:
    page_header("Evaluation & Reports",
                "Processing performance, honest evaluation against your "
                "labels, exports and stored session history.")
    if not require_result_or_hint("Evaluation & Reports"):
        return
    res: SessionResult = st.session_state["session_result"]

    section("Processing performance", "measured during this run")
    cols = st.columns(4)
    cols[0].markdown(kpi("Frames processed", str(res.frames_processed),
                         f"of {res.frames_available} in source"),
                     unsafe_allow_html=True)
    cols[1].markdown(kpi("Wall time", f"{res.wall_s:.1f}s",
                         f"{res.proc_fps:.1f} frames/s"), unsafe_allow_html=True)
    cols[2].markdown(kpi("Resolution", f"{res.frame_width}×{res.frame_height}",
                         f"{res.fps:.1f} fps source"), unsafe_allow_html=True)
    cols[3].markdown(kpi("Preview frames", str(len(res.previews)),
                         "strided, max 640px wide"), unsafe_allow_html=True)

    labels = _labeling_panel(res)
    _metrics_panel()
    _exports_panel(res, labels)
    _history_panel(res.session)


if __name__ == "__main__":
    main()
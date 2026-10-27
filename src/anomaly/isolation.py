"""Phase 5 - Isolation Forest anomaly detection.

Two complementary estimators feed the fusion stage:

  1. A *global* IsolationForest fit on recent movements across all track IDs,
     refit every REFIT_EVERY observations (cheap: a few hundred samples).
     It learns what "moving like a normal object" looks like in this session.
  2. A *per-track* rolling window so a single object that starts behaving very
     differently from its own history scores high even if its behaviour is
     moderately common in the scene.

Scores are mapped from the forest's raw decision_function onto a 0..1 scale:
larger = more anomalous. Explanation strings are derived which feature most
pushed the z-score (speed / heading change / acceleration).
"""
from __future__ import annotations

from collections import defaultdict, deque
from functools import partial

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

from config.config import MLAnomalyConfig, load_config
from src.analysis.features import MovementSnapshot

FEATURE_NAMES = ("speed", "heading_change", "acceleration")
REFIT_EVERY = 60        # observations between IsolationForest refits


class IsolationAnomalyDetector:
    """Session-scoped IsolationForest detector (global + per-track windows)."""

    def __init__(self, config: MLAnomalyConfig | None = None):
        self.cfg = config or load_config().anomaly
        self._global_X: deque = deque(maxlen=2000)
        # functools.partial (not a lambda) so the detector stays picklable:
        # Streamlit's @st.cache_data pickles whatever a cached fn returns.
        self._per_track: dict[int, deque] = defaultdict(
            partial(deque, maxlen=self.cfg.per_object_window))
        self._since_refit = 0
        self._scaler = RobustScaler()
        self._forest: IsolationForest | None = None
        self._feature_medians = np.zeros(len(FEATURE_NAMES))
        self._feature_scales = np.ones(len(FEATURE_NAMES))

    # ------------------------------------------------------------ ingest
    def _vec(self, snap: MovementSnapshot) -> np.ndarray:
        return np.array([
            snap.speed_px_s,
            snap.heading_change_deg or 0.0,
            snap.acceleration_px_s2,
        ], dtype=float)

    def observe(self, snap: MovementSnapshot) -> None:
        v = self._vec(snap)
        self._global_X.append(v)
        self._per_track[snap.track_id].append(v)
        self._since_refit += 1
        if self._since_refit >= REFIT_EVERY or self._forest is None:
            self._refit()

    def _refit(self) -> None:
        if len(self._global_X) < 30:
            return
        X = np.array(self._global_X)
        self._scaler = RobustScaler().fit(X)
        self._feature_medians = np.median(X, axis=0)
        iqr = np.abs(np.percentile(X, 75, axis=0)
                     - np.percentile(X, 25, axis=0))
        self._feature_scales = np.maximum(iqr, 1.0)
        self._forest = IsolationForest(
            n_estimators=80, contamination=self.cfg.contamination,
            random_state=0).fit(self._scaler.transform(X))
        self._since_refit = 0

    # ------------------------------------------------------------ scoring
    def score(self, snap: MovementSnapshot) -> tuple[float, str]:
        """(anomaly_score 0..1, explanation). 0 when not enough data yet."""
        if self._forest is None:
            return 0.0, "collecting observations"
        v = self._vec(snap).reshape(1, -1)
        df = self._forest.decision_function(self._scaler.transform(v))[0]
        # decision_function: normal >> 0, anomalous << 0. Map [-0.2, 0.2] -> 0..1
        global_score = float(np.clip(0.5 - df / 0.4 * 0.5, 0.0, 1.0))

        per_track_score = 0.0
        own = self._per_track.get(snap.track_id)
        if own is not None and len(own) >= 10:
            own_arr = np.array(own)
            med = np.median(own_arr, axis=0)
            z = np.abs(v[0] - med) / np.maximum(
                np.abs(np.percentile(own_arr, 75, axis=0)
                       - np.percentile(own_arr, 25, axis=0)), 1.0)
            per_track_score = float(np.clip(z.max() / 4.0, 0.0, 1.0))

        score = max(global_score, per_track_score)
        if score < 0.35:
            return round(score, 3), "movement is consistent with recent observations"
        return round(score, 3), self._explain_dev(v[0])

    def _explain_dev(self, v: np.ndarray) -> str:
        med = self._feature_medians
        scale = self._feature_scales
        if np.all(scale <= 0):
            return "feature distribution unknown"
        z = np.abs(v - med) / scale
        i = int(np.argmax(z))
        name, val = FEATURE_NAMES[i], v[i]
        if val > med[i]:
            rel = "above" if i != 2 else "accelerating above"
        else:
            rel = "below" if i != 2 else "decelerating below"
        return (f"{name} ({val:.0f}) is {z[i]:.1f} robust-sdevs "
                f"{rel} the learned median ({med[i]:.0f})")

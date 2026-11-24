"""Shared validation for persisted calibration snapshots.

Both the read-only API repository and ``ResultLogger.get_calibration`` decode
snapshots through this module, so the two paths cannot disagree about which
persisted documents are safe to interpret.

Bounds are derived from the code that produces snapshots, not guessed:

* ``n_samples`` is the length of ``ScenarioCalibrator._speeds``, whose deque
  has ``maxlen=6000`` in ``src/analysis/calibration.py``.
* ``n_tracks`` covers 20 distinct tracks on every frame of the API's default
  5,000-frame cap (``ApiSettings.max_frames_cap``); the UI warm-up control and
  the sample clips use only a handful of tracks.
* ``observed_seconds`` allows 30 days. The calibrator accumulates observation
  time per object per frame, and the CLI has no frame cap, so a legitimate
  long/dense session can exceed a one-day policy ceiling. This remains a
  sanity limit that rejects numeric junk, not a generator invariant.
* Speeds are in px/s. The default 1280x720 processing frame has a ~1,469 px
  diagonal, so 1,000,000 px/s is a generous ceiling even for very low-fps
  footage; the limit rejects corrupt numeric values rather than normal runs.
* Parameter ranges mirror ``src/api/schemas.py::CalibrationModel`` and the
  frontend settings validators, which are the live configuration contract.
* Direction keys are the eight octants emitted by
  ``src/analysis/features.py::_octant``; the calibrator keeps at most two
  dominant directions.
"""
from __future__ import annotations

import json
import math
from datetime import datetime

CALIBRATION_SNAPSHOT_VERSION = 1
SUPPORTED_CALIBRATION_SNAPSHOT_VERSIONS = frozenset(
    {CALIBRATION_SNAPSHOT_VERSION})

MAX_CALIBRATION_SAMPLES = 6_000
MAX_CALIBRATION_TRACKS = 100_000
MAX_OBSERVED_SECONDS = 30 * 86_400.0
MAX_SPEED_PX_S = 1_000_000.0
MAX_DOMINANT_DIRECTIONS = 2

DIRECTION_BINS = frozenset({"E", "NE", "N", "NW", "W", "SW", "S", "SE"})

# (minimum, maximum, integer_only, minimum_inclusive)
_PARAMETER_RULES = {
    "warmup_tracks": (1, 100, True, True),
    "tracks_seconds": (0, 3600, False, True),
    "min_samples": (1, 100_000, True, True),
    "direction_bin_deg": (0, 180, False, False),
}
_REQUIRED_PARAMETERS = tuple(_PARAMETER_RULES)


def _is_number(value) -> bool:
    """True for a finite JSON/Python int or float, never a boolean."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, TypeError, ValueError):
        return False


def _numeric_problem(value, minimum: float, maximum: float, *,
                     integer: bool = False,
                     minimum_inclusive: bool = True) -> bool:
    if not _is_number(value):
        return True
    if integer and not isinstance(value, int):
        return True
    if minimum_inclusive:
        if value < minimum:
            return True
    elif value <= minimum:
        return True
    return value > maximum


def _timestamp_problem(captured_ts, version: int) -> str | None:
    if not isinstance(captured_ts, str) or not captured_ts.strip():
        return (f"Calibration snapshot schema v{version} has an invalid "
                "'captured_ts' value; it was not interpreted.")
    try:
        parsed = datetime.fromisoformat(captured_ts.replace("Z", "+00:00"))
    except (ValueError, OverflowError):
        return (f"Calibration snapshot schema v{version} has an invalid "
                "'captured_ts' value; it was not interpreted.")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return (f"Calibration snapshot schema v{version} has an invalid "
                "'captured_ts' value (a timezone is required); it was not "
                "interpreted.")
    return None


def _parameter_problem(parameters, version: int) -> str | None:
    if not isinstance(parameters, dict):
        return (f"Calibration snapshot schema v{version} has malformed "
                "parameters; it was not interpreted.")
    missing = [key for key in _REQUIRED_PARAMETERS if key not in parameters]
    if missing:
        return (f"Calibration snapshot schema v{version} has parameters "
                f"missing required key(s): {', '.join(missing)}; it was not "
                "interpreted.")
    unexpected = [key for key in parameters if key not in _PARAMETER_RULES]
    if unexpected:
        labels = ", ".join(str(key) for key in unexpected)
        return (f"Calibration snapshot schema v{version} has parameters with "
                f"unexpected key(s): {labels}; it was not interpreted.")
    for key, value in parameters.items():
        if not isinstance(key, str) or not _is_number(value):
            return (f"Calibration snapshot schema v{version} has an invalid "
                    f"'{key}' parameter; it was not interpreted.")
        minimum, maximum, integer, minimum_inclusive = _PARAMETER_RULES[key]
        if _numeric_problem(value, minimum, maximum, integer=integer,
                            minimum_inclusive=minimum_inclusive):
            return (f"Calibration snapshot schema v{version} has an invalid "
                    f"'{key}' parameter; it was not interpreted.")
    return None


def calibration_snapshot_problem(calibration: dict, parameters, captured_ts,
                                 version: int) -> str | None:
    """Return a user-readable reason, or None when the snapshot is valid."""
    required = (
        "ready", "n_samples", "n_tracks", "observed_seconds",
        "speed_p10", "speed_p50", "speed_p90", "speed_mean", "speed_std",
        "direction_hist", "dominant_directions", "moving_fraction",
    )
    missing = [field for field in required if field not in calibration]
    if missing:
        return (f"Calibration snapshot schema v{version} is missing required "
                f"field(s): {', '.join(missing)}; it was not interpreted.")

    if not isinstance(calibration["ready"], bool):
        return (f"Calibration snapshot schema v{version} has an invalid "
                "'ready' value; it was not interpreted.")
    for field, maximum in (("n_samples", MAX_CALIBRATION_SAMPLES),
                           ("n_tracks", MAX_CALIBRATION_TRACKS)):
        value = calibration[field]
        if (not isinstance(value, int) or isinstance(value, bool)
                or value < 0 or value > maximum):
            return (f"Calibration snapshot schema v{version} has an invalid "
                    f"'{field}' value; it was not interpreted.")
    for field in ("observed_seconds", "speed_p10", "speed_p50", "speed_p90",
                  "speed_mean", "speed_std"):
        maximum = (MAX_OBSERVED_SECONDS if field == "observed_seconds"
                   else MAX_SPEED_PX_S)
        if _numeric_problem(calibration[field], 0, maximum):
            return (f"Calibration snapshot schema v{version} has an invalid "
                    f"'{field}' value; it was not interpreted.")
    if _numeric_problem(calibration["moving_fraction"], 0, 1):
        return (f"Calibration snapshot schema v{version} has an invalid "
                "'moving_fraction' value; it was not interpreted.")

    histogram = calibration["direction_hist"]
    if not isinstance(histogram, dict) or any(
            not isinstance(key, str) or key not in DIRECTION_BINS
            or _numeric_problem(value, 0, 1)
            for key, value in histogram.items()):
        return (f"Calibration snapshot schema v{version} has malformed "
                "histogram data; it was not interpreted.")
    # Fractions are rounded independently by the calibrator, so allow a small
    # rounding tolerance while rejecting histograms that clearly do not sum to
    # one. An empty histogram is valid when no directions were observed.
    if histogram and sum(histogram.values()) > 1.01:
        return (f"Calibration snapshot schema v{version} has malformed "
                "histogram data; it was not interpreted.")

    dominant = calibration["dominant_directions"]
    if (not isinstance(dominant, list)
            or len(dominant) > MAX_DOMINANT_DIRECTIONS
            or any(not isinstance(direction, str)
                   or direction not in DIRECTION_BINS
                   or direction not in histogram for direction in dominant)
            or len(set(dominant)) != len(dominant)):
        return (f"Calibration snapshot schema v{version} has malformed "
                "dominant direction data; it was not interpreted.")

    problem = _parameter_problem(parameters, version)
    if problem is not None:
        return problem
    return _timestamp_problem(captured_ts, version)


def snapshot_version(raw_version) -> tuple[int | None, str | None]:
    """Validate a stored schema version and explain a rejected value."""
    if raw_version is None:
        return None, ("The stored calibration snapshot has no schema version, "
                      "so it cannot be interpreted safely.")
    if isinstance(raw_version, bool) or (
            isinstance(raw_version, float) and not raw_version.is_integer()):
        return None, ("The stored calibration snapshot has an unreadable "
                      "schema version, so it cannot be interpreted safely.")
    try:
        version = int(raw_version)
    except (TypeError, ValueError, OverflowError):
        return None, ("The stored calibration snapshot has an unreadable "
                      "schema version, so it cannot be interpreted safely.")
    if version not in SUPPORTED_CALIBRATION_SNAPSHOT_VERSIONS:
        return None, (
            f"Calibration snapshot schema version {version} is not supported "
            f"by this build (supported version: "
            f"{CALIBRATION_SNAPSHOT_VERSION}); it was not interpreted.")
    return version, None


def decode_calibration_snapshot(raw_payload, version: int, captured_ts
                                ) -> tuple[dict | None, str | None]:
    """Decode and validate a supported snapshot payload.

    Returns the usable snapshot document or ``(None, reason)``. Callers decide
    whether to surface the reason (API repository) or just the absence
    (``ResultLogger``); they never disagree about validity.
    """
    try:
        payload = json.loads(raw_payload)
    except (TypeError, ValueError, RecursionError):
        # RecursionError is possible for deeply nested JSON and must not escape
        # into the API's response-validation path as an HTTP 500.
        return None, ("The stored calibration snapshot is unreadable "
                      "(malformed JSON payload); it was not interpreted.")
    if not isinstance(payload, dict) or not isinstance(
            payload.get("calibration"), dict):
        return None, ("The stored calibration snapshot has no readable "
                      "calibration object; it was not interpreted.")
    parameters = payload.get("parameters")
    problem = calibration_snapshot_problem(
        payload["calibration"], parameters, captured_ts, version)
    if problem is not None:
        return None, problem
    return ({"schema_version": version,
             "captured_ts": captured_ts,
             "calibration": payload["calibration"],
             "parameters": parameters}, None)

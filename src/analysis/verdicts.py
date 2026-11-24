"""Track-level verdicts.

One elevated frame is an event; it is not who the object is. A car whose box
jitters once reads as one Irregular observation even though it behaved
normally throughout. The verdict shown for an object therefore needs repeated
evidence before leaving the Regular band:

  * Irregular  - at least 2 irregular observations AND >= 8% of its rows
  * Suspicious - the same test on any elevated (Suspicious or Irregular) rows
  * Regular    - otherwise

The thresholds are deliberately low in absolute terms (two rows) so short
tracks can still be flagged, and the share test keeps a single spike on a long
track from branding it. `repository.py` mirrors the same rule in SQL for the
track filters.
"""
from __future__ import annotations

MIN_VERDICT_OBSERVATIONS = 2
MIN_VERDICT_SHARE = 0.08

NORMAL = "Normal"
SUSPICIOUS = "Suspicious"
IRREGULAR = "Irregular"


def _sustained(count: int, observations: int) -> bool:
    return (count >= MIN_VERDICT_OBSERVATIONS
            and count * 100 >= observations * int(MIN_VERDICT_SHARE * 100))


def track_verdict(observations: int, anomalies: int, irregular: int) -> str:
    """Worst band an object earns through sustained, not single-frame, evidence."""
    if observations <= 0:
        return NORMAL
    if _sustained(int(irregular), int(observations)):
        return IRREGULAR
    if _sustained(int(anomalies), int(observations)):
        return SUSPICIOUS
    return NORMAL

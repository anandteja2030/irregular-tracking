"""Typed response schemas for the analytics API (Phase 3).

Every field here maps to something that is genuinely stored in SQLite or
retained as an in-process artifact. Optional fields are ``None`` when the
underlying value was never recorded - they are never filled with placeholders,
and never confused with a real zero.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

_STRICT = ConfigDict(extra="forbid")


# --------------------------------------------------------------------- errors
class ErrorBody(BaseModel):
    model_config = ConfigDict(extra="allow")

    code: str
    message: str


class ErrorEnvelope(BaseModel):
    error: ErrorBody


# ------------------------------------------------------------------- sessions
class SourceInfo(BaseModel):
    model_config = _STRICT

    label: str | None
    kind: str | None
    synthetic: bool


class ProcessingInfo(BaseModel):
    model_config = _STRICT

    frames_processed: int | None
    width: int | None
    height: int | None
    fps: float | None
    wall_s: float | None
    max_frames: int | None
    processing_fps: float | None
    video_duration_s: float | None
    started_ts: str | None
    ended_ts: str | None
    run_stats_available: bool


class LevelCounts(BaseModel):
    model_config = _STRICT

    Normal: int
    Suspicious: int
    Irregular: int


class SessionCounts(BaseModel):
    model_config = _STRICT

    observations: int
    tracks: int
    anomalies: int
    levels: LevelCounts
    labels: int


class FrameRange(BaseModel):
    model_config = _STRICT

    first: int | None
    last: int | None


class SessionTimestamps(BaseModel):
    model_config = _STRICT

    first_ts: str | None
    last_ts: str | None


class SessionItem(BaseModel):
    model_config = _STRICT

    session: str
    source: SourceInfo
    processing: ProcessingInfo
    counts: SessionCounts
    frame_range: FrameRange
    timestamps: SessionTimestamps


class SessionList(BaseModel):
    model_config = _STRICT

    total: int
    count: int
    limit: int
    offset: int
    sessions: list[SessionItem]


class ArtifactInfo(BaseModel):
    model_config = _STRICT

    retained: bool
    trajectories: bool
    structured_evidence: bool
    scene_calibration: bool
    preview_frames: int


class SessionMediaInfo(BaseModel):
    model_config = _STRICT

    preview_frames: int
    available: bool
    preview_stride: int | None


class SessionLabelInfo(BaseModel):
    model_config = _STRICT

    labels: int
    evaluation_url: str


class SessionDetail(SessionItem):
    model_config = _STRICT

    artifacts: ArtifactInfo
    media: SessionMediaInfo
    labels: SessionLabelInfo
    limitations: list[str]


class ShareCounts(BaseModel):
    model_config = _STRICT

    Normal: float
    Suspicious: float
    Irregular: float


class HighestAnomaly(BaseModel):
    model_config = _STRICT

    event_id: int
    frame: int
    track_id: int
    level: str
    fused_score: float | None


class AnomalyAggregate(BaseModel):
    model_config = _STRICT

    count: int
    tracks_affected: int
    score_min: float | None
    score_max: float | None
    score_mean: float | None
    highest: HighestAnomaly | None


class TrackAggregate(BaseModel):
    model_config = _STRICT

    count: int
    with_anomalies: int
    with_irregular: int


class TemporalInfo(BaseModel):
    model_config = _STRICT

    first_frame: int | None
    last_frame: int | None
    observed_seconds: float | None


class SessionSummary(BaseModel):
    model_config = _STRICT

    session: str
    source: SourceInfo
    processing: ProcessingInfo
    counts: SessionCounts
    level_share: ShareCounts
    anomalies: AnomalyAggregate
    tracks: TrackAggregate
    temporal: TemporalInfo
    labels: SessionLabelInfo


# --------------------------------------------------------------------- tracks
class Appearance(BaseModel):
    model_config = _STRICT

    color: str | None
    shape: str | None


class TrackFrames(BaseModel):
    model_config = _STRICT

    first: int | None
    last: int | None
    summary_first: int | None
    summary_last: int | None


class TrackObserved(BaseModel):
    model_config = _STRICT

    observations: int
    anomalies: int
    levels: LevelCounts
    worst_level: str
    duration_s: float | None


class TrackMotion(BaseModel):
    model_config = _STRICT

    mean_speed_px_s: float | None
    max_speed_px_s: float | None
    path_length_px: float | None
    straightness: float | None
    n_points: int | None
    n_seconds: float | None
    summary_directions: list[str]
    max_fused_score: float | None
    speed_source: str


class TrackTimestamps(BaseModel):
    model_config = _STRICT

    first_ts: str | None
    last_ts: str | None


class TrackItem(BaseModel):
    model_config = _STRICT

    track_id: int
    appearance: Appearance
    frames: TrackFrames
    observed: TrackObserved
    motion: TrackMotion
    timestamps: TrackTimestamps


class TrackList(BaseModel):
    model_config = _STRICT

    total: int
    count: int
    limit: int
    offset: int
    tracks: list[TrackItem]


class DirectionProfile(BaseModel):
    model_config = _STRICT

    samples: int
    counts: dict[str, int] | None
    histogram: dict[str, float]
    dominant: list[str]
    source: str


class TrajectoryAvailability(BaseModel):
    model_config = _STRICT

    available: bool
    points: int
    reason: str | None


class TrackDetail(TrackItem):
    model_config = _STRICT

    session: str
    direction_profile: DirectionProfile
    trajectory: TrajectoryAvailability


class TrajectoryPoint(BaseModel):
    model_config = _STRICT

    frame: int
    x: float | None
    y: float | None
    level: str | None
    speed_px_s: float | None
    direction_deg: float | None


class TrajectoryResponse(BaseModel):
    model_config = _STRICT

    session: str
    track_id: int
    available: bool
    points: list[TrajectoryPoint]
    reason: str | None


class ScoreSet(BaseModel):
    model_config = _STRICT

    fused: float | None
    rule: float | None
    ml: float | None
    scene: float | None


class MotionSet(BaseModel):
    model_config = _STRICT

    speed_px_s: float | None
    direction_deg: float | None


class ObservationItem(BaseModel):
    model_config = _STRICT

    event_id: int
    session: str
    frame: int
    ts_utc: str
    track_id: int
    level: str
    scores: ScoreSet
    motion: MotionSet
    summary: str


class ObservationList(BaseModel):
    model_config = _STRICT

    total: int
    count: int
    limit: int
    offset: int
    observations: list[ObservationItem]


class TrackFrameItem(BaseModel):
    model_config = _STRICT

    frame: int
    ts_utc: str | None
    level: str | None
    fused_score: float | None
    speed_px_s: float | None
    preview_available: bool
    frame_url: str | None


class TrackFramesResponse(BaseModel):
    model_config = _STRICT

    session: str
    track_id: int
    total: int
    count: int
    limit: int
    offset: int
    media_available: bool
    reason: str | None
    frames: list[TrackFrameItem]


# ------------------------------------------------------------------ anomalies
class RuleEvidence(BaseModel):
    model_config = ConfigDict(extra="allow")

    rule: str
    severity: float | None = None
    description: str | None = None


class Evidence(BaseModel):
    model_config = _STRICT

    available: bool
    source: str
    rules: list[RuleEvidence]
    ml_note: str | None
    scene_note: str | None
    zone: str | None
    zone_dwell_s: float | None
    appearance: Appearance | None


class AnomalyItem(ObservationItem):
    model_config = _STRICT

    evidence: Evidence


class AnomalyList(BaseModel):
    model_config = _STRICT

    total: int
    count: int
    limit: int
    offset: int
    severity: str | None
    event_type: str | None
    anomalies: list[AnomalyItem]


class EventFrameInfo(BaseModel):
    model_config = _STRICT

    index: int
    ts_utc: str
    media_available: bool
    frame_url: str | None


class AnomalyTrackContext(BaseModel):
    model_config = _STRICT

    track_id: int
    color: str | None
    shape: str | None
    observations: int
    anomalies: int
    worst_level: str
    first_frame: int | None
    last_frame: int | None


class AnomalyDetail(AnomalyItem):
    model_config = _STRICT

    track: AnomalyTrackContext | None
    frame_info: EventFrameInfo
    notes: list[str]


# ---------------------------------------------------------------------- media
class PreviewFrameInfo(BaseModel):
    model_config = _STRICT

    frame: int
    ts_s: float
    annotated_url: str
    original_url: str


class VideoAvailability(BaseModel):
    model_config = _STRICT

    available: bool
    reason: str


class MediaResponse(BaseModel):
    model_config = _STRICT

    session: str
    available: bool
    preview_stride: int | None
    preview_count: int
    source_resolution: dict[str, int] | None
    frames: list[PreviewFrameInfo]
    annotated_video: VideoAvailability
    notes: list[str]


# ---------------------------------------------------------------------- scene
class CalibrationInfo(BaseModel):
    model_config = _STRICT

    available: bool
    ready: bool | None
    samples: int | None
    tracks: int | None
    observed_seconds: float | None
    reason: str | None


class SpeedBaseline(BaseModel):
    model_config = _STRICT

    samples: int
    p10: float
    p50: float
    p90: float
    mean: float
    std: float
    min: float | None
    max: float | None
    moving_fraction: float | None
    source: str


class SceneScoreStats(BaseModel):
    model_config = _STRICT

    samples: int
    mean: float | None
    p50: float | None
    max: float | None


class TrackDeviation(BaseModel):
    model_config = _STRICT

    track_id: int
    max_scene_score: float
    observations: int


class Deviations(BaseModel):
    model_config = _STRICT

    scene_score: SceneScoreStats
    above_0_2: int
    above_0_3: int
    affected_tracks: int
    top_tracks: list[TrackDeviation]


class SceneResponse(BaseModel):
    model_config = _STRICT

    session: str
    source: str
    calibration: CalibrationInfo
    speed_baseline: SpeedBaseline | None
    directions: DirectionProfile | None
    deviations: Deviations
    notes: list[str]


# ----------------------------------------------------------------- evaluation
class MetricsModel(BaseModel):
    model_config = _STRICT

    tp: int
    fp: int
    fn: int
    tn: int
    precision: float
    recall: float
    f1: float
    fpr: float
    accuracy: float
    n_labeled: int


class EvaluationResponse(BaseModel):
    model_config = _STRICT

    session: str
    available: bool
    computable: bool
    metrics: MetricsModel | None
    reason: str | None
    labeled_observations: int
    total_observations: int
    unlabeled_observations: int
    coverage: float | None
    label_counts: dict[str, int]
    predicted_positive: int
    positive_rule: str


# --------------------------------------------------------------------- checks
class Pagination(BaseModel):
    model_config = _STRICT

    total: int = Field(description="Matching rows before pagination")
    count: int
    limit: int
    offset: int

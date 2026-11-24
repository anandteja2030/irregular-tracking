import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, describeError, mediaUrl } from "../lib/api";
import { useResource } from "../hooks/useResource";
import type { ObjectEvidenceItem, TrackItem } from "../lib/types";
import { formatNumber } from "../lib/format";
import { classLabel } from "../lib/tracks";
import { ArrowRightIcon, ImageIcon } from "./icons";
import { EmptyState, LoadingRows } from "./StateViews";

function trackLabel(trackId: number): string {
  return `T${String(trackId).padStart(2, "0")}`;
}

/** The pictures behind the irregular rows.
 *
 * Each card is a real crop of the retained annotated preview frame at that
 * object's peak irregular observation: the engine's own box and ID label sit
 * inside the image. The crop window is a viewing window centred on the
 * measured centroid, never a detector box, and the API says so in its note.
 */
export function IrregularEvidence({
  sessionId,
  tracks = [],
}: {
  sessionId: string;
  /** Track aggregates, used to name the class of each irregular object. */
  tracks?: TrackItem[];
}) {
  const navigate = useNavigate();
  const resource = useResource(
    (signal) => api.objectEvidence(sessionId, { limit: 8 }, signal),
    { key: sessionId },
  );
  const classById = new Map(
    tracks.map((track) => [track.track_id, classLabel(track.appearance)]),
  );
  const [broken, setBroken] = useState<Set<number>>(() => new Set());

  const data = resource.data;
  const items: ObjectEvidenceItem[] = Array.isArray(data?.items) ? data.items : [];
  const note = data?.note ?? null;

  const openEvent = (item: ObjectEvidenceItem) => {
    navigate(
      `/anomalies?session=${encodeURIComponent(sessionId)}&event=${item.event_id}`,
    );
  };

  let body: React.ReactNode;
  if (resource.status === "loading" && !data) {
    body = <LoadingRows rows={2} label="Cutting object crops" />;
  } else if (resource.status === "error") {
    body = (
      <EmptyState
        compact
        title="Crops unavailable"
        body={describeError(resource.error)}
        glyph={<ImageIcon width={17} height={17} />}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        compact
        title="No irregular object crops"
        body={
          note ??
          "Nothing on this run reached the irregular band, so there is no object picture to show."
        }
        glyph={<ImageIcon width={17} height={17} />}
      />
    );
  } else {
    body = (
      <>
        <div className="evidence-grid">
          {items.map((item, index) => {
            const missing = broken.has(item.track_id);
            const offset = item.frame_offset;
            const label = classById.get(item.track_id) ?? null;
            const share =
              item.fused_score === null
                ? 0
                : Math.max(2, Math.min(100, item.fused_score * 100));
            return (
              <figure className="evidence-card" key={item.track_id}>
                <button
                  type="button"
                  className="evidence-card__frame"
                  onClick={() => openEvent(item)}
                  aria-label={`Open ${trackLabel(item.track_id)} in the Anomaly Center`}
                >
                  {missing ? (
                    <span className="evidence-card__missing">
                      <ImageIcon width={16} height={16} />
                      Frame not retained
                    </span>
                  ) : (
                    <img
                      src={mediaUrl(item.crop_url)}
                      alt={`Crop of ${trackLabel(item.track_id)}, an irregular object, at source frame ${item.retained_frame}`}
                      loading="lazy"
                      decoding="async"
                      onError={() =>
                        setBroken((current) => new Set(current).add(item.track_id))
                      }
                    />
                  )}
                  <span className="evidence-card__rank mono">#{index + 1}</span>
                  <span className="evidence-card__level mono">
                    {trackLabel(item.track_id)}
                    {label ? ` · ${label}` : ""} · Irregular
                  </span>
                  <span className="evidence-card__score mono">
                    {item.fused_score === null
                      ? "score —"
                      : `fused ${item.fused_score.toFixed(2)}`}
                  </span>
                </button>
                <figcaption className="evidence-card__body">
                  <span className="evidence-card__meta mono">
                    frame F{formatNumber(item.retained_frame)}
                    {offset === 0
                      ? " · peak"
                      : ` · nearest retained (${offset > 0 ? "+" : ""}${offset})`}
                    {item.speed_px_s === null
                      ? ""
                      : ` · ${item.speed_px_s.toFixed(0)} px/s`}
                    {item.direction_deg === null
                      ? ""
                      : ` · ${item.direction_deg.toFixed(0)}°`}
                  </span>
                  {item.fused_score !== null && (
                    <span className="evidence-card__meter" aria-hidden="true">
                      <span
                        className="evidence-card__meter-fill"
                        style={{ width: `${share}%` }}
                      />
                    </span>
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <section className="irregular-evidence" aria-label="Irregular object crops">
      <header className="irregular-evidence__head">
        <div>
          <h3 className="irregular-evidence__title">Irregular objects · captured</h3>
          <p className="irregular-evidence__meta mono">
            {data
              ? `${formatNumber(data.irregular_objects)} irregular observations · ${formatNumber(
                  data.ranked_objects,
                )} objects · ${formatNumber(data.preview_frames)} retained frames`
              : "cut from the retained annotated frames"}
          </p>
        </div>
        <button
          type="button"
          className="irregular-evidence__link"
          onClick={() =>
            navigate(`/anomalies?session=${encodeURIComponent(sessionId)}`)
          }
        >
          Anomaly Center <ArrowRightIcon width={13} height={13} />
        </button>
      </header>
      {body}
    </section>
  );
}

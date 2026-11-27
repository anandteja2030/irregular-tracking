/** Curated ground-truth labels for one session.
 *
 * Evaluation is only a measurement when the labels are real user input, so this
 * panel never offers "label everything the engine flagged". It labels one
 * object's persisted observations at a time as Normal or Anomaly, shows how many
 * rows that writes, and can clear the session's labels again.
 */
import { useMemo, useState } from "react";
import { useResource } from "../hooks/useResource";
import { api } from "../lib/api";
import type { TrackItem } from "../lib/types";
import { appearanceLabel, formatTrackId, trackReading } from "../lib/tracks";
import { formatNumber } from "../lib/format";
import { Panel } from "./Panel";
import { EmptyState, LoadingRows } from "./StateViews";
import { RefreshIcon } from "./icons";

/** Inline failure note with its own retry label, so this panel never adds a
 * second generic "Retry request" button to the page. */
function InlineFailure({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <p className="note-line note-line--wrap" role="status">
      <span className="dot dot--bad" />
      <span>{message}</span>
      <button type="button" className="btn btn--quiet btn--sm" onClick={onRetry}>
        {retryLabel}
      </button>
    </p>
  );
}

type Label = "Normal" | "Anomaly";

export function GroundTruthLabeller({
  sessionId,
  onChanged,
}: {
  sessionId: string;
  /** Called after a write so the page can refresh its evaluation payload. */
  onChanged?: () => void;
}) {
  const labels = useResource((signal) => api.labels(sessionId, signal), {
    key: sessionId,
  });
  const tracks = useResource(
    (signal) => api.tracks(sessionId, { sort: "anomalies", limit: 200 }, signal),
    { key: sessionId },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  /** Rows already labelled per track, counted from the stored labels. */
  const perTrack = useMemo(() => {
    const map = new Map<number, { Normal: number; Anomaly: number }>();
    for (const row of labels.data?.labels ?? []) {
      const current = map.get(row.track_id) ?? { Normal: 0, Anomaly: 0 };
      current[row.label] += 1;
      map.set(row.track_id, current);
    }
    return map;
  }, [labels.data]);

  async function write(track: TrackItem, label: Label) {
    setBusy(`${track.track_id}:${label}`);
    setError(null);
    setMessage(null);
    try {
      const result = await api.saveLabels(sessionId, {
        tracks: [{ track_id: track.track_id, label }],
      });
      setMessage(
        `${formatNumber(result.saved ?? 0)} observations of ${formatTrackId(
          track.track_id,
        )} stored as ${label.toLowerCase()}.`,
      );
      labels.reload();
      onChanged?.();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    setBusy("clear");
    setError(null);
    setMessage(null);
    try {
      const result = await api.clearLabels(sessionId);
      setMessage(`Removed ${formatNumber(result.removed ?? 0)} stored labels.`);
      labels.reload();
      onChanged?.();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const stored = labels.data?.count ?? 0;
  const normal = labels.data?.counts?.Normal ?? 0;
  const anomaly = labels.data?.counts?.Anomaly ?? 0;
  const rows = tracks.data?.tracks ?? [];

  return (
    <Panel
      title="Ground truth labeller"
      sub="Explicit input only · the engine never labels itself"
      actions={
        <span className={`tag mono ${stored > 0 ? "tag--ok" : ""}`.trim()}>
          {formatNumber(stored)} labels stored
        </span>
      }
    >
      <p className="explain explain--tight">
        An object is scored as <strong>Anomaly</strong> when it should have been flagged and{" "}
        <strong>Normal</strong> when it should not have been. Choosing a class labels every
        observation the engine actually stored for that object, and each object can be labelled
        once. Metrics on this page only exist while both classes are present.
      </p>

      {labels.status === "error" ? (
        <InlineFailure
          message="The stored labels could not be read, so this panel cannot say what is already labelled."
          retryLabel="Retry labels"
          onRetry={labels.reload}
        />
      ) : (
        <div className="labeller__summary">
          <span className="labeller__count">
            <span className="labeller__dot labeller__dot--normal" aria-hidden="true" />
            Normal <span className="mono">{formatNumber(normal)}</span>
          </span>
          <span className="labeller__count">
            <span className="labeller__dot labeller__dot--anomaly" aria-hidden="true" />
            Anomaly <span className="mono">{formatNumber(anomaly)}</span>
          </span>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={clearAll}
            disabled={busy !== null || stored === 0}
          >
            <span className="btn__icon">
              <RefreshIcon width={12} height={12} />
            </span>
            {busy === "clear" ? "Clearing…" : "Clear stored labels"}
          </button>
        </div>
      )}

      {message && (
        <p className="hint hint--flush" role="status">
          {message}
        </p>
      )}
      {error !== null && (
        <p className="note-line note-line--wrap" role="alert">
          <span className="dot dot--bad" />
          <span>The label write failed: {String((error as Error)?.message ?? "unknown error")}</span>
        </p>
      )}

      {tracks.status === "error" ? (
        <InlineFailure
          message="The object roster could not be read, so there is nothing to label here."
          retryLabel="Retry objects"
          onRetry={tracks.reload}
        />
      ) : tracks.status === "loading" && !tracks.data ? (
        <LoadingRows rows={4} label="Reading the object roster" />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          title="No objects to label"
          body="This session has no persisted tracked objects, so there is nothing to label yet."
        />
      ) : (
        <ul className="labeller__list">
          {rows.map((track) => {
            const counts = perTrack.get(track.track_id);
            const labelled = (counts?.Normal ?? 0) + (counts?.Anomaly ?? 0);
            return (
              <li
                className={`labeller__row ${labelled > 0 ? "is-labelled" : ""}`.trim()}
                key={track.track_id}
              >
                <div className="labeller__id">
                  <span className="mono">{formatTrackId(track.track_id)}</span>
                  <span className="labeller__kind">{appearanceLabel(track.appearance)}</span>
                  <span className="labeller__meta mono">
                    {formatNumber(track.observed.observations)} obs · {track.observed.worst_level}
                  </span>
                </div>
                <p className="labeller__read">{trackReading(track).identity}</p>
                <div className="labeller__actions">
                  <span className="labeller__state mono">
                    {labelled > 0
                      ? `labelled: ${counts?.Normal ?? 0} normal / ${counts?.Anomaly ?? 0} anomaly`
                      : "unlabelled"}
                  </span>
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={() => void write(track, "Normal")}
                    disabled={busy !== null}
                    aria-label={`Label ${formatTrackId(track.track_id)} observations Normal`}
                  >
                    {busy === `${track.track_id}:Normal` ? "Saving…" : "Mark Normal"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => void write(track, "Anomaly")}
                    disabled={busy !== null}
                    aria-label={`Label ${formatTrackId(track.track_id)} observations Anomaly`}
                  >
                    {busy === `${track.track_id}:Anomaly` ? "Saving…" : "Mark Anomaly"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

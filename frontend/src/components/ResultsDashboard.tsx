import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import type { Level, TrackItem } from "../lib/types";
import { formatNumber } from "../lib/format";
import { appearanceLabel, classLabel } from "../lib/tracks";
import { LEVEL_COLOURS } from "./charts";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { SectionHeader } from "./SectionHeader";
import { ArrowRightIcon, TrackIcon } from "./icons";

/** The three verdicts an object can receive, in the engine's own bands. */
const BANDS: {
  level: Level;
  code: string;
  name: string;
  short: string;
  rule: string;
}[] = [
  {
    level: "Normal",
    code: "N",
    name: "Regular / genuine",
    short: "Regular",
    rule: "No sustained deviation from the baseline.",
  },
  {
    level: "Suspicious",
    code: "S",
    name: "Suspicious",
    short: "Suspicious",
    rule: "Repeated observations in the middle band.",
  },
  {
    level: "Irregular",
    code: "I",
    name: "Irregular",
    short: "Irregular",
    rule: "Repeated observations in the highest band.",
  },
];

const SEVERITY: Record<Level, number> = {
  Irregular: 0,
  Suspicious: 1,
  Normal: 2,
};

export function trackLabel(trackId: number): string {
  return `T${String(trackId).padStart(2, "0")}`;
}

function bySeverity(a: TrackItem, b: TrackItem): number {
  const band = SEVERITY[a.observed.worst_level] - SEVERITY[b.observed.worst_level];
  if (band !== 0) return band;
  if (b.observed.anomalies !== a.observed.anomalies) {
    return b.observed.anomalies - a.observed.anomalies;
  }
  return a.track_id - b.track_id;
}

/** One verdict per tracked object, grouped into the three engine bands.
 *
 * The verdict is the object's worst measured fused level — never a guessed
 * class. Every count and score below is read from persisted rows; an absent
 * value is shown as an em-dash rather than filled in.
 */
export function ResultsDashboard({
  sessionId,
  title = "Results dashboard",
}: {
  sessionId: string;
  title?: string;
}) {
  const resource = useResource(
    (signal) => api.tracks(sessionId, { sort: "anomalies", limit: 200 }, signal),
    { key: sessionId, enabled: Boolean(sessionId) },
  );
  const data = resource.data;
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  const total = data?.total ?? tracks.length;
  const sorted = [...tracks].sort(bySeverity);
  const observations = tracks.reduce(
    (sum, track) => sum + track.observed.observations,
    0,
  );

  const counts = BANDS.map((band) => {
    const members = tracks.filter(
      (track) => track.observed.worst_level === band.level,
    );
    return {
      band,
      members,
      objects: members.length,
      rows: members.reduce((sum, track) => sum + track.observed.observations, 0),
    };
  });

  let body: React.ReactNode;
  if (!sessionId) {
    body = (
      <EmptyState
        compact
        title="No session selected"
        body="Object verdicts are read from the session picked above."
        glyph={<TrackIcon width={17} height={17} />}
      />
    );
  } else if (resource.status === "error") {
    body = (
      <ErrorState
        error={resource.error}
        onRetry={resource.reload}
        title="Results unavailable"
        compact
      />
    );
  } else if (resource.status === "loading" && !data) {
    body = <LoadingRows rows={3} label="Classifying objects" />;
  } else if (tracks.length === 0) {
    body = (
      <EmptyState
        compact
        title="No tracked objects"
        body="This run persisted no object rows, so no verdict can be issued."
        glyph={<TrackIcon width={17} height={17} />}
      />
    );
  } else {
    body = (
      <>
        <div className="results-bands">
          {counts.map(({ band, members, objects, rows }) => (
            <article
              className={`results-band results-band--${band.level.toLowerCase()}`}
              key={band.level}
              style={{ ["--band-colour" as string]: LEVEL_COLOURS[band.level] }}
            >
              <header className="results-band__head">
                <span className="results-band__code mono">{band.code}</span>
                <span className="results-band__name">{band.name}</span>
              </header>
              <span className="results-band__count mono">{formatNumber(objects)}</span>
              <span className="results-band__objects mono">
                {objects === 1 ? "object" : "objects"} · {formatNumber(rows)} observations
              </span>
              <p className="results-band__rule">{band.rule}</p>
              <div className="results-band__chips">
                {members.length === 0 ? (
                  <span className="results-band__none">none</span>
                ) : (
                  members.slice(0, 12).map((track) => (
                    <Link
                      className="results-chip mono"
                      key={track.track_id}
                      title={appearanceLabel(track.appearance)}
                      to={`/tracks?session=${encodeURIComponent(sessionId)}&track=${track.track_id}`}
                    >
                      {classLabel(track.appearance)
                        ? `${classLabel(track.appearance)} · ${trackLabel(track.track_id)}`
                        : trackLabel(track.track_id)}
                    </Link>
                  ))
                )}
                {members.length > 12 ? (
                  <span className="results-band__none">
                    +{formatNumber(members.length - 12)}
                  </span>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <div className="results-table-wrap">
          <table className="results-table">
            <caption className="sr-only">
              Verdict, elevated rows and peak score for every tracked object
            </caption>
            <thead>
              <tr>
                <th scope="col">Object</th>
                <th scope="col">Verdict</th>
                <th scope="col">Elevated rows</th>
                <th scope="col">Peak score</th>
                <th scope="col">Observations</th>
                <th scope="col">
                  <span className="sr-only">Open object</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((track) => {
                const level = track.observed.worst_level;
                const band = BANDS.find((item) => item.level === level);
                const score = track.motion.max_fused_score;
                return (
                  <tr className={`results-row results-row--${level.toLowerCase()}`} key={track.track_id}>
                    <th scope="row">
                      <span className="results-row__kind">{appearanceLabel(track.appearance)}</span>
                      <span className="results-row__id mono">{trackLabel(track.track_id)}</span>
                    </th>
                    <td>
                      <span className={`verdict verdict--${level.toLowerCase()}`}>
                        {band?.short ?? level}
                      </span>
                    </td>
                    <td className="mono">{formatNumber(track.observed.anomalies)}</td>
                    <td className="mono">{score === null ? "—" : score.toFixed(3)}</td>
                    <td className="mono">{formatNumber(track.observed.observations)}</td>
                    <td className="results-row__action">
                      <Link
                        className="results-row__open"
                        to={`/tracks?session=${encodeURIComponent(sessionId)}&track=${track.track_id}`}
                        aria-label={`Open ${trackLabel(track.track_id)} in Track Explorer`}
                      >
                        <ArrowRightIcon width={12} height={12} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <section className="results-board" aria-label={title}>
      <SectionHeader
        title={title}
        meta={
          tracks.length > 0
            ? `${formatNumber(total)} objects · ${formatNumber(observations)} observations${
                total > tracks.length
                  ? ` · ${formatNumber(tracks.length)} classified`
                  : ""
              }`
            : "one verdict per object"
        }
        level={3}
      />
      {body}
    </section>
  );
}

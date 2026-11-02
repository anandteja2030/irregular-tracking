import { useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { FilmIcon, LockIcon, RefreshIcon } from "../components/icons";
import {
  formatBytes,
  formatDuration,
  formatFps,
  formatNumber,
  formatResolution,
  truncateMiddle,
} from "../lib/format";

export function VideoStudioPage() {
  const sources = useResource(api.sources, { pollMs: 60_000 });
  const config = useResource(api.config);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const list = sources.data?.sources ?? [];
  const selected =
    list.find((source) => source.path === selectedPath) ?? list[0] ?? null;

  const analytics = config.data?.anomaly;
  const video = config.data?.video;

  return (
    <>
      <PageHeader
        eyebrow="Intake"
        title="Video Studio"
        lede="The source inventory the engine actually sees, with measured metadata for every decodable clip. Analysis intake will bind to this surface."
        aside={
          <>
            <span className="pill pill--warn">
              <LockIcon width={11} height={11} />
              Intake locked
            </span>
            <button
              type="button"
              className={`btn ${sources.refreshing ? "is-spinning" : ""}`}
              onClick={sources.reload}
            >
              <span className="btn__icon">
                <RefreshIcon width={13} height={13} />
              </span>
              Rescan
            </button>
          </>
        }
      />

      <div className="layout-main-aside">
        <div className="stack gap-14">
        <Panel
          title="Source inventory"
          sub={sources.data ? `${sources.data.count} clips · ${sources.data.valid} decodable` : "samples directory"}
          bodyClassName="panel__body--flush"
        >
          {sources.status === "error" ? (
            <div className="panel__body">
              <ErrorState error={sources.error} onRetry={sources.reload} />
            </div>
          ) : sources.status === "loading" && !sources.data ? (
            <div className="panel__body">
              <LoadingRows rows={5} label="Loading source inventory" />
            </div>
          ) : list.length === 0 ? (
            <div className="panel__body">
              <EmptyState
                title="No footage available"
                body="Nothing in the samples directory is a decodable video. Add a clip there and rescan."
                glyph={<FilmIcon width={17} height={17} />}
                code={sources.data?.directory}
              />
            </div>
          ) : (
            <ul className="source-list">
              {list.map((source) => {
                const active = selected?.path === source.path;
                return (
                  <li key={source.path}>
                    <button
                      type="button"
                      className={`source-item ${active ? "is-selected" : ""}`}
                      onClick={() => setSelectedPath(source.path)}
                      aria-pressed={active}
                    >
                      <span className="source-item__glyph">
                        <FilmIcon width={15} height={15} />
                      </span>
                      <span className="source-item__body">
                        <span className="source-item__line">
                          <span className="source-item__name">{source.name}</span>
                          {source.synthetic && <span className="tag">synthetic</span>}
                          {!source.valid && <span className="pill pill--bad">unreadable</span>}
                        </span>
                        <span className="source-item__meta">
                          {formatResolution(source.width, source.height)}
                          <span className="sep">/</span>
                          {formatFps(source.fps)}
                          <span className="sep">/</span>
                          {formatDuration(source.duration_s)}
                          <span className="sep">/</span>
                          {formatBytes(source.bytes)}
                        </span>
                      </span>
                      <span className="source-item__index mono">
                        {String(list.indexOf(source) + 1).padStart(2, "0")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <footer className="panel__foot">
            <span className="dot dot--live" />
            {sources.data ? truncateMiddle(sources.data.directory, 44) : "resolving directory"}
          </footer>
        </Panel>

        <Panel
          title="Preview stage"
          sub={selected ? selected.name : "awaiting selection"}
          actions={<span className="tag">{selected ? formatResolution(selected.width, selected.height) : "—"}</span>}
          bodyClassName="panel__body--flush"
          foot={
            <>
              <span className="dot dot--warn" />
              frame transport connects with the session media layer
            </>
          }
        >
          <div className="stage">
            <span className="stage__grid" aria-hidden="true" />
            <span className="stage__corner stage__corner--tl" aria-hidden="true" />
            <span className="stage__corner stage__corner--tr" aria-hidden="true" />
            <span className="stage__corner stage__corner--bl" aria-hidden="true" />
            <span className="stage__corner stage__corner--br" aria-hidden="true" />
            <div className="stage__center">
              <span className="stage__res">{selected ? formatResolution(selected.width, selected.height) : "—"}</span>
              <span className="stage__meta">
                {selected ? `${formatFps(selected.fps)} · ${formatDuration(selected.duration_s)} · ${formatNumber(selected.frames)} frames` : "choose a clip to inspect"}
              </span>
              <span className="stage__hint">decoded frames arrive with session media</span>
            </div>
            <span className="stage__timecode mono">00:00:00:00</span>
          </div>
        </Panel>
        </div>

        <div className="stack gap-14">
          <Panel title="Source telemetry" sub="Measured by OpenCV">
            {selected ? (
              <div className="stack gap-14">
                <div className="source-preview" aria-hidden="true">
                  <span className="source-preview__scan" />
                  <div className="source-preview__center">
                    <span className="source-preview__res mono">
                      {formatResolution(selected.width, selected.height)}
                    </span>
                    <span className="source-preview__sub">{formatFps(selected.fps)}</span>
                  </div>
                  <span className="source-preview__label mono">{selected.name}</span>
                </div>
                <div className="rows rows--tight">
                  <ReadRow label="File" value={selected.name} />
                  <ReadRow label="Frames" value={formatNumber(selected.frames)} />
                  <ReadRow label="FPS" value={selected.fps ? selected.fps.toFixed(2) : "—"} />
                  <ReadRow label="Duration" value={formatDuration(selected.duration_s)} />
                  <ReadRow label="Size" value={formatBytes(selected.bytes)} />
                  <ReadRow label="Kind" value={selected.kind} />
                </div>
              </div>
            ) : (
              <EmptyState compact title="No source selected" body="Choose a clip to inspect its metadata." />
            )}
          </Panel>

          <Panel title="Run envelope" sub="Read-only engine config">
            {config.status === "error" ? (
              <ErrorState error={config.error} onRetry={config.reload} compact />
            ) : config.status === "loading" && !config.data ? (
              <LoadingRows rows={4} label="Loading configuration" />
            ) : (
              <div className="rows rows--tight">
                <ReadRow
                  label="Resize"
                  value={
                    video?.frame_width && video?.frame_height
                      ? formatResolution(video.frame_width, video.frame_height)
                      : "native"
                  }
                />
                <ReadRow label="Process fps" value={video?.process_fps ? String(video.process_fps) : "source"} />
                <ReadRow label="Suspicious ≥" value={analytics ? analytics.threshold_suspicious.toFixed(2) : "—"} />
                <ReadRow label="Irregular ≥" value={analytics ? analytics.threshold_irregular.toFixed(2) : "—"} />
                <ReadRow label="Tracking age" value={config.data ? String(config.data.tracking.max_age) : "—"} />
              </div>
            )}
          </Panel>

          <div className="note">
            <span className="note__label">Intake</span>
            <p className="note__body">
              Source selection is wired to the live inventory. Starting a run stays locked until the
              studio intake is implemented — no job is submitted from this build.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="row__key">{label}</span>
      <span className="row__value">{value}</span>
    </div>
  );
}

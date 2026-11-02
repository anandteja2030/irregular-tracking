import { useRef, useState } from "react";
import type { DragEvent } from "react";
import type { UploadRecord } from "../lib/types";
import { ACCEPT_ATTRIBUTE, ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES } from "../lib/studio";
import { formatBytes, formatDuration, formatFps, formatNumber, formatResolution } from "../lib/format";
import { AlertIcon, FilmIcon, PlayIcon, RefreshIcon, UploadIcon } from "./icons";

export interface UploadState {
  status: "idle" | "uploading" | "done" | "error";
  record: UploadRecord | null;
  progress: number | null;
  error: unknown;
}

interface StudioIntakeProps {
  upload: UploadState;
  fileError: string | null;
  startError: string | null;
  duplicateJobId: string | null;
  busy: boolean;
  onFile: (file: File) => void;
  onCancelUpload: () => void;
  onAnalyse: () => void;
  onDiscard: () => void;
  onOpenJob: () => void;
}

/** Upload surface: drop target, picker, measured metadata and the analysis
 * trigger. Every number shown here comes from the API's probe of the file. */
export function StudioIntake({
  upload,
  fileError,
  startError,
  duplicateJobId,
  busy,
  onFile,
  onCancelUpload,
  onAnalyse,
  onDiscard,
  onOpenJob,
}: StudioIntakeProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const take = (file: File | undefined | null) => {
    if (file) onFile(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer?.files?.[0]);
  };

  const record = upload.record;
  const uploading = upload.status === "uploading";

  return (
    <div className="intake">
      <div
        className={`dropzone ${dragging ? "is-dragging" : ""} ${uploading ? "is-busy" : ""}`.trim()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={ACCEPT_ATTRIBUTE}
          aria-label="Video file"
          onChange={(event) => {
            take(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <div className="dropzone__glyph">
          <UploadIcon width={19} height={19} />
        </div>
        <p className="dropzone__title">
          {uploading ? "Uploading to the analysis service" : "Drop a clip here, or choose a file"}
        </p>
        <p className="dropzone__hint">
          {ACCEPTED_EXTENSIONS.join(" · ")} — up to {formatBytes(MAX_UPLOAD_BYTES)} (the API enforces its own cap)
        </p>
        <div className="dropzone__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => inputRef.current?.click()}
            disabled={uploading || busy}
          >
            Choose file
          </button>
          <span className="dropzone__meta mono">post /api/v1/videos/upload</span>
        </div>
        {dragging && <span className="dropzone__overlay">Release to upload</span>}
      </div>

      {(fileError || startError || upload.status === "error") && (
        <div className="alert alert--bad" role="alert">
          <AlertIcon width={14} height={14} />
          <div className="alert__body">
            <p className="alert__title">Upload rejected</p>
            <p className="alert__text">
              {fileError ??
                startError ??
                (upload.error instanceof Error ? upload.error.message : "The upload failed.")}
            </p>
          </div>
        </div>
      )}

      {duplicateJobId && (
        <div className="alert alert--warn" role="status">
          <AlertIcon width={14} height={14} />
          <div className="alert__body">
            <p className="alert__title">That exact job is already running</p>
            <p className="alert__text">
              The API refuses a duplicate so two runs cannot write the same source twice.
            </p>
          </div>
          <button type="button" className="btn btn--quiet btn--sm" onClick={onOpenJob}>
            Show that job
          </button>
        </div>
      )}

      {uploading && (
        <div className="upload-progress">
          <div className="upload-progress__head">
            <span className="upload-progress__label">Bytes sent</span>
            <span className="mono">{upload.progress === null ? "—" : `${upload.progress}%`}</span>
          </div>
          <div className="bar">
            <span
              className="bar__fill"
              style={{ width: `${upload.progress ?? 0}%` }}
              aria-hidden="true"
            />
          </div>
          <div className="upload-progress__foot">
            <span className="hint">The file is streamed to disk; decoding is verified server-side.</span>
            <button type="button" className="btn btn--quiet btn--sm" onClick={onCancelUpload}>
              Cancel upload
            </button>
          </div>
        </div>
      )}

      {record && (
        <div className="clip">
          <div className="clip__head">
            <span className="clip__glyph">
              <FilmIcon width={15} height={15} />
            </span>
            <div className="clip__titles">
              <span className="clip__name" title={record.filename}>
                {record.filename}
              </span>
              <span className="clip__meta mono">
                {formatBytes(record.bytes)} · {formatResolution(record.video.width, record.video.height)} ·{" "}
                {formatFps(record.video.fps)} · {formatDuration(record.video.duration_s)}
              </span>
            </div>
            <span className="pill pill--ok">Validated</span>
          </div>
          <div className="rows rows--tight">
            <div className="row">
              <span className="row__key">Frames</span>
              <span className="row__value">{formatNumber(record.video.frames)}</span>
            </div>
            <div className="row">
              <span className="row__key">Content type</span>
              <span className="row__value">{record.content_type ?? "not declared"}</span>
            </div>
            <div className="row">
              <span className="row__key">Upload id</span>
              <span className="row__value mono">{record.upload_id}</span>
            </div>
            <div className="row">
              <span className="row__key">Received</span>
              <span className="row__value">{record.created_ts.replace("T", " ").replace("+00:00", " UTC")}</span>
            </div>
          </div>
          <div className="clip__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={onAnalyse}
              disabled={busy}
            >
              <span className="btn__icon">
                <PlayIcon width={12} height={12} />
              </span>
              {busy ? "Analysis running" : "Start analysis"}
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <span className="btn__icon">
                <RefreshIcon width={12} height={12} />
              </span>
              Replace clip
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={onDiscard} disabled={busy}>
              Discard
            </button>
          </div>
        </div>
      )}

      {upload.status === "done" && record && (
        <p className="hint hint--flush">
          Uploaded files are removed by the API after its retention window; the analysis result is persisted
          separately as a session.
        </p>
      )}
    </div>
  );
}

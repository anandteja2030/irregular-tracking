import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../lib/api";
import type { PreviewFrameInfo } from "../lib/types";
import { formatBytes, formatNumber } from "../lib/format";
import { FilmIcon } from "./icons";

type State = "idle" | "building" | "ready" | "error";

interface AnnotatedRecapProps {
  sessionId: string | null;
  frames: PreviewFrameInfo[];
  /** Source fps, so each retained preview is shown for the frames it covers. */
  fps: number | null;
  stride: number | null;
}

const MIN_FRAME_SECONDS = 0.09;
const MAX_FRAME_SECONDS = 0.4;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("A retained preview could not be loaded."));
    image.src = src;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

/**
 * Builds an annotated recap video in the browser from the pipeline's own
 * annotated preview frames.
 *
 * The server never encodes video; it retains annotated JPEGs. This component
 * paints those exact frames onto a canvas with their frame number and clock,
 * records the canvas with MediaRecorder and offers the result as a local WebM
 * download. If the browser cannot record, it says so and never pretends a
 * file exists.
 */
export function AnnotatedRecap({ sessionId, frames, fps, stride }: AnnotatedRecapProps) {
  const [state, setState] = useState<State>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, [sessionId]);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const perFrameSeconds = (() => {
    const source = fps && fps > 0 ? fps : 30;
    const span = stride && stride > 0 ? stride : 6;
    return Math.min(MAX_FRAME_SECONDS, Math.max(MIN_FRAME_SECONDS, span / source));
  })();

  const supported =
    frames.length > 0 &&
    typeof document !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickMimeType() !== null;

  async function build() {
    if (!sessionId || frames.length === 0) return;
    const mimeType = pickMimeType();
    if (!mimeType) {
      setState("error");
      setMessage("This browser cannot record a canvas stream, so a recap cannot be built here.");
      return;
    }
    setState("building");
    setProgress(0);
    setMessage(null);
    setBytes(null);
    if (url) {
      URL.revokeObjectURL(url);
      setUrl(null);
    }

    try {
      const first = await loadImage(mediaUrl(frames[0].annotated_url));
      const width = Math.min(1280, first.naturalWidth || 1280);
      const scale = width / (first.naturalWidth || width);
      const height = Math.round((first.naturalHeight || 720) * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("A 2D canvas context is unavailable in this browser.");

      const stream = canvas.captureStream(12);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_200_000,
      });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      const finished = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      });
      recorder.start();

      for (let index = 0; index < frames.length; index += 1) {
        if (cancelled.current) break;
        const frame = frames[index];
        const image = index === 0 ? first : await loadImage(mediaUrl(frame.annotated_url));
        context.drawImage(image, 0, 0, width, height);

        // A subtle lower-third keeps the pipeline's own annotations readable.
        const barHeight = Math.max(26, Math.round(height * 0.062));
        context.fillStyle = "rgba(4, 8, 16, 0.72)";
        context.fillRect(0, height - barHeight, width, barHeight);
        context.fillStyle = "#d7e6ff";
        context.font = `${Math.round(barHeight * 0.44)}px ui-monospace, monospace`;
        context.textBaseline = "middle";
        context.fillText(
          `F${String(frame.frame).padStart(5, "0")}  ·  ${frame.ts_s.toFixed(2)}s`,
          12,
          height - barHeight / 2,
        );
        context.fillStyle = "#6fe3ff";
        context.textAlign = "right";
        context.fillText(
          `${index + 1}/${frames.length}  retained annotated preview`,
          width - 12,
          height - barHeight / 2,
        );
        context.textAlign = "left";

        setProgress(Math.round(((index + 1) / frames.length) * 100));
        await sleep(perFrameSeconds * 1000);
      }

      recorder.stop();
      const blob = await finished;
      if (cancelled.current) return;
      if (blob.size === 0) throw new Error("The recorder produced an empty file.");
      setBytes(blob.size);
      setUrl(URL.createObjectURL(blob));
      setState("ready");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The recap could not be built.");
    }
  }

  if (frames.length === 0) return null;

  const filename = `${sessionId ?? "session"}_annotated_recap.webm`;

  return (
    <section className="recap" aria-labelledby="recap-title">
      <div className="recap__head">
        <span className="note__label" id="recap-title">
          <FilmIcon width={11} height={11} /> Annotated recap
        </span>
        <span className="tag mono">
          {formatNumber(frames.length)} previews · {perFrameSeconds.toFixed(2)}s each
        </span>
      </div>
      <p className="recap__copy">
        The engine stores annotated preview frames, not an encoded video. This builds a recap from
        those exact annotated frames at {perFrameSeconds < 0.15 ? "near" : "a readable"} playback
        speed, entirely in this browser, and downloads it as WebM. Nothing is re-detected or
        re-drawn.
      </p>

      {state === "ready" && url ? (
        <div className="recap__result">
          <video className="recap__video" src={url} controls playsInline preload="metadata" />
          <div className="recap__actions">
            <a className="btn btn--primary btn--sm" href={url} download={filename}>
              Download recap{bytes ? ` · ${formatBytes(bytes)}` : " · WebM"}
            </a>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => void build()}>
              Rebuild
            </button>
          </div>
        </div>
      ) : (
        <div className="recap__actions">
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => void build()}
            disabled={!supported || state === "building"}
          >
            {state === "building" ? `Building recap… ${progress}%` : "Build annotated recap"}
          </button>
          {!supported && (
            <span className="hint">
              Recording is unavailable in this browser; individual annotated frames remain
              viewable above.
            </span>
          )}
          {state === "building" && (
            <span className="recap__bar" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </span>
          )}
        </div>
      )}

      {state === "error" && message && (
        <p className="recap__error" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}

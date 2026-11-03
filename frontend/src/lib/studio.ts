/** Pure helpers for the Video Studio: client-side intake checks, job labels
 * and the progress socket URL. Nothing here invents a value the API does not
 * send — unknown totals stay unknown and unmeasured progress stays null. */
import { API_BASE } from "./api";
import type { JobSnapshot, JobState } from "./types";

/** Fallback list for older API builds; current builds report this via /system. */
export const ACCEPTED_EXTENSIONS = [".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm"] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(",");

/** Fallback cap for older API builds (`NEURAL_MAX_UPLOAD_MB` defaults to 256).
 * Current builds report the enforced cap via /system; the server still rejects
 * an oversized stream with its own message if /system is unavailable. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

const ACCEPTED_MIME = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/webm",
  "video/mp4v-es",
  "application/octet-stream",
]);

export interface VideoIntakeLimits {
  extensions?: readonly string[];
  mimeTypes?: readonly string[];
  maxUploadBytes?: number;
}

function normalizedExtensions(extensions?: readonly string[]): string[] {
  const values = (extensions ?? ACCEPTED_EXTENSIONS)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  return values.length > 0 ? values : [...ACCEPTED_EXTENSIONS];
}

export function acceptAttribute(extensions?: readonly string[]): string {
  return normalizedExtensions(extensions).join(",");
}

function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} MB`;
}

export interface FileLike {
  name: string;
  size: number;
  type?: string;
}

export interface FileCheck {
  ok: boolean;
  error: string | null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Client-side gate only: the API repeats every check after the bytes land. */
export function validateVideoFile(file: FileLike, limits?: VideoIntakeLimits): FileCheck {
  const extensions = normalizedExtensions(limits?.extensions);
  const maxBytes = limits?.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const mimeTypes = new Set(
    (limits?.mimeTypes && limits.mimeTypes.length > 0 ? limits.mimeTypes : [...ACCEPTED_MIME]).map(
      (value) => value.trim().toLowerCase(),
    ),
  );
  const extension = extensionOf(file.name ?? "");
  if (!extension) {
    return { ok: false, error: `That file has no extension, so its container cannot be trusted. Pick ${extensions.join(", ")}.` };
  }
  if (!extensions.includes(extension)) {
    return {
      ok: false,
      error: `Unsupported format "${extension}". Accepted: ${extensions.join(", ")}.`,
    };
  }
  if (file.size <= 0) {
    return { ok: false, error: "That file is empty — there is nothing to analyse." };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `That clip is ${(file.size / (1024 * 1024)).toFixed(0)} MB; the API's current cap is ${megabytes(maxBytes)}.`,
    };
  }
  const type = (file.type ?? "").split(";")[0].trim().toLowerCase();
  if (type && !mimeTypes.has(type)) {
    return { ok: false, error: `The browser reports "${type}", which is not a supported video content type.` };
  }
  return { ok: true, error: null };
}

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  opening: "Opening source",
  processing: "Processing frames",
  persisting: "Persisting session",
  cancellation_requested: "Cancellation requested",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "—";
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, " ");
}

export function isTerminalState(state: JobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function isActiveState(state: JobState): boolean {
  return state === "queued" || state === "running" || state === "cancellation_requested";
}

/** Frames line: the total is `null` when the container never reported one. */
export function progressText(job: Pick<JobSnapshot, "progress">): string {
  const { processed, total } = job.progress;
  if (total && total > 0) return `${processed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} frames`;
  return `${processed.toLocaleString("en-US")} frames · total unreported`;
}

export function percentText(job: Pick<JobSnapshot, "progress">): string {
  return job.progress.percent === null ? "—" : `${job.progress.percent.toFixed(1)}%`;
}

/**
 * Progress WebSocket for one job, derived from the same base the REST calls
 * use. A relative base resolves against the current origin so the Vite proxy
 * (or a same-origin deployment) carries it without CORS.
 */
export function jobSocketUrl(
  jobId: string,
  base: string = API_BASE,
  origin: string = typeof window !== "undefined" ? window.location.origin : "http://localhost",
): string {
  const trimmed = base.replace(/\/+$/, "");
  const path = `${trimmed}/jobs/${encodeURIComponent(jobId)}/ws`;
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Clamped step through the retained preview frame list. */
export function stepPreviewFrame(length: number, index: number, delta: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

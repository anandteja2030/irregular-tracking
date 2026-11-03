/** Single request layer for the existing FastAPI backend.
 *
 * The console talks to the versioned mirror (`/api/v1`) so the unversioned
 * legacy surface stays untouched. In development Vite proxies the prefix to
 * `127.0.0.1:8000`; a deployment can override it with `VITE_API_BASE_URL`.
 *
 * Everything the console needs from the wire lives here: no component builds
 * its own URL, headers or error handling.
 */
import type {
  AnomalyDetail,
  AnomalyList,
  ApiErrorEnvelope,
  EngineConfig,
  EvaluationResponse,
  Health,
  JobList,
  JobSnapshot,
  MediaResponse,
  ObservationItem,
  SceneResponse,
  SessionDetail,
  SessionList,
  SessionSummary,
  SourcesResponse,
  SystemStatus,
  TrackDetail,
  TrackFramesResponse,
  TrackList,
  TrajectoryResponse,
  UploadRecord,
} from "./types";

const RAW_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
export const API_BASE = RAW_BASE.replace(/\/+$/, "");

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    method = "GET",
    body,
    headers,
  } = options;
  const budget = timeoutSignal(timeoutMs);
  const combined =
    signal && typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any([signal, budget])
      : budget;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Accept: "application/json", ...headers },
      body,
      signal: combined,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError(
      0,
      "network_error",
      "The analysis service is unreachable on this origin.",
      cause,
    );
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw errorFromPayload(response.status, payload, response.statusText);
  if (payload === null) {
    throw new ApiError(
      response.status,
      "invalid_payload",
      "The service returned a response that is not valid JSON.",
    );
  }

  return payload as T;
}

/** Maps any non-2xx body onto `ApiError`; the backend envelope when present. */
export function errorFromPayload(
  status: number,
  payload: unknown,
  statusText = "",
): ApiError {
  if (isErrorEnvelope(payload)) {
    // The API puts error context as siblings of code/message (for example the
    // existing job id on a 409). Keep it reachable through `detail`.
    const { code, message, detail, ...extra } = payload.error as {
      code: string;
      message: string;
      detail?: unknown;
      [key: string]: unknown;
    };
    const context = detail ?? (Object.keys(extra).length > 0 ? extra : undefined);
    return new ApiError(status, code, message, context);
  }
  return new ApiError(
    status,
    `http_${status}`,
    `${status} ${statusText || "request failed"}`.trim(),
  );
}

type QueryValue = string | number | boolean | null | undefined;

/** Builds a query string, dropping empty filters so the API sees only intent. */
export function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  // Sorted keys keep URLs stable across renders (and cache-friendly).
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

const sessionPath = (sessionId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}`;

export type SessionDownloadKind = "events" | "tracks" | "report";

export interface SessionDownload {
  blob: Blob;
  filename: string;
  rowCount: number | null;
  contentType: string | null;
}

function downloadFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return plain?.trim() || fallback;
}

/** Fetch an existing export as a blob so the page can show loading, empty,
 * success and failure states instead of navigating away through a bare link. */
export async function downloadSessionExport(
  sessionId: string,
  kind: SessionDownloadKind,
  signal?: AbortSignal,
): Promise<SessionDownload> {
  const base = sessionPath(sessionId);
  const path =
    kind === "report"
      ? `${base}/report?download=true`
      : `${base}/export/csv?dataset=${kind}`;
  const budget = timeoutSignal(120_000);
  const combined =
    signal && typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any([signal, budget])
      : budget;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: kind === "report" ? "text/markdown" : "text/csv" },
      signal: combined,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError(
      0,
      "network_error",
      "The export could not reach the analysis service.",
      cause,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
    }
    throw errorFromPayload(response.status, payload, response.statusText);
  }

  const header = response.headers.get("x-row-count");
  const parsed = header === null ? Number.NaN : Number.parseInt(header, 10);
  return {
    blob: await response.blob(),
    filename: downloadFilename(
      response.headers.get("content-disposition"),
      kind === "report" ? `${sessionId}_report.md` : `${sessionId}_${kind}.csv`,
    ),
    rowCount: Number.isFinite(parsed) ? parsed : null,
    contentType: response.headers.get("content-type"),
  };
}

/**
 * Uploads go through XMLHttpRequest instead of fetch: only XHR reports
 * upload progress, and the bar must reflect bytes actually sent.
 */
export function uploadVideo(
  file: File,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<UploadRecord> {
  const { onProgress, signal } = options;
  return new Promise<UploadRecord>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => xhr.abort();

    xhr.open("POST", `${API_BASE}/videos/upload`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(100, Math.round((100 * event.loaded) / event.total)));
      }
    };
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
      } catch {
        payload = null;
      }
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300 && payload !== null) {
          resolve(payload as UploadRecord);
        } else {
          reject(errorFromPayload(xhr.status, payload, xhr.statusText));
        }
      });
    };
    xhr.onerror = () =>
      finish(() =>
        reject(
          new ApiError(
            0,
            "network_error",
            "The upload could not reach the analysis service.",
          ),
        ),
      );
    xhr.onabort = () =>
      finish(() => reject(new DOMException("Upload cancelled", "AbortError")));

    signal?.addEventListener("abort", onAbort, { once: true });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const api = {
  health: (signal?: AbortSignal) =>
    request<Health>("/health", { signal, timeoutMs: 6_000 }),
  system: (signal?: AbortSignal) => request<SystemStatus>("/system", { signal }),
  sources: (signal?: AbortSignal) =>
    request<SourcesResponse>("/sources", { signal, timeoutMs: 30_000 }),
  config: (signal?: AbortSignal) => request<EngineConfig>("/config", { signal }),

  sessions: (
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) => request<SessionList>(`/sessions${queryString(params)}`, { signal }),
  session: (sessionId: string, signal?: AbortSignal) =>
    request<SessionDetail>(sessionPath(sessionId), { signal }),
  sessionSummary: (sessionId: string, signal?: AbortSignal) =>
    request<SessionSummary>(`${sessionPath(sessionId)}/summary`, { signal }),

  tracks: (
    sessionId: string,
    params: {
      level?: string;
      min_events?: number;
      sort?: string;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ) =>
    request<TrackList>(`${sessionPath(sessionId)}/tracks${queryString(params)}`, {
      signal,
    }),
  track: (sessionId: string, trackId: number, signal?: AbortSignal) =>
    request<TrackDetail>(
      `${sessionPath(sessionId)}/tracks/${trackId}`,
      { signal },
    ),
  trackTrajectory: (sessionId: string, trackId: number, signal?: AbortSignal) =>
    request<TrajectoryResponse>(
      `${sessionPath(sessionId)}/tracks/${trackId}/trajectory`,
      { signal },
    ),
  trackObservations: (
    sessionId: string,
    trackId: number,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    request<{ total: number; count: number; observations: ObservationItem[] }>(
      `${sessionPath(sessionId)}/tracks/${trackId}/observations${queryString(params)}`,
      { signal },
    ),

  trackFrames: (
    sessionId: string,
    trackId: number,
    params: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    request<TrackFramesResponse>(
      `${sessionPath(sessionId)}/tracks/${trackId}/frames${queryString(params)}`,
      { signal },
    ),

  anomalies: (
    sessionId: string,
    params: {
      severity?: string;
      track_id?: number;
      event_type?: string;
      min_score?: number;
      from_frame?: number;
      to_frame?: number;
      sort?: string;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ) =>
    request<AnomalyList>(
      `${sessionPath(sessionId)}/anomalies${queryString(params)}`,
      { signal },
    ),

  anomalyDetail: (sessionId: string, eventId: number, signal?: AbortSignal) =>
    request<AnomalyDetail>(
      `${sessionPath(sessionId)}/anomalies/${eventId}`,
      { signal },
    ),

  scene: (sessionId: string, signal?: AbortSignal) =>
    request<SceneResponse>(`${sessionPath(sessionId)}/scene`, { signal }),
  media: (sessionId: string, signal?: AbortSignal) =>
    request<MediaResponse>(`${sessionPath(sessionId)}/media`, { signal }),

  /* -------------------------------------------------------- video studio */
  uploadVideo,
  createJob: (
    source: { kind: "sample" | "upload"; ref: string },
    options: { maxFrames?: number | null; signal?: AbortSignal } = {},
  ) =>
    request<{ job: JobSnapshot }>("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        max_frames: options.maxFrames ?? null,
      }),
      signal: options.signal,
    }),
  jobs: (params: { status?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal) =>
    request<JobList>(`/jobs${queryString(params)}`, { signal }),
  job: (jobId: string, signal?: AbortSignal) =>
    request<{ job: JobSnapshot }>(`/jobs/${encodeURIComponent(jobId)}`, { signal }),
  cancelJob: (jobId: string, signal?: AbortSignal) =>
    request<{ job: JobSnapshot }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      signal,
    }),
  evaluation: (sessionId: string, signal?: AbortSignal) =>
    request<EvaluationResponse>(`${sessionPath(sessionId)}/evaluation`, { signal }),
  downloadExport: downloadSessionExport,
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected client error.";
}

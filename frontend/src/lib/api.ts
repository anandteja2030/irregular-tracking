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
  AnomalyList,
  ApiErrorEnvelope,
  EngineConfig,
  EvaluationResponse,
  Health,
  ObservationItem,
  SceneResponse,
  SessionItem,
  SessionList,
  SessionSummary,
  SourcesResponse,
  SystemStatus,
  TrackDetail,
  TrackList,
  TrajectoryResponse,
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

async function request<T>(
  path: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const budget = timeoutSignal(timeoutMs);
  const combined =
    signal && typeof AbortSignal !== "undefined" && "any" in AbortSignal
      ? AbortSignal.any([signal, budget])
      : budget;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
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

  if (!response.ok) {
    if (isErrorEnvelope(payload)) {
      throw new ApiError(
        response.status,
        payload.error.code,
        payload.error.message,
        payload.error.detail,
      );
    }
    throw new ApiError(
      response.status,
      `http_${response.status}`,
      `${response.status} ${response.statusText || "request failed"}`,
    );
  }

  if (payload === null) {
    throw new ApiError(
      response.status,
      "invalid_payload",
      "The service returned a response that is not valid JSON.",
    );
  }

  return payload as T;
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
    request<SessionItem>(sessionPath(sessionId), { signal }),
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

  anomalies: (
    sessionId: string,
    params: {
      severity?: string;
      track_id?: number;
      min_score?: number;
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

  scene: (sessionId: string, signal?: AbortSignal) =>
    request<SceneResponse>(`${sessionPath(sessionId)}/scene`, { signal }),
  evaluation: (sessionId: string, signal?: AbortSignal) =>
    request<EvaluationResponse>(`${sessionPath(sessionId)}/evaluation`, { signal }),
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected client error.";
}

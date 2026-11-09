import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { isTerminalState, jobSocketUrl } from "../lib/studio";
import type { JobSnapshot } from "../lib/types";

export type JobStreamState =
  | "idle"
  | "connecting"
  | "live"
  | "polling"
  | "done"
  | "lost"
  | "error";

export interface JobStream {
  job: JobSnapshot | null;
  state: JobStreamState;
  error: unknown;
  /** Which transport last delivered a snapshot, for honest status copy. */
  refresh: () => void;
}

const POLL_MS = 2_000;
const MAX_SOCKET_RETRIES = 3;

/**
 * Live job snapshots from the existing progress socket, with a labelled
 * polling fallback when the socket cannot stay open. A job the API process no
 * longer knows resolves to `lost` — never to a fabricated completion.
 */
export function useJobStream(jobId: string | null): JobStream {
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [state, setState] = useState<JobStreamState>("idle");
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const jobRef = useRef<JobSnapshot | null>(null);

  useEffect(() => {
    if (!jobId) {
      jobRef.current = null;
      setJob(null);
      setState("idle");
      setError(null);
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;
    let retries = 0;
    const controller = new AbortController();

    jobRef.current = null;
    setJob(null);
    setError(null);
    setState("connecting");

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    const apply = (next: JobSnapshot) => {
      if (disposed) return;
      jobRef.current = next;
      setJob(next);
      if (isTerminalState(next.state)) {
        stopPolling();
        setState("done");
        socket?.close();
      }
    };

    const startPolling = () => {
      if (disposed || pollTimer !== undefined) return;
      setState("polling");
      pollTimer = window.setInterval(async () => {
        try {
          const payload = await api.job(jobId);
          apply(payload.job);
        } catch (cause) {
          if (disposed) return;
          if (cause instanceof ApiError && cause.status === 404) {
            stopPolling();
            setState("lost");
          }
        }
      }, POLL_MS);
    };

    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(jobSocketUrl(jobId));
      } catch {
        startPolling();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        if (disposed) return;
        retries = 0;
        setState("live");
      };
      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            type?: string;
            job?: JobSnapshot;
          };
          if (payload?.type === "job" && payload.job) apply(payload.job);
        } catch {
          /* a malformed frame is ignored; polling remains available */
        }
      };
      ws.onerror = () => {
        /* the close handler owns reconnection */
      };
      ws.onclose = () => {
        if (disposed) return;
        if (jobRef.current && isTerminalState(jobRef.current.state)) {
          setState("done");
          return;
        }
        retries += 1;
        if (retries <= MAX_SOCKET_RETRIES) {
          retryTimer = window.setTimeout(connect, 400 * 2 ** retries);
        } else {
          startPolling();
        }
      };
    };

    (async () => {
      try {
        const payload = await api.job(jobId, controller.signal);
        if (disposed) return;
        apply(payload.job);
        if (!isTerminalState(payload.job.state)) connect();
      } catch (cause) {
        if (disposed) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setState("lost");
          return;
        }
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause);
        setState("error");
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(retryTimer);
      stopPolling();
      socket?.close();
    };
  }, [jobId, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return { job, state, error, refresh };
}

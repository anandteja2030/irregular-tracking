import { useCallback, useEffect, useRef, useState } from "react";

export type ResourceStatus = "loading" | "ready" | "error";

export interface ResourceState<T> {
  status: ResourceStatus;
  data: T | null;
  error: unknown;
  /** Epoch ms of the last successful load. */
  updatedAt: number | null;
  /** True while a background refresh runs over existing data. */
  refreshing: boolean;
  reload: () => void;
}

export interface ResourceOptions {
  /** Background refresh interval in ms; omitted means load once. */
  pollMs?: number;
  /** Skip the initial load (for example, until a selection exists). */
  enabled?: boolean;
  /** Identity of the resource (session/track). Changing it reloads and
   * clears the previous payload so a stale selection is never rendered. */
  key?: string;
}

/**
 * Load one API resource with cancellation, optional polling and a manual
 * reload. Previous data survives a refresh so panels never flash empty.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options: ResourceOptions = {},
): ResourceState<T> {
  const { pollMs, enabled = true, key } = options;
  const [status, setStatus] = useState<ResourceStatus>(
    enabled ? "loading" : "loading",
  );
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const keyRef = useRef(key);

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setData(null);
      setStatus("loading");
      setError(null);
    }
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;

    const run = async (background: boolean) => {
      if (background) setRefreshing(true);
      try {
        const result = await loadRef.current(controller.signal);
        if (cancelled || controller.signal.aborted) return;
        setData(result);
        setError(null);
        setStatus("ready");
        setUpdatedAt(Date.now());
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setError(cause);
        setStatus((current) => (current === "ready" ? "ready" : "error"));
        if (cause instanceof DOMException && cause.name === "AbortError") return;
      } finally {
        if (!cancelled && !controller.signal.aborted) setRefreshing(false);
      }
    };

    void run(false);

    let timer: number | undefined;
    if (pollMs && pollMs > 0) {
      timer = window.setInterval(() => void run(true), pollMs);
    }

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, pollMs, nonce, key]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { status, data, error, updatedAt, refreshing, reload };
}

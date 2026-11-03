import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import type { SessionItem } from "../lib/types";

/** The selection survives surface changes because it lives in the URL and a
 * tab-scoped mirror; a stale mirror is ignored as soon as the list disagrees. */
const STORAGE_KEY = "neural-command.session";
const POLL_MS = 45_000;

interface SessionContextValue {
  sessions: SessionItem[];
  total: number;
  status: "loading" | "ready" | "error";
  error: unknown;
  refreshing: boolean;
  selected: SessionItem | null;
  selectedId: string | null;
  select: (sessionId: string) => void;
  reload: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(sessionId: string) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, sessionId);
  } catch {
    /* storage disabled — the URL still carries the selection */
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const list = useResource((signal) => api.sessions({ limit: 100 }, signal), {
    pollMs: POLL_MS,
  });
  const sessions = useMemo(() => list.data?.sessions ?? [], [list.data]);
  const [storedId, setStoredId] = useState<string | null>(readStored);
  const locallySelected = useRef<string | null>(null);

  useEffect(() => {
    setStoredId(readStored());
  }, []);

  const paramId = searchParams.get("session");

  const selectedId = useMemo(() => {
    const known = (id: string | null): id is string =>
      Boolean(id) && sessions.some((session) => session.session === id);
    if (known(paramId)) return paramId;
    if (known(storedId)) return storedId;
    return sessions[0]?.session ?? null;
  }, [paramId, sessions, storedId]);

  const select = useCallback(
    (sessionId: string) => {
      locallySelected.current = sessionId;
      writeStored(sessionId);
      setStoredId(sessionId);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("session", sessionId);
          // Track, event and frame parameters describe the previous session.
          // Keeping them would invent an equivalent entity in the new run.
          next.delete("track");
          next.delete("event");
          next.delete("frame");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // A link can name a session this store no longer has. Fall back in state as
  // before, but also repair the URL so it does not keep advertising a run that
  // is not selected (and drop entity parameters scoped to that missing run).
  useEffect(() => {
    if (paramId === null || list.status !== "ready") return;
    if (sessions.some((session) => session.session === paramId)) {
      // Only consume the marker for this id; a stale effect for the previous
      // URL must not clear a newer selection made while it was pending.
      if (locallySelected.current === paramId) locallySelected.current = null;
      return;
    }
    // A completed job selects its new session before the list poll includes
    // it. Do not rewrite that selection back to an older run while waiting.
    if (locallySelected.current === paramId) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (selectedId) next.set("session", selectedId);
        else next.delete("session");
        next.delete("track");
        next.delete("event");
        next.delete("frame");
        return next;
      },
      { replace: true },
    );
  }, [list.status, paramId, selectedId, sessions, setSearchParams]);

  const selected = useMemo(
    () => sessions.find((session) => session.session === selectedId) ?? null,
    [selectedId, sessions],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      sessions,
      total: list.data?.total ?? 0,
      status: list.status,
      error: list.error,
      refreshing: list.refreshing,
      selected,
      selectedId,
      select,
      reload: list.reload,
    }),
    [list.data?.total, list.error, list.refreshing, list.reload, list.status, select, selected, selectedId, sessions],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}

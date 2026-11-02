import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
      writeStored(sessionId);
      setStoredId(sessionId);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("session", sessionId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

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

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import type { ResourceState } from "../hooks/useResource";
import type { Health } from "../lib/types";

const ApiHealthContext = createContext<ResourceState<Health> | null>(null);

/** Single liveness poll shared by the rail, the top bar and the overview. */
export function ApiHealthProvider({ children }: { children: ReactNode }) {
  const health = useResource(api.health, { pollMs: 10_000 });
  const value = useMemo(() => health, [health]);
  return <ApiHealthContext.Provider value={value}>{children}</ApiHealthContext.Provider>;
}

export function useApiHealth(): ResourceState<Health> {
  const value = useContext(ApiHealthContext);
  if (!value) throw new Error("useApiHealth must be used inside ApiHealthProvider");
  return value;
}

export type ApiPhase = "linking" | "online" | "offline";

export function apiPhase(health: ResourceState<Health>): ApiPhase {
  // A failed poll must win over the last healthy payload: keeping the previous
  // "ok" data is useful for rendering, but it is not current liveness.
  if (health.error || health.status === "error") return "offline";
  if (health.data && health.data.status === "ok") return "online";
  return "linking";
}

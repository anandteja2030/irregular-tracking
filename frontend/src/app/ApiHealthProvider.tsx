import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import type { ResourceState } from "../hooks/useResource";
import type { Health } from "../lib/types";

const ApiHealthContext = createContext<ResourceState<Health> | null>(null);

/** Single liveness poll shared by the rail, the top bar and the overview. */
export function ApiHealthProvider({ children }: { children: ReactNode }) {
  // Uptime changes on every poll, so each one re-renders every consumer of the
  // health context. Twenty seconds keeps the badge live without repainting the
  // whole workspace every ten.
  const health = useResource(api.health, { pollMs: 20_000 });
  const value = useMemo(() => health, [health]);
  return <ApiHealthContext.Provider value={value}>{children}</ApiHealthContext.Provider>;
}

export function useApiHealth(): ResourceState<Health> {
  const value = useContext(ApiHealthContext);
  if (!value) throw new Error("useApiHealth must be used inside ApiHealthProvider");
  return value;
}

export type ApiPhase = "linking" | "online" | "offline" | "local";

export function apiPhase(health: ResourceState<Health>): ApiPhase {
  // The in-browser backend answers this probe itself; it is running, but no
  // server API exists, so pages must not offer server-only flows.
  if (health.data?.backend === "local") return "local";
  // A failed poll must win over the last healthy payload: keeping the previous
  // "ok" data is useful for rendering, but it is not current liveness.
  if (health.error || health.status === "error") return "offline";
  if (health.data && health.data.status === "ok") return "online";
  return "linking";
}

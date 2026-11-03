import { describe, expect, it } from "vitest";
import type { ResourceState } from "../hooks/useResource";
import type { Health } from "../lib/types";
import { apiPhase } from "./ApiHealthProvider";

function state(overrides: Partial<ResourceState<Health>> = {}): ResourceState<Health> {
  return {
    status: "ready",
    data: { status: "ok", version: "1.0.0", uptime_s: 10 } as Health,
    error: null,
    updatedAt: Date.now(),
    refreshing: false,
    reload: () => {},
    ...overrides,
  };
}

describe("apiPhase", () => {
  it("reports offline after a failed poll even while old healthy data is retained", () => {
    expect(apiPhase(state({ status: "ready", error: new Error("connection lost") }))).toBe(
      "offline",
    );
  });

  it("reports online only for current healthy data", () => {
    expect(apiPhase(state())).toBe("online");
    expect(apiPhase(state({ status: "error", data: null, error: new Error("down") }))).toBe(
      "offline",
    );
    expect(apiPhase(state({ status: "loading", data: null }))).toBe("linking");
  });
});

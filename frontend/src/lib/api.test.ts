import { describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api.health", () => {
  it("returns the typed payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: "ok", version: "1.0.0", uptime_s: 12.5 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const health = await api.health();
    expect(health).toEqual({ status: "ok", version: "1.0.0", uptime_s: 12.5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/v1\/health$/);
  });
});

describe("error envelope", () => {
  it("maps the backend error body onto ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: "not_found", message: "Unknown session." } },
          404,
        ),
      ),
    );

    await expect(api.system()).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
      message: "Unknown session.",
    });
  });

  it("reports a network fault without a status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed to fetch")));

    const failure = await api.sources().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).code).toBe("network_error");
    expect((failure as ApiError).isNetwork).toBe(true);
  });

  it("rejects a non-JSON success body instead of returning junk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>proxy error</html>", { status: 200 })),
    );

    await expect(api.config()).rejects.toMatchObject({ code: "invalid_payload" });
  });
});

describe("query building", () => {
  it("drops empty filters and encodes session ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ total: 0, count: 0, limit: 20, offset: 0, severity: null, event_type: null, anomalies: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.anomalies("api 1/x", { severity: undefined, limit: 20, offset: 0, sort: "score" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(
      "/api/v1/sessions/api%201%2Fx/anomalies?limit=20&offset=0&sort=score",
    );
  });

  it("targets the session collection with paging params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ total: 0, count: 0, limit: 100, offset: 0, sessions: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.sessions({ limit: 100 });

    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v1/sessions?limit=100");
  });
});

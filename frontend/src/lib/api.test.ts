import { describe, expect, it, vi } from "vitest";
import { api, ApiError, downloadSessionExport } from "./api";

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

describe("job conflicts", () => {
  it("keeps the existing job id reachable on a duplicate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "job_duplicate",
              message: "An identical job is already running.",
              job_id: "job_existing9",
            },
          },
          409,
        ),
      ),
    );

    await expect(api.createJob({ kind: "sample", ref: "tiny_noise.mp4" })).rejects.toMatchObject({
      status: 409,
      code: "job_duplicate",
      detail: { job_id: "job_existing9" },
    });
  });
});

describe("session downloads", () => {
  it("returns the blob, server filename and row count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("frame\n0\n", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="run_events.csv"',
          "X-Row-Count": "1",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await downloadSessionExport("run 1/x", "events");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/v1/sessions/run%201%2Fx/export/csv?dataset=events",
    );
    expect(file.filename).toBe("run_events.csv");
    expect(file.rowCount).toBe(1);
    expect(file.contentType).toContain("text/csv");
    expect(file.blob.size).toBeGreaterThan(0);
  });

  it("requests the downloadable markdown report and surfaces API failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("# Report\n", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": "attachment; filename=run_report.md",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "internal", message: "Report generation failed." } },
          500,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const file = await downloadSessionExport("run_1", "report");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/v1/sessions/run_1/report?download=true",
    );
    expect(file.filename).toBe("run_report.md");
    expect(file.rowCount).toBeNull();

    await expect(downloadSessionExport("run_1", "report")).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "Report generation failed.",
    });
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

  it("posts a job with the selected source and no invented cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ job: { job_id: "job_1", state: "queued" } }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createJob({ kind: "upload", ref: "0123456789abcdef01234567" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/jobs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      source: { kind: "upload", ref: "0123456789abcdef01234567" },
      max_frames: null,
    });
  });

  it("cancels a job through its POST endpoint and reads preview media", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/media")
        ? jsonResponse({ session: "run_a", available: false, frames: [] })
        : jsonResponse({ job: { job_id: "job_1", state: "cancellation_requested" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.cancelJob("job_1");
    await api.media("run a");

    const [cancelUrl, cancelInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(cancelUrl).toBe("/api/v1/jobs/job_1/cancel");
    expect(cancelInit.method).toBe("POST");
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/v1/sessions/run%20a/media");
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

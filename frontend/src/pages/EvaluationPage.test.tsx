import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";
import type { EvaluationResponse } from "../lib/types";

const LABELED = "s-labeled";
const UNLABELED = "s-unlabeled";
const ONE_CLASS = "s-one-class";
const MISSING = "s-metrics-missing";
const EMPTY = "s-empty";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function session(
  id: string,
  labels: number,
  observations: number,
  anomalies = 4,
) {
  return {
    session: id,
    source: { label: `sample: ${id}.mp4`, kind: "sample", synthetic: true },
    processing: {
      frames_processed: 40,
      width: 640,
      height: 360,
      fps: 10,
      wall_s: 1,
      max_frames: null,
      processing_fps: 40,
      video_duration_s: 4,
      started_ts: null,
      ended_ts: null,
      run_stats_available: true,
    },
    counts: {
      observations,
      tracks: 3,
      anomalies,
      levels: { Normal: Math.max(0, observations - anomalies), Suspicious: anomalies, Irregular: 0 },
      labels,
    },
    frame_range: { first: 0, last: 39 },
    timestamps: {
      first_ts: "2026-01-01T00:00:00+00:00",
      last_ts: "2026-01-01T00:00:04+00:00",
    },
  };
}

const SESSIONS = [
  session(LABELED, 8, 40, 12),
  session(UNLABELED, 0, 25, 4),
  session(ONE_CLASS, 3, 18, 2),
  session(MISSING, 8, 30, 5),
  session(EMPTY, 0, 0, 0),
];

const LABELED_EVALUATION: EvaluationResponse = {
  session: LABELED,
  available: true,
  computable: true,
  metrics: {
    tp: 2,
    fp: 1,
    fn: 1,
    tn: 4,
    precision: 2 / 3,
    recall: 2 / 3,
    f1: 2 / 3,
    fpr: 0.2,
    accuracy: 0.75,
    n_labeled: 8,
  },
  reason: null,
  labeled_observations: 8,
  total_observations: 40,
  unlabeled_observations: 32,
  coverage: 0.2,
  label_counts: { Normal: 5, Anomaly: 3 },
  predicted_positive: 12,
  positive_rule: "Suspicious or Irregular counts as a positive prediction",
};

const UNLABELED_EVALUATION: EvaluationResponse = {
  session: UNLABELED,
  available: false,
  computable: false,
  metrics: null,
  reason: "No ground-truth labels were found for this session.",
  labeled_observations: 0,
  total_observations: 25,
  unlabeled_observations: 25,
  coverage: 0,
  label_counts: { Normal: 0, Anomaly: 0 },
  predicted_positive: 4,
  positive_rule: "Suspicious or Irregular counts as a positive prediction",
};

const ONE_CLASS_EVALUATION: EvaluationResponse = {
  ...UNLABELED_EVALUATION,
  session: ONE_CLASS,
  available: true,
  reason: "Labels contain only one class (Anomaly); precision, recall and F1 are undefined.",
  labeled_observations: 3,
  total_observations: 18,
  unlabeled_observations: 15,
  coverage: 3 / 18,
  label_counts: { Normal: 0, Anomaly: 3 },
  predicted_positive: 2,
};

const MISSING_EVALUATION: EvaluationResponse = {
  ...LABELED_EVALUATION,
  session: MISSING,
  metrics: null,
  reason: "The API returned labels but no metric payload.",
  total_observations: 30,
  unlabeled_observations: 22,
};

const EMPTY_EVALUATION: EvaluationResponse = {
  ...UNLABELED_EVALUATION,
  session: EMPTY,
  total_observations: 0,
  unlabeled_observations: 0,
  coverage: null,
};

function evaluationBody(id: string): EvaluationResponse {
  if (id === LABELED) return LABELED_EVALUATION;
  if (id === ONE_CLASS) return ONE_CLASS_EVALUATION;
  if (id === MISSING) return MISSING_EVALUATION;
  if (id === EMPTY) return EMPTY_EVALUATION;
  return UNLABELED_EVALUATION;
}

function stubBrowserDownload() {
  const create = vi.fn(() => "blob:neural-command");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: create,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  return { create, click };
}

function mockFetch(
  options: {
    evaluationFailure?: boolean;
    reportFailure?: boolean;
  } = {},
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/health")) {
      return Promise.resolve(json({ status: "ok", version: "1.0.0", uptime_s: 1 }));
    }
    if (url.includes("/sessions?limit=100")) {
      return Promise.resolve(
        json({ total: SESSIONS.length, count: SESSIONS.length, limit: 100, offset: 0, sessions: SESSIONS }),
      );
    }
    if (url.includes(`/sessions/${LABELED}/export/csv?dataset=events`)) {
      return Promise.resolve(
        new Response("frame,ts_utc\n0,2026-01-01\n1,2026-01-01\n", {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="s-labeled_events.csv"',
            "X-Row-Count": "2",
          },
        }),
      );
    }
    if (url.includes(`/sessions/${LABELED}/export/csv?dataset=tracks`)) {
      return Promise.resolve(
        new Response("track_id\n", {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="s-labeled_tracks.csv"',
            "X-Row-Count": "0",
          },
        }),
      );
    }
    if (url.includes(`/sessions/${LABELED}/report?download=true`)) {
      if (options.reportFailure) {
        return Promise.resolve(json({ error: { code: "internal", message: "Report generation failed." } }, 500));
      }
      return Promise.resolve(
        new Response("# Session Analysis Report\n", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": 'attachment; filename="s-labeled_report.md"',
          },
        }),
      );
    }
    const match = url.match(/\/sessions\/([^/]+)\/evaluation$/);
    if (match) {
      if (options.evaluationFailure) {
        return Promise.resolve(
          json({ error: { code: "internal", message: "Evaluation read failed." } }, 500),
        );
      }
      return Promise.resolve(json(evaluationBody(decodeURIComponent(match[1]))));
    }
    return Promise.reject(new Error(`Unhandled fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(sessionId = LABELED) {
  return render(
    <MemoryRouter initialEntries={[`/evaluation?session=${sessionId}`]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evaluation and reports", () => {
  it("shows measured metrics, a confusion matrix and the unsupported ROC-AUC disclosure", async () => {
    mockFetch();
    renderPage();

    expect(
      (await screen.findByRole("heading", { level: 1 })).textContent,
    ).toBe("Evaluation & Reports");
    expect(await screen.findByText("Accuracy")).toBeTruthy();
    expect(screen.getByText("75.0%")).toBeTruthy();
    expect(screen.getAllByText("66.7%")).toHaveLength(3); // precision, recall, F1
    expect(screen.getByText("20.0%")).toBeTruthy(); // false positive rate
    expect(screen.getByText("Confusion matrix")).toBeTruthy();

    const table = screen.getByRole("table", { name: "Confusion matrix" });
    expect(within(table).getByText("TP")).toBeTruthy();
    expect(within(table).getByText("FP")).toBeTruthy();
    expect(within(table).getByText("FN")).toBeTruthy();
    expect(within(table).getByText("TN")).toBeTruthy();
    expect(table.querySelector(".confusion__cell--tp")?.textContent).toContain("2");
    expect(table.querySelector(".confusion__cell--fp")?.textContent).toContain("1");
    expect(table.querySelector(".confusion__cell--fn")?.textContent).toContain("1");
    expect(table.querySelector(".confusion__cell--tn")?.textContent).toContain("4");

    expect(screen.getByText("ROC-AUC not available")).toBeTruthy();
    expect(screen.getByText(/not reported as zero or guessed/)).toBeTruthy();
    expect(screen.getByText(/8 labels matched to observations/)).toBeTruthy();

    expect(
      screen
        .getByRole("link", { name: `Open Anomaly Center for ${LABELED}` })
        .getAttribute("href"),
    ).toBe(`/anomalies?session=${LABELED}`);
    expect(
      screen
        .getByRole("link", { name: `Open Track Explorer for ${LABELED}` })
        .getAttribute("href"),
    ).toBe(`/tracks?session=${LABELED}`);
  });

  it("distinguishes missing labels from insufficient label diversity", async () => {
    mockFetch();
    renderPage(UNLABELED);

    expect(await screen.findByText("No ground-truth labels")).toBeTruthy();
    expect(screen.getByText(/No ground-truth labels were found/)).toBeTruthy();
    expect(screen.queryByText("Accuracy")).toBeNull();
    expect(screen.queryByText("Confusion matrix")).toBeNull();
    expect(screen.getByText(/never as a/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Evaluation session"), {
      target: { value: ONE_CLASS },
    });
    expect(await screen.findByText("Not enough label diversity")).toBeTruthy();
    expect(screen.getByText(/only one class/)).toBeTruthy();
    expect(screen.getByText(/No score shown/)).toBeTruthy();
    expect(screen.queryByText("Accuracy")).toBeNull();
  });

  it("keeps a failed evaluation distinct from empty labels and never renders scores", async () => {
    mockFetch({ evaluationFailure: true });
    renderPage();

    expect(
      await screen.findByText("Evaluation unavailable", { selector: ".state__title" }),
    ).toBeTruthy();
    expect(screen.getByText("Evaluation read failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry request/ })).toBeTruthy();
    expect(screen.getByText(/A failed read is/)).toBeTruthy();
    expect(screen.queryByText("Accuracy")).toBeNull();
    expect(screen.queryByText("No ground-truth labels")).toBeNull();
  });

  it("distinguishes an unavailable metric payload from an API failure", async () => {
    mockFetch();
    renderPage(MISSING);

    expect(
      await screen.findByText("Metrics unavailable", { selector: ".state__title" }),
    ).toBeTruthy();
    expect(screen.getByText(/returned labels but no metric payload/)).toBeTruthy();
    expect(screen.getByText(/not an API failure/)).toBeTruthy();
    expect(screen.queryByText("Accuracy")).toBeNull();
    expect(screen.queryByText("Evaluation unavailable")).toBeNull();
  });

  it("downloads CSV and markdown through the report API with success and empty feedback", async () => {
    const { create, click } = stubBrowserDownload();
    mockFetch();
    renderPage();

    await screen.findByText("Accuracy");
    fireEvent.click(screen.getByRole("button", { name: "Download Event observations" }));
    expect(await screen.findByText(/Downloaded 2 rows/)).toBeTruthy();
    expect(screen.getByText("saved")).toBeTruthy();
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download Track aggregates" }));
    expect(await screen.findByText("Downloaded header-only CSV · 0 rows")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Download Session report" }));
    expect(await screen.findByText(/Downloaded report/)).toBeTruthy();
  });

  it("reports a failed report download and allows a retry", async () => {
    stubBrowserDownload();
    mockFetch({ reportFailure: true });
    renderPage();

    await screen.findByText("Accuracy");
    fireEvent.click(screen.getByRole("button", { name: "Download Session report" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Report generation failed.",
    );
    const retry = screen.getByRole("button", { name: "Download Session report" });
    expect(retry).toHaveProperty("disabled", false);
    expect(screen.getByText("retry")).toBeTruthy();
  });

  it("switches sessions in place and resets the previous metrics", async () => {
    mockFetch();
    renderPage(LABELED);

    await screen.findByText("Accuracy");
    expect(screen.getByLabelText("Evaluation session")).toHaveProperty("value", LABELED);

    fireEvent.change(screen.getByLabelText("Evaluation session"), {
      target: { value: UNLABELED },
    });

    expect(await screen.findByText("No ground-truth labels")).toBeTruthy();
    expect(screen.queryByText("Accuracy")).toBeNull();
    expect(screen.getByLabelText("Evaluation session")).toHaveProperty("value", UNLABELED);
    expect(screen.getByText(`${UNLABELED} · 25 observations`)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Evaluation session"), {
      target: { value: LABELED },
    });
    expect(await screen.findByText("Accuracy")).toBeTruthy();
    expect(screen.queryByText("No ground-truth labels")).toBeNull();
  });

  it("shows an unmeasurable coverage and an explicit empty export state", async () => {
    mockFetch();
    renderPage(EMPTY);

    expect(await screen.findByText("No ground-truth labels")).toBeTruthy();
    expect(screen.getByText("coverage not measurable")).toBeTruthy();
    expect(screen.getByText(/CSV exports will contain/)).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("frames a ready evaluation with a readiness hero, meter-backed metrics and a matrix legend", async () => {
    mockFetch();
    renderPage();

    await screen.findByText("Accuracy");

    const hero = document.querySelector(".eval-hero") as HTMLElement;
    expect(hero.dataset.tone).toBe("ok");
    expect(hero.querySelector(".eval-hero__title")?.textContent).toBe("Evaluation ready");
    expect(hero.querySelector(".eval-hero__coverage-value")?.textContent).toContain("8");
    expect(hero.querySelector(".eval-hero__coverage-value")?.textContent).toContain("40");
    expect(hero.querySelector(".eval-hero__coverage-bar > span")).toBeTruthy();

    const cards = document.querySelectorAll(".eval-layout .metric-card");
    expect(cards).toHaveLength(5);
    cards.forEach((card) => expect(card.querySelector(".metric-card__meter")).toBeTruthy());

    const matrixCells = document.querySelectorAll(".confusion__name");
    expect(matrixCells).toHaveLength(4);
    expect(document.querySelector(".confusion__cell--tp .confusion__name")?.textContent).toBe(
      "True positive",
    );
    expect(document.querySelector(".confusion__cell--fn .confusion__name")?.textContent).toBe(
      "False negative",
    );

    const legend = document.querySelectorAll(".eval-legend__item");
    expect(legend).toHaveLength(4);
    expect(document.querySelector(".eval-legend__item--fp .eval-legend__detail")?.textContent).toBe(
      "predicted anomaly · labelled normal",
    );

    expect(document.querySelectorAll(".export-row__arrow")).toHaveLength(3);
    expect(screen.getByText("server-rendered")).toBeTruthy();
  });

  it("explains a one-class run with a label balance instead of scores", async () => {
    mockFetch();
    renderPage(ONE_CLASS);

    await screen.findByText("Not enough label diversity");

    const hero = document.querySelector(".eval-hero") as HTMLElement;
    expect(hero.dataset.tone).toBe("warn");
    expect(hero.querySelector(".eval-hero__title")?.textContent).toBe("Insufficient label diversity");
    expect(document.querySelector(".eval-layout .metric-card")).toBeNull();
    expect(document.querySelector(".confusion")).toBeNull();

    const anomaly = document.querySelector(".eval-balance__fill--anomaly") as HTMLElement;
    expect(anomaly).toBeTruthy();
    expect(anomaly.style.width).toBe("100%");
    const normal = document.querySelector(".eval-balance__fill--normal") as HTMLElement;
    expect(normal.style.width).toBe("0%");
    expect(document.querySelector(".eval-panel")?.textContent).toContain("share of stored labels");
  });

  it("keeps a label-only response visibly unscored with no ROC-AUC fallback", async () => {
    mockFetch();
    renderPage(MISSING);

    await screen.findByText("Metrics unavailable", { selector: ".state__title" });

    const hero = document.querySelector(".eval-hero") as HTMLElement;
    expect(hero.dataset.tone).toBe("warn");
    expect(hero.querySelector(".eval-hero__title")?.textContent).toBe("Metrics unavailable");
    expect(document.querySelector(".confusion")).toBeNull();
    expect(document.querySelector(".eval-legend")).toBeNull();
    expect(screen.queryByText("ROC-AUC not available")).toBeNull();
    expect(screen.queryByText("0.000")).toBeNull();
  });
});

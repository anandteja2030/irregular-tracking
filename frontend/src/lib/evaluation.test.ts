import { describe, expect, it } from "vitest";
import {
  confusionMatrix,
  coveragePercent,
  evaluationState,
  formatMetric,
  formatRate,
  labelTotal,
  rocAuc,
} from "./evaluation";
import type { EvaluationResponse } from "./types";

function response(overrides: Partial<EvaluationResponse> = {}): EvaluationResponse {
  return {
    session: "s",
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
    ...overrides,
  };
}

describe("evaluation helpers", () => {
  it("classifies missing labels, one-class data and a missing payload separately", () => {
    expect(evaluationState(null)).toBeNull();
    expect(
      evaluationState(
        response({
          available: false,
          computable: false,
          metrics: null,
          reason: "No ground-truth labels.",
        }),
      ),
    ).toBe("no_labels");
    expect(
      evaluationState(
        response({
          computable: false,
          metrics: null,
          reason: "Only one class is present.",
        }),
      ),
    ).toBe("insufficient");
    expect(evaluationState(response({ metrics: null }))).toBe("metrics_missing");
    expect(evaluationState(response())).toBe("ready");
  });

  it("formats rates without turning a missing value into zero", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(undefined)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
    expect(formatRate(0)).toBe("0.0%");
    expect(formatRate(0.8567)).toBe("85.7%");
    expect(formatRate(1)).toBe("100.0%");
    expect(formatMetric(0.8402)).toBe("0.840");
    expect(formatMetric(null)).toBe("—");
  });

  it("uses the API confusion counts and preserves their total", () => {
    expect(confusionMatrix(null)).toBeNull();
    expect(confusionMatrix(response().metrics)).toEqual({
      tp: 2,
      fp: 1,
      fn: 1,
      tn: 4,
      total: 8,
    });
  });

  it("only exposes ROC-AUC when the API returns a bounded value", () => {
    expect(rocAuc(response().metrics)).toBeNull();
    expect(rocAuc({ ...response().metrics!, roc_auc: null })).toBeNull();
    expect(rocAuc({ ...response().metrics!, roc_auc: 1.2 })).toBeNull();
    expect(rocAuc({ ...response().metrics!, roc_auc: 0.84 })).toBe(0.84);
  });

  it("keeps an unmeasurable coverage missing rather than 0%", () => {
    expect(coveragePercent(response())).toBe("20.0%");
    expect(coveragePercent(response({ coverage: 0 }))).toBe("0.0%");
    expect(coveragePercent(response({ coverage: null }))).toBe("—");
    expect(coveragePercent(null)).toBe("—");
  });

  it("totals stored labels without treating an empty map as missing", () => {
    expect(labelTotal(response())).toBe(8);
    expect(labelTotal(response({ label_counts: {} }))).toBe(0);
    expect(labelTotal(null)).toBeNull();
  });
});

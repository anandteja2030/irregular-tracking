/** Display helpers for ground-truth evaluation.
 *
 * The API computes the metrics. This module only classifies the honest
 * availability state and formats values; it never recomputes a score from
 * missing inputs.
 */
import type { EvaluationMetrics, EvaluationResponse } from "./types";

export type EvaluationState =
  | "ready"
  | "insufficient"
  | "no_labels"
  | "metrics_missing";

export function evaluationState(data: EvaluationResponse | null): EvaluationState | null {
  if (!data) return null;
  if (!data.available) return "no_labels";
  if (!data.computable) return "insufficient";
  return data.metrics ? "ready" : "metrics_missing";
}

/** Ratio -> percentage string. A missing ratio stays missing, never 0%. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isFinite(value) === false) return "—";
  return value.toFixed(3);
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  total: number;
}

export function confusionMatrix(metrics: EvaluationMetrics | null): ConfusionMatrix | null {
  if (!metrics) return null;
  return {
    tp: metrics.tp,
    fp: metrics.fp,
    fn: metrics.fn,
    tn: metrics.tn,
    total: metrics.tp + metrics.fp + metrics.fn + metrics.tn,
  };
}

/** ROC-AUC is displayed only when the API actually returns a bounded value. */
export function rocAuc(metrics: EvaluationMetrics | null): number | null {
  if (!metrics) return null;
  const value = metrics.roc_auc;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

export function coveragePercent(data: EvaluationResponse | null): string {
  if (!data || data.coverage === null || !Number.isFinite(data.coverage)) return "—";
  return `${(data.coverage * 100).toFixed(1)}%`;
}

export function labelTotal(data: EvaluationResponse | null): number | null {
  if (!data) return null;
  return (data.label_counts?.Normal ?? 0) + (data.label_counts?.Anomaly ?? 0);
}

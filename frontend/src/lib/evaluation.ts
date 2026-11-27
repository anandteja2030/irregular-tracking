/** Display helpers for ground-truth evaluation.
 *
 * The API computes the metrics. This module only classifies the honest
 * availability state and formats values; it never recomputes a score from
 * missing inputs.
 */
import type { EvaluationMetrics, EvaluationResponse, RocAnalysis } from "./types";

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

/** The ranked ROC document, only when the API measured a usable curve. */
export function rocAnalysis(data: EvaluationResponse | null): RocAnalysis | null {
  const roc = data?.roc;
  if (!roc || !roc.available) return null;
  if (typeof roc.auc !== "number" || !Number.isFinite(roc.auc)) return null;
  if (roc.auc < 0 || roc.auc > 1) return null;
  if (!Array.isArray(roc.points) || roc.points.length < 2) return null;
  return roc;
}

/** Plain-language reading of an AUC, tied to the 0.5 chance line. */
export function rocVerdict(auc: number): { tone: "ok" | "warn" | "bad"; label: string; detail: string } {
  if (auc >= 0.9) {
    return {
      tone: "ok",
      label: "Excellent separation",
      detail: "Ranking the fused score puts almost every labelled anomaly above the labelled normals.",
    };
  }
  if (auc >= 0.8) {
    return {
      tone: "ok",
      label: "Strong separation",
      detail: "Most labelled anomalies rank above the normals, with some overlap in the middle scores.",
    };
  }
  if (auc >= 0.7) {
    return {
      tone: "ok",
      label: "Acceptable separation",
      detail: "The fused score carries real signal, but the classes still overlap noticeably.",
    };
  }
  if (auc >= 0.6) {
    return {
      tone: "warn",
      label: "Weak separation",
      detail: "The score separates the classes only slightly better than chance — useful, but not dependable alone.",
    };
  }
  if (auc >= 0.5) {
    return {
      tone: "warn",
      label: "Near chance",
      detail: "The fused score barely outranks random ordering on this label set.",
    };
  }
  return {
    tone: "bad",
    label: "Below chance",
    detail:
      "Labelled anomalies score lower than labelled normals on this run. The ranking is inverted, so review the labels and the fusion weights before trusting these scores.",
  };
}

export function coveragePercent(data: EvaluationResponse | null): string {
  if (!data || data.coverage === null || !Number.isFinite(data.coverage)) return "—";
  return `${(data.coverage * 100).toFixed(1)}%`;
}

export function labelTotal(data: EvaluationResponse | null): number | null {
  if (!data) return null;
  return (data.label_counts?.Normal ?? 0) + (data.label_counts?.Anomaly ?? 0);
}

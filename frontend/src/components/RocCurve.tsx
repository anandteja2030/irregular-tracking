import type { RocAnalysis } from "../lib/types";

interface RocCurveProps {
  roc: RocAnalysis;
  /** Compact hides the axis captions; the curve and chance line stay. */
  compact?: boolean;
}

const W = 260;
const H = 200;
const PAD_L = 34;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;

function x(value: number): number {
  return PAD_L + Math.min(1, Math.max(0, value)) * (W - PAD_L - PAD_R);
}

function y(value: number): number {
  return H - PAD_B - Math.min(1, Math.max(0, value)) * (H - PAD_T - PAD_B);
}

/**
 * The measured ROC curve of the persisted fused score.
 *
 * Every point comes from the API's rank sweep over the same labels the
 * confusion matrix uses; nothing is smoothed, guessed or generated here.
 */
export function RocCurve({ roc, compact = false }: RocCurveProps) {
  const points = [...roc.points].sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  const line = points.map((point) => `${x(point.fpr).toFixed(2)},${y(point.tpr).toFixed(2)}`).join(" ");
  const area = `${x(0)},${y(0)} ${line} ${x(1)},${y(0)}`;
  const auc = roc.auc ?? 0;

  return (
    <figure className={`roc${compact ? " roc--compact" : ""}`}>
      <svg
        className="roc__plot"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`ROC curve of the fused score, AUC ${auc.toFixed(3)}, ${roc.positives} labelled anomalies and ${roc.negatives} labelled normals`}
      >
        <defs>
          <linearGradient id="roc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={x(0)}
              x2={x(1)}
              y1={y(tick)}
              y2={y(tick)}
              className="roc__grid"
            />
            <line
              x1={x(tick)}
              x2={x(tick)}
              y1={y(0)}
              y2={y(1)}
              className="roc__grid"
            />
          </g>
        ))}

        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(1)}
          y2={y(1)}
          className="roc__chance"
        />
        <polygon points={area} fill="url(#roc-fill)" />
        <polyline points={line} className="roc__line" />

        {!compact && (
          <>
            <text x={x(0)} y={H - 8} className="roc__tick" textAnchor="start">
              0
            </text>
            <text x={x(0.5)} y={H - 8} className="roc__tick" textAnchor="middle">
              0.5
            </text>
            <text x={x(1)} y={H - 8} className="roc__tick" textAnchor="end">
              1.0
            </text>
            <text x={x(0) - 6} y={y(1)} className="roc__tick" textAnchor="end">
              1.0
            </text>
            <text x={x(0) - 6} y={y(0.5)} className="roc__tick" textAnchor="end">
              0.5
            </text>
            <text x={x(0) - 6} y={y(0)} className="roc__tick" textAnchor="end">
              0
            </text>
            <text x={(x(0) + x(1)) / 2} y={H - 1} className="roc__axis" textAnchor="middle">
              False positive rate
            </text>
            <text
              className="roc__axis"
              textAnchor="middle"
              transform={`translate(9 ${(y(0) + y(1)) / 2}) rotate(-90)`}
            >
              True positive rate
            </text>
          </>
        )}
      </svg>
      <figcaption className="roc__caption mono">
        <span>chance line = 0.500</span>
        <span>AUC {auc.toFixed(3)}</span>
        <span>{roc.points.length} rank steps</span>
      </figcaption>
    </figure>
  );
}

import { SectionHeader } from "./SectionHeader";

/** Closing reading guide for the evaluation page.
 *
 * Static explanation of how a report is built, so the scores above are
 * interpretable without prior knowledge of the engine. It carries no metric
 * values of its own.
 */
const STEPS = [
  {
    code: "01",
    title: "Coverage",
    lead: "How much of the run the labels reach",
    body: "Labels matched to observations by frame and track, as a share of the run.",
  },
  {
    code: "02",
    title: "Agreement",
    lead: "Precision, recall, F1",
    body: "Precision = right when it raised. Recall = caught of labelled. F1 balances both.",
  },
  {
    code: "03",
    title: "Confusion",
    lead: "The raw counts behind the rates",
    body: "TP / TN correct · FP false alarm · FN missed. Every rate comes from these four.",
  },
  {
    code: "04",
    title: "Verdict",
    lead: "What a score can and cannot claim",
    body: "Unlabelled or single-class run = unscoreable, never zero.",
  },
];

export function ReportGuide() {
  return (
    <div className="report-guide">
      <SectionHeader
        title="How this report is built"
        meta="Four readings · what every score above measures"
        level={3}
      />
      <div className="report-guide__grid">
        {STEPS.map((step) => (
          <article className="report-step" key={step.code}>
            <span className="report-step__code mono">{step.code}</span>
            <h3 className="report-step__title">{step.title}</h3>
            <span className="report-step__lead mono">{step.lead}</span>
            <p className="report-step__body">{step.body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

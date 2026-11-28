import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusPill } from "../components/StatusPill";
import { LocalLiveCapture } from "../components/LocalLiveCapture";

/**
 * Live webcam analysis with no server behind it.
 *
 * The analysis itself lives in `LocalLiveCapture`, which the Video Studio also
 * falls back to when the Python API is not reachable. This page adds the
 * explanation of what the local engine can and cannot measure.
 */
export function LocalVisionPage() {
  return (
    <>
      <PageHeader
        eyebrow="Live Vision · in-browser engine"
        title="Live camera, measured on this device"
        lede="Frames are read from your webcam into a canvas, measured here in the browser and drawn straight back. No frame is uploaded and nothing is saved, so this works on the GitHub Pages link with no server behind it."
        aside={
          <StatusPill tone="ok" dot>
            LOCAL ENGINE
          </StatusPill>
        }
      />

      <LocalLiveCapture />

      <Panel title="What this page measures" variant="flat">
        <ul className="hint-list">
          <li>
            <strong>Motion, not identity.</strong> A frame is compared with a running background
            average; changed pixels are grouped into regions and matched to the previous frame, which
            gives stable track ids without a trained model.
          </li>
          <li>
            <strong>Speed relative to this scene.</strong> After a short baseline, a track&apos;s
            measured speed is scored against the scene&apos;s own mean and spread. That is what turns
            into Normal, Suspicious or Irregular — the same three levels the server pipeline reports.
          </li>
          <li>
            <strong>Global brightness changes are discarded</strong> instead of being read as motion,
            so auto-exposure does not create a screen full of false tracks.
          </li>
          <li>
            <strong>Nothing persists.</strong> Sessions, reports, ROC curves and exports need the
            Python service and are unavailable on this static build.
          </li>
        </ul>
      </Panel>
    </>
  );
}

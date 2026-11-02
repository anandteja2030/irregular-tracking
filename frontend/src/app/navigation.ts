import type { ComponentType, SVGProps } from "react";
import {
  AnomalyIcon,
  EvaluationIcon,
  OverviewIcon,
  SceneIcon,
  SettingsIcon,
  StudioIcon,
  TrackIcon,
} from "../components/icons";

export interface NavItem {
  id: string;
  path: string;
  label: string;
  /** Two-digit index shown in the rail, matching a command surface. */
  index: string;
  shortcut: string;
  blurb: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    path: "/",
    label: "Command Overview",
    index: "01",
    shortcut: "O",
    blurb: "Runtime state, storage envelope and the operational surface.",
    Icon: OverviewIcon,
  },
  {
    id: "studio",
    path: "/video-studio",
    label: "Video Studio",
    index: "02",
    shortcut: "V",
    blurb: "Source inventory and the analysis intake surface.",
    Icon: StudioIcon,
  },
  {
    id: "tracks",
    path: "/tracks",
    label: "Track Explorer",
    index: "03",
    shortcut: "T",
    blurb: "Trajectories, observations and per-object telemetry.",
    Icon: TrackIcon,
  },
  {
    id: "anomalies",
    path: "/anomalies",
    label: "Anomaly Center",
    index: "04",
    shortcut: "A",
    blurb: "Fused scoring evidence across rules, model and scene.",
    Icon: AnomalyIcon,
  },
  {
    id: "scene",
    path: "/scene",
    label: "Scene Intelligence",
    index: "05",
    shortcut: "S",
    blurb: "Calibration baseline, zones and movement deviations.",
    Icon: SceneIcon,
  },
  {
    id: "evaluation",
    path: "/evaluation",
    label: "Evaluation & Reports",
    index: "06",
    shortcut: "E",
    blurb: "Ground-truth metrics and exportable session reports.",
    Icon: EvaluationIcon,
  },
  {
    id: "settings",
    path: "/settings",
    label: "System Settings",
    index: "07",
    shortcut: ",",
    blurb: "Engine configuration, thresholds and stored paths.",
    Icon: SettingsIcon,
  },
];

export function navItemForPath(pathname: string): NavItem {
  if (pathname === "/") return NAV_ITEMS[0];
  const match = NAV_ITEMS.find(
    (item) => item.path !== "/" && pathname.startsWith(item.path),
  );
  return match ?? NAV_ITEMS[0];
}

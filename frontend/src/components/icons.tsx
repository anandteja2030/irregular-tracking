import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function OverviewIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5 11v8.5h14V11" />
      <path d="M9.5 19.5v-5h5v5" />
    </svg>
  );
}

export function StudioIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 9h18" />
      <path d="m10.5 12.5 4 2.5-4 2.5z" />
    </svg>
  );
}

export function TrackIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M8.2 18c3.4 0 3-6 7.6-6" />
      <path d="M6 15.8V9" strokeDasharray="2 3" />
    </svg>
  );
}

export function AnomalyIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 13h3l2.2-6 3.4 12 2.4-8 1.6 4H21" />
    </svg>
  );
}

export function SceneIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" />
    </svg>
  );
}

export function EvaluationIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20V9M10 20V4M16 20v-7M21 20H3" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </svg>
  );
}

export function CommandIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M9 8.5V6.8a2.3 2.3 0 1 1 3 2.2v6a2.3 2.3 0 1 1-3 2.2" />
      <path d="M15 8.5V6.8a2.3 2.3 0 1 0-3 2.2" />
      <path d="M9 15.5v1.7a2.3 2.3 0 1 0 3-2.2" />
      <path d="M15 15.5v1.7a2.3 2.3 0 1 1-3-2.2" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M20 11a8 8 0 1 0-2.6 6.3" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 4.5 21 19H3z" />
      <path d="M12 10v4.2" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RadioIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4" />
      <path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" />
    </svg>
  );
}

export function DatabaseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m12 3 8.5 4.6L12 12 3.5 7.6z" />
      <path d="m3.5 12.4 8.5 4.6 8.5-4.6" />
      <path d="m3.5 16.9 8.5 4.6 8.5-4.6" />
    </svg>
  );
}

export function CpuIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </svg>
  );
}

export function FilmIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 4.5v15M17 4.5v15M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 12h15" />
      <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 15v4.5h16V15" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 5.5 19 12 8 18.5z" />
    </svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.8" />
    </svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="8.8" cy="9.8" r="1.6" />
      <path d="m4.5 17 5-4.6 3.4 3.1 3-2.7 3.6 4.2" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

import type { ReactNode } from "react";

export type StatusTone = "neutral" | "accent" | "accent-2" | "ok" | "warn" | "bad" | "muted";

export interface StatusPillProps {
  children: ReactNode;
  tone?: StatusTone;
  /** Decorative glyph rendered before the label. */
  icon?: ReactNode;
  /** Small tone-coloured dot instead of an icon. */
  dot?: boolean;
  size?: "default" | "sm";
  /** Announce changes: use only for pills that update in place. */
  live?: boolean;
  title?: string;
  className?: string;
}

/** Compact status token used for levels, availability and counts. */
export function StatusPill({
  children,
  tone = "neutral",
  icon,
  dot = false,
  size = "default",
  live = false,
  title,
  className = "",
}: StatusPillProps) {
  return (
    <span
      className={`status-pill ${size === "sm" ? "status-pill--sm" : ""} ${className}`.trim()}
      data-tone={tone}
      role={live ? "status" : undefined}
      title={title}
    >
      {icon && (
        <span className="status-pill__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {dot && <span className="status-pill__dot" aria-hidden="true" />}
      <span className="status-pill__label">{children}</span>
    </span>
  );
}

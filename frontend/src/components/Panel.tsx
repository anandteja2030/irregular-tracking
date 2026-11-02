import type { ReactNode } from "react";

interface PanelProps {
  title?: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  foot?: ReactNode;
  variant?: "default" | "flat" | "accent";
  as?: "section" | "div" | "article";
}

/** The single glass surface primitive used across the console. */
export function Panel({
  title,
  sub,
  actions,
  children,
  className = "",
  bodyClassName = "",
  foot,
  variant = "default",
  as: Tag = "section",
}: PanelProps) {
  const variantClass =
    variant === "flat" ? "panel--flat" : variant === "accent" ? "panel--accent" : "";
  return (
    <Tag className={`panel ${variantClass} ${className}`.trim()}>
      {(title || actions) && (
        <header className="panel__head">
          <div className="panel__titles">
            {title && <span className="panel__title">{title}</span>}
            {sub && <span className="panel__sub">{sub}</span>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className={`panel__body ${bodyClassName}`.trim()}>{children}</div>
      {foot && <footer className="panel__foot">{foot}</footer>}
    </Tag>
  );
}

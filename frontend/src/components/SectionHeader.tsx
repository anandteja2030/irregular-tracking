import type { ReactNode } from "react";

export interface SectionHeaderProps {
  title: ReactNode;
  /** Heading id, so the surrounding section can use aria-labelledby. */
  id?: string;
  /** Short mono qualifier shown next to the title. */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3 | 4;
  className?: string;
}

/** Section heading with an inset rule, optional qualifier and trailing actions. */
export function SectionHeader({
  title,
  id,
  meta,
  description,
  actions,
  level = 2,
  className = "",
}: SectionHeaderProps) {
  const Heading = `h${level}` as "h2" | "h3" | "h4";

  return (
    <header className={`section-header ${className}`.trim()}>
      <div className="section-header__main">
        <Heading className="section-header__title" id={id}>
          {title}
        </Heading>
        {meta && <span className="section-header__meta mono">{meta}</span>}
      </div>
      {actions && <div className="section-header__actions">{actions}</div>}
      {description && <p className="section-header__description">{description}</p>}
    </header>
  );
}

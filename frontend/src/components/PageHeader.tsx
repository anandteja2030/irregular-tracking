import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  lede?: string;
  aside?: ReactNode;
}

export function PageHeader({ eyebrow, title, lede, aside }: PageHeaderProps) {
  return (
    <header className="page-head">
      <div className="page-head__main">
        <div className="page-head__eyebrow">
          <span className="eyebrow">{eyebrow}</span>
        </div>
        <h1>{title}</h1>
        {lede && <p className="page-head__lede">{lede}</p>}
      </div>
      {aside && <div className="page-head__aside">{aside}</div>}
    </header>
  );
}

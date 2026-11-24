import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { navItemForPath } from "../app/navigation";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  lede?: string;
  aside?: ReactNode;
}

/** Mission-band page header.
 *
 * The surface index, scanner chrome and corner brackets come from the shell;
 * the title, eyebrow and lede are still exactly what each page passes in.
 */
export function PageHeader({ eyebrow, title, lede, aside }: PageHeaderProps) {
  const { pathname } = useLocation();
  const current = navItemForPath(pathname);
  return (
    <header className="page-head">
      <span className="page-head__index mono" aria-hidden="true">
        {current.index}
      </span>
      <div className="page-head__main">
        <div className="page-head__eyebrow">
          <span className="eyebrow">
            <span className="page-head__seq mono">{current.index}</span>
            {eyebrow}
          </span>
        </div>
        <h1>{title}</h1>
        {lede && <p className="page-head__lede">{lede}</p>}
      </div>
      {aside && <div className="page-head__aside">{aside}</div>}
      <span className="page-head__scan" aria-hidden="true" />
      <span className="page-head__tick page-head__tick--a" aria-hidden="true" />
      <span className="page-head__tick page-head__tick--b" aria-hidden="true" />
    </header>
  );
}

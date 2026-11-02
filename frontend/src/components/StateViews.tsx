import type { ReactNode } from "react";
import { AlertIcon, LayersIcon, RefreshIcon } from "./icons";
import { describeError } from "../lib/api";

export function EmptyState({
  title,
  body,
  code,
  glyph,
  actions,
  compact = false,
}: {
  title: string;
  body?: string;
  code?: string;
  glyph?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`state ${compact ? "state--compact" : ""}`.trim()}>
      <div className="state__glyph">{glyph ?? <LayersIcon width={17} height={17} />}</div>
      <p className="state__title">{title}</p>
      {body && <p className="state__body">{body}</p>}
      {code && <p className="state__code">{code}</p>}
      {actions && <div className="state__actions">{actions}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = "This surface could not load",
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
}) {
  return (
    <div className={`state state--error ${compact ? "state--compact" : ""}`.trim()}>
      <div className="state__glyph">
        <AlertIcon width={17} height={17} />
      </div>
      <p className="state__title">{title}</p>
      <p className="state__body">{describeError(error)}</p>
      {onRetry && (
        <div className="state__actions">
          <button type="button" className="btn btn--quiet" onClick={onRetry}>
            <span className="btn__icon">
              <RefreshIcon width={13} height={13} />
            </span>
            Retry request
          </button>
        </div>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {label && <span className="sr-only">{label}</span>}
      <div className="skeleton-stack">
        {Array.from({ length: rows }, (_, index) => (
          <div className="skeleton" key={index} style={{ height: 14, width: `${88 - index * 9}%` }} />
        ))}
      </div>
    </div>
  );
}

export function ChannelSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton" style={{ height: 26, width: "42%" }} />
      <div className="skeleton" style={{ height: 12, width: "76%" }} />
      <div className="skeleton" style={{ height: 12, width: "64%" }} />
    </div>
  );
}

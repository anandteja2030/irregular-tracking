import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { NAV_ITEMS } from "../app/navigation";
import { SearchIcon } from "./icons";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const optionId = (id: string) => `palette-option-${id}`;

/** Command surface: navigate the workspace without leaving the keys.
 *
 * While it is open the palette behaves as a modal dialog: it traps Tab inside
 * the panel, closes on Escape or backdrop press, and returns focus to whichever
 * control opened it. The search field is the single tab stop for the result
 * list and drives the cursor through aria-activedescendant, so focus never
 * disappears into a virtualised option. */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return NAV_ITEMS;
    return NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        item.blurb.toLowerCase().includes(needle) ||
        item.id.includes(needle),
    );
  }, [query]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setCursor(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      // Restore on close *and* on unmount, so a route change or an unmounting
      // shell never strands focus on a removed node.
      const target = restoreRef.current;
      restoreRef.current = null;
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);

  useEffect(() => {
    setCursor((value) => (value >= results.length ? 0 : value));
  }, [results.length]);

  // Keep the active option inside the scroll viewport without moving focus.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>(`#${optionId(results[cursor]?.id ?? "")}`);
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [cursor, open, results]);

  const close = useCallback(() => onClose(), [onClose]);

  const choose = useCallback(
    (path: string) => {
      navigate(path);
      close();
    },
    [navigate, close],
  );

  if (!open) return null;

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (results.length ? (value + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (results.length ? (value - 1 + results.length) % results.length : 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setCursor(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setCursor(Math.max(results.length - 1, 0));
    } else if (event.key === "Enter" && results[cursor]) {
      event.preventDefault();
      choose(results[cursor].path);
    }
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const nodes = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (nodes.length === 0) return;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = panelRef.current?.contains(active ?? null) ?? false;

    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const activeOption = results[cursor];

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        onKeyDown={onPanelKeyDown}
      >
        <h2 id="palette-title" className="sr-only">
          Command palette
        </h2>

        <div className="palette__input-wrap">
          <span className="palette__search" aria-hidden="true">
            <SearchIcon width={15} height={15} />
          </span>
          <input
            ref={inputRef}
            className="palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionId(activeOption.id) : undefined}
            aria-label="Search surfaces"
            placeholder="Jump to a surface…"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <span className="palette__esc" aria-hidden="true">
            ESC
          </span>
          <button
            type="button"
            className="palette__close"
            onClick={close}
            aria-label="Close command palette"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m6 6 12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div id="palette-results" ref={listRef} className="palette__list" role="listbox" aria-label="Surfaces">
          {results.length === 0 && (
            <p className="palette__empty">No surface matches that query.</p>
          )}
          {results.map((item, index) => (
            <div
              key={item.id}
              id={optionId(item.id)}
              role="option"
              aria-selected={index === cursor}
              tabIndex={-1}
              className={`palette__item ${index === cursor ? "is-active" : ""}`}
              onMouseMove={() => setCursor(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item.path)}
            >
              <span className="palette__item-icon" aria-hidden="true">
                <item.Icon width={16} height={16} />
              </span>
              <span className="palette__item-text">
                <span className="palette__item-label">{item.label}</span>
                <span className="palette__item-blurb">{item.blurb}</span>
              </span>
              <span className="palette__hint" aria-hidden="true">
                {item.index}
              </span>
            </div>
          ))}
        </div>

        <div className="palette__footer">
          <span className="palette__count" aria-live="polite">
            {results.length === 1 ? "1 surface" : `${results.length} surfaces`}
          </span>
          <span className="palette__keys" aria-hidden="true">
            <span className="palette__key">↑</span>
            <span className="palette__key">↓</span>
            <span className="palette__key">↵</span>
            <span className="palette__key">esc</span>
          </span>
        </div>
      </div>
    </div>
  );
}

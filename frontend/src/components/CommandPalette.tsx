import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { NAV_ITEMS } from "../app/navigation";
import { SearchIcon } from "./icons";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

/** Minimal command surface: navigate the workspace without leaving the keys. */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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
    setQuery("");
    setCursor(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setCursor((value) => (value >= results.length ? 0 : value));
  }, [results.length]);

  if (!open) return null;

  const choose = (path: string) => {
    navigate(path);
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (results.length ? (value + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) =>
        results.length ? (value - 1 + results.length) % results.length : 0,
      );
    } else if (event.key === "Enter" && results[cursor]) {
      event.preventDefault();
      choose(results[cursor].path);
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__input-wrap">
          <SearchIcon width={15} height={15} />
          <input
            ref={inputRef}
            className="palette__input"
            placeholder="Jump to a surface…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search surfaces"
          />
          <span className="kbd">ESC</span>
        </div>
        <div className="palette__list" role="listbox" aria-label="Surfaces">
          {results.length === 0 && (
            <p className="palette__empty">No surface matches that query.</p>
          )}
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              className={`palette__item ${index === cursor ? "is-active" : ""}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => choose(item.path)}
            >
              <span className="palette__item-icon">
                <item.Icon width={16} height={16} />
              </span>
              <span>{item.label}</span>
              <span className="palette__hint">{item.index}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useSession } from "../app/SessionProvider";
import { describeError } from "../lib/api";

/** Compact, keyboard-native session switcher for the top bar.
 *
 * The control stays a native `<select>`: it keeps platform menu behaviour, arrow
 * key support and touch-friendly hit areas for free. Narrow layouts give it a
 * full-width row of its own (see `.topbar__session` in shell.css) instead of
 * squeezing an unlabelled sliver next to the health pill. */
export function SessionSelect() {
  const { sessions, total, status, error, selectedId, select } = useSession();
  const disabled = sessions.length === 0;

  const hint =
    status === "error"
      ? describeError(error)
      : disabled
        ? "No persisted sessions yet"
        : `${sessions.length} of ${total} sessions`;

  return (
    <label
      className={`session-select ${disabled ? "is-idle" : ""}`.trim()}
      data-status={status}
      aria-busy={status === "loading"}
    >
      <span className="session-select__label">Session</span>
      <select
        className="session-select__control mono"
        value={selectedId ?? ""}
        onChange={(event) => select(event.target.value)}
        disabled={disabled}
        title={hint}
        aria-label="Active analysis session"
      >
        {disabled && <option value="">none persisted</option>}
        {sessions.map((session) => (
          <option key={session.session} value={session.session}>
            {session.session} · {session.source.label ?? session.source.kind ?? "source"}
          </option>
        ))}
      </select>
    </label>
  );
}

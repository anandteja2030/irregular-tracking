import { useSession } from "../app/SessionProvider";
import { describeError } from "../lib/api";

/** Compact, keyboard-native session switcher for the top bar. */
export function SessionSelect() {
  const { sessions, total, status, error, selectedId, select } = useSession();
  const disabled = sessions.length === 0;

  return (
    <label className={`session-select ${disabled ? "is-idle" : ""}`.trim()}>
      <span className="session-select__label">Session</span>
      <select
        className="session-select__control mono"
        value={selectedId ?? ""}
        onChange={(event) => select(event.target.value)}
        disabled={disabled}
        title={
          status === "error"
            ? describeError(error)
            : disabled
              ? "No persisted sessions yet"
              : `${sessions.length} of ${total} sessions`
        }
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

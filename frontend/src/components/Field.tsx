import type { InputHTMLAttributes, ReactNode } from "react";

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "size"> {
  /** Required: drives the label, input and description ids. */
  id: string;
  label: string;
  hint?: string;
  /** Replaces the hint and marks the control invalid. */
  error?: string;
  suffix?: string;
  mono?: boolean;
  /** Keeps the control visible but disabled while a value is being read. */
  loading?: boolean;
  className?: string;
}

/**
 * Labelled text/number input with hint, error and loading state. The hint and
 * error ids are wired through aria-describedby, and the error is announced.
 */
export function Field({
  id,
  label,
  hint,
  error,
  suffix,
  mono = false,
  loading = false,
  className = "",
  disabled,
  required,
  ...input
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  // Only describe rendered nodes: an error replaces the hint, so pointing at the
  // hidden hint id would leave a dangling reference.
  const describedBy = error ? errorId : hintId;
  const isDisabled = Boolean(disabled) || loading;

  return (
    <div
      className={`field ${mono ? "field--mono" : ""} ${error ? "field--error" : ""} ${
        isDisabled ? "field--disabled" : ""
      } ${className}`.trim()}
    >
      <label className="field__label mono" htmlFor={id} data-required={required || undefined}>
        {label}
      </label>
      <div className="field__control">
        <input
          {...input}
          id={id}
          className="field__input"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-busy={loading || undefined}
          disabled={isDisabled}
          required={required}
        />
        {suffix && <span className="field__suffix">{suffix}</span>}
        {loading && <span className="field__spinner" aria-hidden="true" />}
      </div>
      {error ? (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface FieldGroupProps {
  legend: string;
  description?: string;
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  disabled?: boolean;
  className?: string;
}

/** Fieldset wrapper that keeps related controls grouped and labelled. */
export function FieldGroup({
  legend,
  description,
  children,
  columns = 2,
  disabled = false,
  className = "",
}: FieldGroupProps) {
  const descriptionId = description ? `${legend.replace(/\s+/g, "-").toLowerCase()}-description` : undefined;

  return (
    <fieldset
      className={`field-group ${className}`.trim()}
      data-columns={columns}
      disabled={disabled}
      aria-describedby={descriptionId}
    >
      <legend className="field-group__legend">{legend}</legend>
      {description && (
        <p className="field-group__description" id={descriptionId}>
          {description}
        </p>
      )}
      <div className="field-group__grid">{children}</div>
    </fieldset>
  );
}

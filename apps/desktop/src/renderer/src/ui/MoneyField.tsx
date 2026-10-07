import { useState } from "react";
import { tryParsePesos } from "@bcis/shared";

/** Centavos to a plain editable string: 99900 -> "999.00". */
export function centavosToInput(centavos: number): string {
  const whole = Math.trunc(centavos / 100);
  const fraction = String(centavos % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

interface MoneyFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  /** Server-side or form-level error for this field. */
  error?: string | null;
}

export function MoneyField({ label, value, onChange, required, disabled, error }: MoneyFieldProps) {
  const [touched, setTouched] = useState(false);

  const parsed = tryParsePesos(value);
  const formatError =
    touched && value.trim() !== "" && parsed === null
      ? "Enter a valid peso amount, for example 999.00."
      : null;
  const shownError = formatError ?? error ?? null;

  function handleBlur() {
    setTouched(true);
    // Tidy a valid amount to two decimals ("999.5" becomes "999.50").
    if (parsed !== null && parsed >= 0) onChange(centavosToInput(parsed));
  }

  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      {required && (
        <span className="text-danger" aria-hidden="true">
          {" "}*
        </span>
      )}
      <span
        className={`mt-1 flex items-center rounded border bg-surface focus-within:ring-2 ${
          shownError
            ? "border-danger focus-within:ring-danger/30"
            : "border-slate-300 focus-within:border-accent focus-within:ring-accent/30"
        }`}
      >
        <span className="pl-3 text-muted" aria-hidden="true">
          {"\u20B1"}
        </span>
        <input
          className="money w-full bg-transparent px-3 py-2 text-ink outline-none disabled:opacity-60"
          type="text"
          inputMode="decimal"
          value={value}
          required={required}
          disabled={disabled}
          aria-invalid={shownError ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={handleBlur}
        />
      </span>
      {shownError && (
        <span role="alert" className="mt-1 block text-xs font-normal text-danger">
          {shownError}
        </span>
      )}
    </label>
  );
}
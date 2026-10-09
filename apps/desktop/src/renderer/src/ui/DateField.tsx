interface DateFieldProps {
  label: string;
  /** "YYYY-MM-DD", or "" for no date. */
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
  hint?: string;
}

/** A calendar date picker. The value is a plain "YYYY-MM-DD" string, never a Date, so no time zone shifts. */
export function DateField({ label, value, onChange, required, disabled, error, hint }: DateFieldProps) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      {required && (
        <span className="text-danger" aria-hidden="true">
          {" "}*
        </span>
      )}
      <input
        className={`mt-1 block w-full rounded border bg-surface px-3 py-2 font-normal text-ink focus:outline-none focus:ring-2 disabled:bg-slate-100 disabled:opacity-70 ${
          error
            ? "border-danger focus:ring-danger/30"
            : "border-slate-300 focus:border-accent focus:ring-accent/30"
        }`}
        type="date"
        value={value}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && !error && <span className="mt-1 block text-xs font-normal text-muted">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-xs font-normal text-danger">
          {error}
        </span>
      )}
    </label>
  );
}

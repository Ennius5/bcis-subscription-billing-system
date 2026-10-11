interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
  hint?: string;
  inputMode?: "text" | "numeric" | "decimal";
  maxLength?: number;
  /** "password" hides what is typed; autoComplete tells Windows/Chromium what the field holds. */
  type?: "text" | "password";
  autoComplete?: string;
}

export function TextField({
  label,
  value,
  onChange,
  required,
  disabled,
  error,
  hint,
  inputMode = "text",
  maxLength,
  type = "text",
  autoComplete,
}: TextFieldProps) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      {required && (
        <span className="text-danger" aria-hidden="true">
          {" "}*
        </span>
      )}
      <input
        className={error ? "field field-error" : "field"}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        value={value}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
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
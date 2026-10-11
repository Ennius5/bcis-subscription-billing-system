export interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
}

export function SelectField({ label, value, onChange, options, required, disabled, error }: SelectFieldProps) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      {required && (
        <span className="text-danger" aria-hidden="true">
          {" "}*
        </span>
      )}
      <select
        className={error ? "field field-error" : "field"}
        value={value}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="mt-1 block text-xs font-normal text-danger">
          {error}
        </span>
      )}
    </label>
  );
}

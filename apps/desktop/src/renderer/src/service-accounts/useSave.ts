import { useCallback, useState } from "react";
import type { ApiResult } from "../../../preload/index";
import { failureToErrors } from "../subscribers/ProfileForm";

/**
 * Saving, field errors and the form-level message for one form.
 * `reject` shows errors found before sending; `save` sends and maps the server's answer.
 */
export function useSave<T>(onSaved: (data: T) => void, onExpired: () => void) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Stable, so forms can call it from effects and list it as a dependency.
  const reject = useCallback((fields: Record<string, string>, message: string | null = null) => {
    const { form, ...rest } = fields;
    setErrors(rest);
    setFormError(message ?? form ?? null);
  }, []);

  async function save(call: () => Promise<ApiResult<T>>) {
    setSaving(true);
    setErrors({});
    setFormError(null);
    const result = await call();
    if (result.ok) return onSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form);
    setSaving(false);
  }

  return { errors, formError, saving, reject, save };
}

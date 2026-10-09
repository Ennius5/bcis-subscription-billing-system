import { useEffect, useState, type FormEvent } from "react";
import {
  GRACE_PERIOD_DAYS_MAX,
  SUSPENSION_THRESHOLD_MAX,
  receivableSettingsUpdateSchema,
} from "@bcis/shared";
import type { ReceivableSettingsDto } from "../../../preload/index";
import { failureToErrors, schemaErrors } from "../subscribers/ProfileForm";
import { TextField } from "../ui/TextField";

/** "7" -> 7; anything that is not a whole number stays text so the schema reports it. */
function toNumber(text: string): number | string {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface SettingsScreenProps {
  onSessionExpired: () => void;
}

/**
 * Administration > Settings (settings.manage, the owner). The grace period and suspension
 * threshold that decide the Suspension Candidates list (spec 3.10). Only changed values are
 * sent; the server audits each change with the optional reason.
 */
export function SettingsScreen({ onSessionExpired }: SettingsScreenProps) {
  const [saved, setSaved] = useState<ReceivableSettingsDto | null>(null);
  const [grace, setGrace] = useState("");
  const [threshold, setThreshold] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function show(settings: ReceivableSettingsDto) {
    setSaved(settings);
    setGrace(String(settings.gracePeriodDays));
    setThreshold(String(settings.suspensionThresholdInvoices));
  }

  useEffect(() => {
    let cancelled = false;
    void window.bcis.settings.receivables().then((r) => {
      if (cancelled) return;
      if (r.ok) show(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setFormError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [onSessionExpired]);

  const graceValue = toNumber(grace);
  const thresholdValue = toNumber(threshold);
  const changes: Record<string, unknown> = {};
  if (saved && graceValue !== saved.gracePeriodDays) changes.gracePeriodDays = graceValue;
  if (saved && thresholdValue !== saved.suspensionThresholdInvoices) changes.suspensionThresholdInvoices = thresholdValue;
  const dirty = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || saving) return;
    setNotice(null);
    const parsed = receivableSettingsUpdateSchema.safeParse({
      ...changes,
      ...(reason.trim() ? { reason } : {}),
    });
    if (!parsed.success) {
      const fields = schemaErrors(parsed.error);
      const { form, ...rest } = fields;
      setErrors(rest);
      setFormError(form ?? null);
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    const result = await window.bcis.settings.updateReceivables(parsed.data);
    setSaving(false);
    if (result.ok) {
      show(result.data);
      setReason("");
      setNotice("Settings saved. The Suspension Candidates list uses them from now on.");
    } else if (result.code === "UNAUTHENTICATED") {
      onSessionExpired();
    } else {
      const mapped = failureToErrors(result);
      setErrors(mapped.fields);
      setFormError(mapped.form);
    }
  }

  // A worked example in plain words, using the values in the form when they are valid.
  const exampleGrace = typeof graceValue === "number" ? graceValue : saved?.gracePeriodDays;
  const exampleThreshold = typeof thresholdValue === "number" ? thresholdValue : saved?.suspensionThresholdInvoices;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold text-navy">Settings</h1>
      <p className="mb-4 text-sm text-muted">Rules for overdue accounts and suspension. Every change is recorded in the audit log.</p>

      {!saved && !formError && <p className="text-muted">Loading…</p>}

      {saved && (
        <form onSubmit={(e) => void submit(e)} className="rounded-lg border border-slate-200 bg-surface p-4">
          <h2 className="text-sm font-semibold text-navy">Suspension candidates</h2>
          <fieldset className="mt-3 space-y-3" disabled={saving}>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Grace period (days)"
                value={grace}
                onChange={setGrace}
                inputMode="numeric"
                required
                maxLength={3}
                error={errors.gracePeriodDays}
                hint={`0 to ${GRACE_PERIOD_DAYS_MAX}. Days after the due date before a bill counts.`}
              />
              <TextField
                label="Threshold (unpaid bills)"
                value={threshold}
                onChange={setThreshold}
                inputMode="numeric"
                required
                maxLength={2}
                error={errors.suspensionThresholdInvoices}
                hint={`1 to ${SUSPENSION_THRESHOLD_MAX}. Bills past the grace period before a service is listed.`}
              />
            </div>
            {exampleGrace !== undefined && exampleThreshold !== undefined && (
              <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-ink">
                An active service is listed as a candidate when it has at least {plural(exampleThreshold, "unpaid bill")}{" "}
                more than {plural(exampleGrace, "day")} past due. A bill starts to count{" "}
                {exampleGrace === 0 ? "the day after its due date" : `${plural(exampleGrace + 1, "day")} after its due date`}.
                <span className="mt-1 block text-xs text-muted">
                  The Overdue list and aging are not affected: a bill is overdue the day after its due date.
                </span>
              </p>
            )}
            <TextField
              label="Reason for the change"
              value={reason}
              onChange={setReason}
              maxLength={200}
              error={errors.reason}
              hint="Optional. Recorded in the audit log."
            />
          </fieldset>

          {formError && (
            <p role="alert" className="mt-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          {notice && (
            <p role="status" className="mt-3 rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
              {notice}
            </p>
          )}

          <div className="mt-4 flex gap-3">
            <button
              type="submit"
              disabled={!dirty || saving}
              className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              className="rounded border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100 disabled:opacity-60"
              onClick={() => {
                show(saved);
                setErrors({});
                setFormError(null);
              }}
            >
              Undo changes
            </button>
          </div>
        </form>
      )}
    </div>
  );
}


import { useState, type FormEvent } from "react";
import { tryParsePesos, SERVICE_TYPE_CODES, type ServiceTypeCode } from "@bcis/shared";
import type { PlanDto } from "../../../preload/index";
import { centavosToInput, MoneyField } from "../ui/MoneyField";
import { TextField } from "../ui/TextField";

export const TYPE_LABEL: Record<ServiceTypeCode, string> = {
  internet: "Internet",
  cable: "Cable",
  combo: "Combo (Internet + Cable)",
};

export type PlanFormMode = { kind: "create" } | { kind: "edit"; plan: PlanDto };

interface PlanFormProps {
  mode: PlanFormMode;
  onSaved: () => void;
  onCancel: () => void;
  onExpired: () => void;
}

// Server field names -> form field names, so server errors land next to the right input.
const SERVER_FIELD: Record<string, string> = {
  priceCentavos: "price",
  installationFeeCentavos: "installation",
  reconnectionFeeCentavos: "reconnection",
  speedMbps: "speed",
  channelCount: "channels",
};

/** null = empty, undefined = invalid, number = valid whole number. */
function parseOptionalInt(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : undefined;
}

function parseFee(text: string): number | null {
  return text.trim() === "" ? 0 : tryParsePesos(text);
}

export function PlanForm({ mode, onSaved, onCancel, onExpired }: PlanFormProps) {
  const editing = mode.kind === "edit" ? mode.plan : null;

  const [code, setCode] = useState("");
  const [name, setName] = useState(editing?.name ?? "");
  const [serviceType, setServiceType] = useState<ServiceTypeCode>(
    (editing?.serviceType as ServiceTypeCode | undefined) ?? "internet",
  );
  const [price, setPrice] = useState(editing ? centavosToInput(editing.priceCentavos) : "");
  const [installation, setInstallation] = useState(
    editing ? centavosToInput(editing.installationFeeCentavos) : "0.00",
  );
  const [reconnection, setReconnection] = useState(
    editing ? centavosToInput(editing.reconnectionFeeCentavos) : "0.00",
  );
  const [speed, setSpeed] = useState(editing?.speedMbps != null ? String(editing.speedMbps) : "");
  const [channels, setChannels] = useState(
    editing?.channelCount != null ? String(editing.channelCount) : "",
  );
  const [description, setDescription] = useState(editing?.description ?? "");
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [reason, setReason] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const showSpeed = serviceType !== "cable";
  const showChannels = serviceType !== "internet";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    const errs: Record<string, string> = {};
    if (!editing && !code.trim()) errs.code = "Code is required.";
    if (!name.trim()) errs.name = "Name is required.";

    const priceC = tryParsePesos(price);
    const installC = parseFee(installation);
    const reconC = parseFee(reconnection);
    const speedN = showSpeed ? parseOptionalInt(speed) : null;
    const channelsN = showChannels ? parseOptionalInt(channels) : null;

    const peso = "Enter a valid peso amount, for example 999.00.";
    if (priceC === null || priceC < 0) errs.price = peso;
    if (installC === null || installC < 0) errs.installation = peso;
    if (reconC === null || reconC < 0) errs.reconnection = peso;
    if (speedN === undefined) errs.speed = "Enter a whole number.";
    if (channelsN === undefined) errs.channels = "Enter a whole number.";

    if (
      Object.keys(errs).length > 0 ||
      priceC === null ||
      installC === null ||
      reconC === null ||
      speedN === undefined ||
      channelsN === undefined
    ) {
      setErrors(errs);
      setFormError(null);
      return;
    }

    const descriptionValue = description.trim() === "" ? null : description.trim();

    setSaving(true);
    setErrors({});
    setFormError(null);

    let result;
    if (editing) {
      // Send only what changed, so the audit trail shows a clean before and after.
      const changes: Record<string, unknown> = {};
      if (name.trim() !== editing.name) changes.name = name.trim();
      if (priceC !== editing.priceCentavos) changes.priceCentavos = priceC;
      if (installC !== editing.installationFeeCentavos) changes.installationFeeCentavos = installC;
      if (reconC !== editing.reconnectionFeeCentavos) changes.reconnectionFeeCentavos = reconC;
      if (descriptionValue !== (editing.description ?? null)) changes.description = descriptionValue;
      if (speedN !== editing.speedMbps) changes.speedMbps = speedN;
      if (channelsN !== editing.channelCount) changes.channelCount = channelsN;
      if (isActive !== editing.isActive) changes.isActive = isActive;

      if (Object.keys(changes).length === 0) {
        setFormError("No changes to save.");
        setSaving(false);
        return;
      }
      if (reason.trim() !== "") changes.reason = reason.trim();
      result = await window.bcis.plans.update(editing.id, changes);
    } else {
      result = await window.bcis.plans.create({
        code: code.trim(),
        name: name.trim(),
        serviceType,
        priceCentavos: priceC,
        installationFeeCentavos: installC,
        reconnectionFeeCentavos: reconC,
        description: descriptionValue,
        ...(speedN !== null ? { speedMbps: speedN } : {}),
        ...(channelsN !== null ? { channelCount: channelsN } : {}),
      });
    }

    if (result.ok) {
      onSaved();
      return;
    }
    if (result.code === "UNAUTHENTICATED") {
      onExpired();
      return;
    }

    const serverErrors: Record<string, string> = {};
    for (const issue of result.issues ?? []) {
      const field = SERVER_FIELD[issue.path] ?? issue.path;
      if (field && !serverErrors[field]) serverErrors[field] = issue.message;
    }
    setErrors(serverErrors);
    setFormError(Object.keys(serverErrors).length > 0 ? null : result.message);
    setSaving(false);
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mb-6 rounded-lg border border-slate-200 bg-surface p-5"
    >
      <h2 className="text-base font-semibold text-navy">
        {editing ? `Edit plan ${editing.code}` : "New plan"}
      </h2>

      <fieldset className="mt-4" disabled={saving}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
          Plan details
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-3">
          <TextField
            label="Code"
            value={editing ? editing.code : code}
            onChange={setCode}
            required
            disabled={!!editing}
            error={errors.code}
            hint={editing ? "The code cannot be changed." : "Letters, digits and hyphens."}
            maxLength={20}
          />
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            required
            error={errors.name}
            maxLength={100}
          />
          <label className="block text-sm font-medium text-ink">
            Service type
            <select
              className="mt-1 block w-full rounded border border-slate-300 bg-surface px-3 py-2 font-normal disabled:bg-slate-100 disabled:opacity-70"
              value={serviceType}
              disabled={!!editing}
              onChange={(e) => setServiceType(e.target.value as ServiceTypeCode)}
            >
              {SERVICE_TYPE_CODES.map((c) => (
                <option key={c} value={c}>
                  {TYPE_LABEL[c]}
                </option>
              ))}
            </select>
            {editing && (
              <span className="mt-1 block text-xs font-normal text-muted">
                The type cannot be changed.
              </span>
            )}
          </label>
          {showSpeed && (
            <TextField
              label="Speed (Mbps)"
              value={speed}
              onChange={setSpeed}
              inputMode="numeric"
              error={errors.speed}
            />
          )}
          {showChannels && (
            <TextField
              label="Channel count"
              value={channels}
              onChange={setChannels}
              inputMode="numeric"
              error={errors.channels}
            />
          )}
        </div>
      </fieldset>

      <fieldset className="mt-5" disabled={saving}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
          Pricing
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-3">
          <MoneyField label="Monthly price" value={price} onChange={setPrice} required error={errors.price} />
          <MoneyField
            label="Installation fee"
            value={installation}
            onChange={setInstallation}
            error={errors.installation}
          />
          <MoneyField
            label="Reconnection fee"
            value={reconnection}
            onChange={setReconnection}
            error={errors.reconnection}
          />
        </div>
        {editing && (
          <p className="mt-2 text-xs text-muted">
            Price changes apply to future billing only. Existing invoices keep the rate they were billed at.
          </p>
        )}
      </fieldset>

      <fieldset className="mt-5" disabled={saving}>
        <legend className="text-xs font-semibold uppercase tracking-wide text-muted">Other</legend>
        <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="Description"
            value={description}
            onChange={setDescription}
            error={errors.description}
            maxLength={500}
          />
          {editing && (
            <TextField
              label="Reason for change"
              value={reason}
              onChange={setReason}
              hint="Recorded in the audit log."
              maxLength={200}
            />
          )}
        </div>
        {editing && (
          <label className="mt-4 flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Active (inactive plans cannot be chosen for new service accounts)
          </label>
        )}
      </fieldset>

      {formError && (
        <p
          role="alert"
          className="mt-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {formError}
        </p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : editing ? "Save changes" : "Create plan"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-slate-50 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
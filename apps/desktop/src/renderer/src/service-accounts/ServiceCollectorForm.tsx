import { useEffect, useState } from "react";
import { serviceCollectorChangeSchema } from "@bcis/shared";
import type { ServiceAccountDetailDto } from "../../../preload/index";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { useSave } from "./useSave";

const SUBSCRIBERS_COLLECTOR = "";

interface ServiceCollectorFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function ServiceCollectorForm({ account, onSaved, onCancel, onExpired }: ServiceCollectorFormProps) {
  const [collectorId, setCollectorId] = useState(account.assignedCollectorId ?? SUBSCRIBERS_COLLECTOR);
  const [reason, setReason] = useState("");
  const [options, setOptions] = useState<SelectOption[] | null>(null);
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  // Active collectors only, plus the current override even if it was since deactivated.
  useEffect(() => {
    void window.bcis.collectors.list(true).then((r) => {
      if (r.ok) {
        setOptions([
          { value: SUBSCRIBERS_COLLECTOR, label: "Subscriber's collector (no override)" },
          ...r.data
            .filter((c) => c.isActive || c.id === account.assignedCollectorId)
            .map((c) => ({ value: c.id, label: `${c.code} – ${c.fullName}${c.isActive ? "" : " (inactive)"}` })),
        ]);
      } else if (r.code === "UNAUTHENTICATED") {
        onExpired();
      } else {
        reject({}, `Could not load collectors. ${r.message}`);
      }
    });
  }, [account.assignedCollectorId, onExpired]);

  function submit() {
    const assignedCollectorId = collectorId === SUBSCRIBERS_COLLECTOR ? null : collectorId;
    if (assignedCollectorId === account.assignedCollectorId) return reject({}, "No changes to save.");

    const parsed = serviceCollectorChangeSchema.safeParse({
      assignedCollectorId,
      ...(reason.trim() !== "" ? { reason } : {}),
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceAccounts.changeCollector(account.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Change collector"
      submitLabel="Save collector"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      {!options ? (
        !formError && <p className="text-sm text-muted">Loading collectors…</p>
      ) : (
        <>
          <SelectField
            label="Collector for this service"
            value={collectorId}
            onChange={setCollectorId}
            options={options}
            error={errors.assignedCollectorId}
          />
          <TextField
            label="Reason for change"
            value={reason}
            onChange={setReason}
            error={errors.reason}
            hint="Optional. Recorded in the service history."
            maxLength={200}
          />
        </>
      )}
    </ProfileForm>
  );
}

import { useEffect, useState } from "react";
import type { SubscriberDto } from "../../../preload/index";
import { SelectField, type SelectOption } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { failureToErrors, ProfileForm } from "./ProfileForm";

const NONE = "";

interface AssignmentFormProps {
  subscriber: SubscriberDto;
  onSaved: (updated: SubscriberDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function AssignmentForm({ subscriber, onSaved, onCancel, onExpired }: AssignmentFormProps) {
  const [areaId, setAreaId] = useState(subscriber.collectionAreaId ?? NONE);
  const [collectorId, setCollectorId] = useState(subscriber.assignedCollectorId ?? NONE);
  const [reason, setReason] = useState("");

  const [areaOptions, setAreaOptions] = useState<SelectOption[] | null>(null);
  const [collectorOptions, setCollectorOptions] = useState<SelectOption[] | null>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Only active areas and collectors can be chosen. The current one stays listed
  // even if it was deactivated, so the form shows the real assignment.
  useEffect(() => {
    void Promise.all([window.bcis.collectionAreas.list(true), window.bcis.collectors.list(true)]).then(
      ([areas, collectors]) => {
        if (!areas.ok || !collectors.ok) {
          const failure = !areas.ok ? areas : !collectors.ok ? collectors : null;
          if (failure?.code === "UNAUTHENTICATED") return onExpired();
          setFormError(`Could not load areas and collectors. ${failure?.message ?? ""}`);
          return;
        }
        setAreaOptions([
          { value: NONE, label: "Not assigned" },
          ...areas.data
            .filter((a) => a.isActive || a.id === subscriber.collectionAreaId)
            .map((a) => ({ value: a.id, label: `${a.code} – ${a.name}${a.isActive ? "" : " (inactive)"}` })),
        ]);
        setCollectorOptions([
          { value: NONE, label: "Not assigned" },
          ...collectors.data
            .filter((c) => c.isActive || c.id === subscriber.assignedCollectorId)
            .map((c) => ({ value: c.id, label: `${c.code} – ${c.fullName}${c.isActive ? "" : " (inactive)"}` })),
        ]);
      },
    );
  }, [subscriber.collectionAreaId, subscriber.assignedCollectorId, onExpired]);

  async function save() {
    const newArea = areaId === NONE ? null : areaId;
    const newCollector = collectorId === NONE ? null : collectorId;
    if (newArea === subscriber.collectionAreaId && newCollector === subscriber.assignedCollectorId) {
      setFormError("No changes to save.");
      return;
    }

    setSaving(true);
    setErrors({});
    setFormError(null);
    const result = await window.bcis.subscribers.changeAssignment(subscriber.id, {
      collectionAreaId: newArea,
      assignedCollectorId: newCollector,
      ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
    });
    if (result.ok) return onSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onExpired();
    const mapped = failureToErrors(result);
    setErrors(mapped.fields);
    setFormError(mapped.form);
    setSaving(false);
  }

  return (
    <ProfileForm
      title="Change collection assignment"
      submitLabel="Save assignment"
      saving={saving}
      error={formError}
      onSubmit={() => void save()}
      onCancel={onCancel}
    >
      {!areaOptions || !collectorOptions ? (
        !formError && <p className="text-sm text-muted">Loading areas and collectors…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <SelectField label="Area" value={areaId} onChange={setAreaId} options={areaOptions} error={errors.collectionAreaId} />
            <SelectField
              label="Collector"
              value={collectorId}
              onChange={setCollectorId}
              options={collectorOptions}
              error={errors.assignedCollectorId}
            />
          </div>
          <TextField label="Reason for change" value={reason} onChange={setReason} error={errors.reason} hint="Optional. Recorded in the history." maxLength={200} />
        </>
      )}
    </ProfileForm>
  );
}

import { useEffect, useState } from "react";
import { batchCreateSchema } from "@bcis/shared";
import type { AreaDto, CollectorDto, CreateBatchResultDto } from "../../../preload/index";
import { todayLocal } from "../payments/paymentLabels";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors, TextAreaField } from "../subscribers/ProfileForm";
import { DateField } from "../ui/DateField";
import { SelectField } from "../ui/SelectField";

interface NewBatchFormProps {
  onCreated: (result: CreateBatchResultDto) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
}

/**
 * Builds a batch: the server picks the collector's subscribers who owe something (optionally
 * one area only) and freezes what each owes for the route sheet.
 */
export function NewBatchForm({ onCreated, onCancel, onSessionExpired }: NewBatchFormProps) {
  const [collectors, setCollectors] = useState<CollectorDto[]>([]);
  const [areas, setAreas] = useState<AreaDto[]>([]);
  const [collectorId, setCollectorId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [collectionDate, setCollectionDate] = useState(todayLocal());
  const [notes, setNotes] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onCreated, onSessionExpired);

  // Active only: a batch cannot be built for an inactive collector or area.
  useEffect(() => {
    void Promise.all([window.bcis.collectors.list(false), window.bcis.collectionAreas.list(false)]).then(
      ([c, a]) => {
        if (!c.ok || !a.ok) {
          const failed = !c.ok ? c : !a.ok ? a : null;
          if (failed?.code === "UNAUTHENTICATED") onSessionExpired();
          else reject({}, `Could not load collectors and areas. ${failed?.message ?? ""}`);
          return;
        }
        setCollectors(c.data);
        setAreas(a.data);
      },
    );
  }, [onSessionExpired, reject]);

  function submit() {
    const parsed = batchCreateSchema.safeParse({
      collectorId,
      collectionAreaId: areaId || null,
      collectionDate,
      notes: notes.trim() || null,
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.batches.create(parsed.data));
  }

  return (
    <ProfileForm
      title="New collection batch"
      submitLabel="Build batch"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <SelectField
          label="Collector"
          value={collectorId}
          onChange={setCollectorId}
          required
          error={errors.collectorId}
          options={[
            { value: "", label: "Choose a collector" },
            ...collectors.map((c) => ({ value: c.id, label: `${c.code} · ${c.fullName}` })),
          ]}
        />
        <SelectField
          label="Area"
          value={areaId}
          onChange={setAreaId}
          error={errors.collectionAreaId}
          options={[{ value: "", label: "All of the collector's areas" }, ...areas.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]}
        />
        <DateField
          label="Collection date"
          value={collectionDate}
          onChange={setCollectionDate}
          required
          error={errors.collectionDate}
        />
      </div>
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={500} />
      <p className="text-xs text-muted">
        The batch takes every subscriber of this collector who owes something today, and freezes their current bill,
        arrears and total due for the route sheet. Subscribers already on another open or in-progress batch are left out.
      </p>
    </ProfileForm>
  );
}

import { useState } from "react";
import { formatPesos, serviceRateChangeSchema, tryParsePesos } from "@bcis/shared";
import type { ServiceAccountDetailDto } from "../../../preload/index";
import { DateField } from "../ui/DateField";
import { centavosToInput, MoneyField } from "../ui/MoneyField";
import { TextField } from "../ui/TextField";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { useSave } from "./useSave";

interface ServiceRateFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function ServiceRateForm({ account, onSaved, onCancel, onExpired }: ServiceRateFormProps) {
  const [rate, setRate] = useState(centavosToInput(account.currentRateCentavos));
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    // Pesos become centavos here, at the form edge; nothing past this point sees a float.
    const rateCentavos = tryParsePesos(rate);
    if (rateCentavos === null) return reject({ rateCentavos: "Enter a valid peso amount, for example 999.00." });
    if (rateCentavos === account.currentRateCentavos) return reject({}, "The rate is unchanged. No changes to save.");

    const parsed = serviceRateChangeSchema.safeParse({
      rateCentavos,
      reason,
      ...(effectiveDate ? { effectiveDate } : {}),
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceAccounts.changeRate(account.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Change monthly rate"
      submitLabel="Save rate"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="text-xs text-muted">
        Current rate {formatPesos(account.currentRateCentavos)}. The {account.planCode} plan's price is{" "}
        {formatPesos(account.planPriceCentavos)}. The new rate applies to future billing only.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <MoneyField label="New monthly rate" value={rate} onChange={setRate} required error={errors.rateCentavos} />
        <DateField
          label="Effective date"
          value={effectiveDate}
          onChange={setEffectiveDate}
          error={errors.effectiveDate}
          hint="Leave blank for today."
        />
      </div>
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Recorded in the service history, e.g. promo or senior discount."
        maxLength={200}
      />
    </ProfileForm>
  );
}

import { useEffect, useState } from "react";
import { formatPesos, servicePlanChangeSchema, tryParsePesos } from "@bcis/shared";
import type { PlanDto, ServiceAccountDetailDto } from "../../../preload/index";
import { DateField } from "../ui/DateField";
import { centavosToInput, MoneyField } from "../ui/MoneyField";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { serviceTypeLabel } from "../subscribers/status";
import { useSave } from "./useSave";

interface ServicePlanFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function ServicePlanForm({ account, onSaved, onCancel, onExpired }: ServicePlanFormProps) {
  const [plans, setPlans] = useState<PlanDto[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  // Only active plans can be chosen, and not the one the service is already on.
  useEffect(() => {
    void window.bcis.plans.list(false).then((r) => {
      if (r.ok) setPlans(r.data.filter((p) => p.id !== account.planId));
      else if (r.code === "UNAUTHENTICATED") onExpired();
      else reject({}, `Could not load plans. ${r.message}`);
    });
  }, [account.planId, onExpired, reject]);

  // Choosing a plan fills in its price; the rate can still be changed for a special rate.
  function choosePlan(id: string) {
    setPlanId(id);
    const plan = plans?.find((p) => p.id === id);
    setRate(plan ? centavosToInput(plan.priceCentavos) : "");
  }

  function submit() {
    if (!planId) return reject({ planId: "Choose the new plan." });
    const rateCentavos = tryParsePesos(rate);
    if (rateCentavos === null) return reject({ rateCentavos: "Enter a valid peso amount, for example 999.00." });

    const parsed = servicePlanChangeSchema.safeParse({
      planId,
      rateCentavos,
      reason,
      ...(effectiveDate ? { effectiveDate } : {}),
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceAccounts.changePlan(account.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Change plan"
      submitLabel="Save plan"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      {!plans ? (
        !formError && <p className="text-sm text-muted">Loading plans…</p>
      ) : (
        <>
          <p className="text-xs text-muted">
            Now on {account.planCode} – {account.planName} at {formatPesos(account.currentRateCentavos)}/month.
          </p>
          <SelectField
            label="New plan"
            value={planId}
            onChange={choosePlan}
            options={[
              { value: "", label: "Choose a plan…" },
              ...plans.map((p) => ({
                value: p.id,
                label: `${serviceTypeLabel(p.serviceType)} · ${p.code} – ${p.name} (${formatPesos(p.priceCentavos)}/month)`,
              })),
            ]}
            required
            error={errors.planId}
          />
          <div className="grid grid-cols-2 gap-3">
            <MoneyField label="Monthly rate" value={rate} onChange={setRate} required error={errors.rateCentavos} />
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
            hint="Recorded in the service history."
            maxLength={200}
          />
        </>
      )}
    </ProfileForm>
  );
}

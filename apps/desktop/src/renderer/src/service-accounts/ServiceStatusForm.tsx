import { useState } from "react";
import {
  allowedServiceTransitions,
  serviceStatusChangeSchema,
  type ServiceAccountStatus,
} from "@bcis/shared";
import type { ServiceAccountDetailDto } from "../../../preload/index";
import { DateField } from "../ui/DateField";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { useSave } from "./useSave";

/** The status options a closed subscriber's service still has: only termination. */
export function serviceStatusOptions(account: ServiceAccountDetailDto): readonly ServiceAccountStatus[] {
  const closed = account.subscriberStatus === "terminated" || account.subscriberStatus === "archived";
  return allowedServiceTransitions(account.status as ServiceAccountStatus).filter(
    (s) => !closed || s === "terminated",
  );
}

/** The action as a person would say it, which depends on where the service is now. */
function actionLabel(from: string, to: ServiceAccountStatus): string {
  if (to === "active") return from === "pending" ? "Activate (installed)" : "Reconnect";
  if (to === "suspended") return "Suspend";
  return from === "pending" ? "Cancel (terminate before installation)" : "Terminate";
}

const WARNINGS: Partial<Record<ServiceAccountStatus, string>> = {
  suspended: "A suspended service is not billed until it is reconnected.",
  terminated: "Terminating is final. The service cannot be reactivated and its record becomes read-only.",
};

interface ServiceStatusFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function ServiceStatusForm({ account, onSaved, onCancel, onExpired }: ServiceStatusFormProps) {
  const options = serviceStatusOptions(account);
  const [status, setStatus] = useState<ServiceAccountStatus | "">(options[0] ?? "");
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [billingStartDate, setBillingStartDate] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  const firstActivation = account.status === "pending" && status === "active";
  const warning = status ? WARNINGS[status] : undefined;

  function submit() {
    const payload = {
      status,
      reason,
      ...(effectiveDate ? { effectiveDate } : {}),
      ...(firstActivation && billingStartDate ? { billingStartDate } : {}),
    };
    const parsed = serviceStatusChangeSchema.safeParse(payload);
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceAccounts.changeStatus(account.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Change service status"
      submitLabel="Save status"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Action"
          value={status}
          onChange={(v) => setStatus(v as ServiceAccountStatus)}
          options={options.map((s) => ({ value: s, label: actionLabel(account.status, s) }))}
          required
          error={errors.status}
        />
        <DateField
          label={firstActivation ? "Activation date" : "Effective date"}
          value={effectiveDate}
          onChange={setEffectiveDate}
          error={errors.effectiveDate}
          hint="Leave blank for today."
        />
      </div>
      {firstActivation && (
        <div className="grid grid-cols-2 gap-3">
          <div />
          <DateField
            label="Billing starts"
            value={billingStartDate}
            onChange={setBillingStartDate}
            error={errors.billingStartDate}
            hint="Leave blank to start billing on the activation date."
          />
        </div>
      )}
      {warning && (
        <p className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">{warning}</p>
      )}
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Recorded in the service history."
        maxLength={200}
      />
    </ProfileForm>
  );
}

import { useEffect, useMemo, useState } from "react";
import { formatPesos } from "@bcis/shared";
import type { ServiceAccountDetailDto } from "../../../preload/index";
import { ActionButton, Field, formatDateTime, Section } from "../subscribers/ProfileParts";
import { serviceTypeLabel, StatusBadge } from "../subscribers/status";
import { ServiceCollectorForm } from "./ServiceCollectorForm";
import { ServiceEditForm } from "./ServiceEditForm";
import { describeServiceEvent, type ServiceHistoryLookups } from "./serviceHistory";
import { ServicePlanForm } from "./ServicePlanForm";
import { ServiceRateForm } from "./ServiceRateForm";
import { ServiceStatusForm, serviceStatusOptions } from "./ServiceStatusForm";

type Editing = "status" | "edit" | "rate" | "plan" | "collector" | null;

interface ServiceAccountScreenProps {
  serviceAccountId: string;
  canManage: boolean;
  /** Where Back goes, e.g. "Back to Ben Cruz" or "Back to service accounts". */
  backLabel: string;
  onBack: () => void;
  onSessionExpired: () => void;
}

export function ServiceAccountScreen({
  serviceAccountId,
  canManage,
  backLabel,
  onBack,
  onSessionExpired,
}: ServiceAccountScreenProps) {
  const [account, setAccount] = useState<ServiceAccountDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [planNames, setPlanNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [collectorNames, setCollectorNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void window.bcis.serviceAccounts.get(serviceAccountId).then((r) => {
      if (cancelled) return;
      if (r.ok) setAccount(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [serviceAccountId, onSessionExpired]);

  // Only used to name plans and collectors in the history. Without plan.view or
  // collection.view the history falls back to "a plan" / "a collector".
  useEffect(() => {
    void window.bcis.plans.list(true).then((r) => {
      if (r.ok) setPlanNames(new Map(r.data.map((p) => [p.id, `${p.code} – ${p.name}`])));
    });
    void window.bcis.collectors.list(true).then((r) => {
      if (r.ok) setCollectorNames(new Map(r.data.map((c) => [c.id, `${c.code} – ${c.fullName}`])));
    });
  }, []);

  const lookups: ServiceHistoryLookups = useMemo(
    () => ({ plans: planNames, collectors: collectorNames }),
    [planNames, collectorNames],
  );

  // Every change endpoint returns the full account, history included.
  function handleSaved(updated: ServiceAccountDetailDto) {
    setAccount(updated);
    setEditing(null);
  }

  return (
    <div>
      <button className="mb-4 text-sm text-accent hover:underline" onClick={onBack}>
        ← {backLabel}
      </button>

      {loadError && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the service account. {loadError}
        </p>
      )}
      {!account && !loadError && <p className="text-muted">Loading…</p>}

      {account && (
        <ServiceAccountDetail
          account={account}
          canManage={canManage}
          editing={editing}
          lookups={lookups}
          onEdit={setEditing}
          onSaved={handleSaved}
          onSessionExpired={onSessionExpired}
        />
      )}
    </div>
  );
}

interface ServiceAccountDetailProps {
  account: ServiceAccountDetailDto;
  canManage: boolean;
  editing: Editing;
  lookups: ServiceHistoryLookups;
  onEdit: (editing: Editing) => void;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onSessionExpired: () => void;
}

function ServiceAccountDetail({
  account,
  canManage,
  editing,
  lookups,
  onEdit,
  onSaved,
  onSessionExpired,
}: ServiceAccountDetailProps) {
  // Hiding controls is cosmetic: the server enforces service.manage and the terminated rule.
  const terminated = account.status === "terminated";
  const editable = canManage && !terminated && editing === null;
  const canChangeStatus = canManage && editing === null && serviceStatusOptions(account).length > 0;
  const formProps = { account, onSaved, onCancel: () => onEdit(null), onExpired: onSessionExpired };
  const rateDiffers = account.currentRateCentavos !== account.planPriceCentavos;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold text-navy">
            {account.serviceNumber}
            <span className="font-normal text-muted">
              {serviceTypeLabel(account.serviceType)} · {account.planName}
            </span>
            <StatusBadge status={account.status} />
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted">
            {account.subscriberName} · {account.accountNumber}
            {account.subscriberStatus !== "active" && <StatusBadge status={account.subscriberStatus} />}
          </p>
        </div>
        {canChangeStatus && <ActionButton label="Change status" onClick={() => onEdit("status")} />}
      </div>

      {terminated && (
        <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-muted">
          This service is terminated. Its record is read-only.
        </p>
      )}

      {editing === "status" && <ServiceStatusForm {...formProps} />}

      <div className="grid grid-cols-2 gap-4">
        <Section
          title="Service"
          action={editable && <ActionButton label="Edit" onClick={() => onEdit("edit")} />}
        >
          {editing === "edit" && <ServiceEditForm {...formProps} />}
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Installation address">
              {account.addressLine1}, {account.addressBarangay}, {account.addressCity}
            </Field>
            <Field label="Billing day">Day {account.billingDay} of each month</Field>
            <Field label="Activated">{account.activationDate ?? <span className="text-muted">Not yet</span>}</Field>
            <Field label="Billing starts">
              {account.billingStartDate ?? <span className="text-muted">On activation</span>}
            </Field>
            <div className="col-span-2">
              <Field label="Notes">
                {account.notes ? (
                  <span className="whitespace-pre-wrap">{account.notes}</span>
                ) : (
                  <span className="text-muted">None</span>
                )}
              </Field>
            </div>
          </dl>
        </Section>

        <Section
          title="Plan and rate"
          action={
            editable && (
              <span className="flex gap-1">
                <ActionButton label="Change plan" onClick={() => onEdit("plan")} />
                <ActionButton label="Change rate" onClick={() => onEdit("rate")} />
              </span>
            )
          }
        >
          {editing === "plan" && <ServicePlanForm {...formProps} />}
          {editing === "rate" && <ServiceRateForm {...formProps} />}
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Plan">
              {account.planCode} – {account.planName}
            </Field>
            <Field label="Monthly rate">
              <span className="money text-base font-semibold">{formatPesos(account.currentRateCentavos)}</span>
              {rateDiffers && (
                <span className="block text-xs text-muted">
                  Plan price now {formatPesos(account.planPriceCentavos)}
                </span>
              )}
            </Field>
          </dl>
        </Section>
      </div>

      <Section
        title="Collection"
        action={editable && <ActionButton label="Change collector" onClick={() => onEdit("collector")} />}
      >
        {editing === "collector" && <ServiceCollectorForm {...formProps} />}
        <dl>
          <Field label="Collector">
            {account.collectorCode ? `${account.collectorCode} – ${account.collectorName}` : "Not assigned"}
            <span className="ml-2 text-xs text-muted">
              {account.assignedCollectorId ? "(set for this service)" : "(subscriber's collector)"}
            </span>
          </Field>
        </dl>
      </Section>

      <Section title="Service history">
        {account.events.length === 0 ? (
          <p className="text-sm text-muted">No recorded changes.</p>
        ) : (
          <ol className="divide-y divide-slate-100">
            {account.events.map((event) => {
              const entry = describeServiceEvent(event, lookups);
              return (
                <li key={event.id} className="py-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="font-medium text-ink">{entry.title}</span>
                    <span className="shrink-0 text-xs text-muted">{formatDateTime(event.occurredAt)}</span>
                  </div>
                  {entry.details.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-ink">
                      {entry.details.map((detail, i) => (
                        <li key={i}>{detail}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-1 text-xs text-muted">
                    By {event.actorName ?? event.actorUsername ?? "system"}
                    {event.reason && <> · Reason: {event.reason}</>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
    </div>
  );
}

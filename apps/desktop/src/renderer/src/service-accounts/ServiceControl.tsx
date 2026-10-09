import { useEffect, useState } from "react";
import {
  formatPesos,
  RECONNECTION_STATUS_LABELS,
  reconnectionCancelSchema,
  reconnectionCompleteSchema,
  reconnectionRequestSchema,
  serviceSuspendSchema,
  type ReconnectionStatus,
} from "@bcis/shared";
import type {
  ReconnectionDto,
  ServiceAccountDetailDto,
  ServiceControlHistoryDto,
  TechnicianDto,
} from "../../../preload/index";
import { ProfileForm, schemaErrors, TextAreaField } from "../subscribers/ProfileForm";
import { ActionButton, formatDateTime, Section } from "../subscribers/ProfileParts";
import { Badge, type BadgeTone } from "../ui/Badge";
import { DateField } from "../ui/DateField";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import { useSave } from "./useSave";

/* -------------------------------- Badges -------------------------------- */

const RECONNECTION_TONE: Record<ReconnectionStatus, BadgeTone> = {
  requested: "warning",
  assigned: "warning",
  completed: "success",
  cancelled: "neutral",
};

export function ReconnectionStatusBadge({ status }: { status: string }) {
  const known = status as ReconnectionStatus;
  return <Badge tone={RECONNECTION_TONE[known] ?? "neutral"}>{RECONNECTION_STATUS_LABELS[known] ?? status}</Badge>;
}

export function feeText(r: Pick<ReconnectionDto, "feeCentavos" | "feeWaived">): string {
  if (r.feeCentavos === 0) return "No fee";
  return r.feeWaived ? `${formatPesos(r.feeCentavos)} waived` : formatPesos(r.feeCentavos);
}

const isOpen = (r: ReconnectionDto) => r.status === "requested" || r.status === "assigned";

/* ------------------------------- Suspend ------------------------------- */

interface SuspendFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (updated: ServiceAccountDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

/** Suspension (spec 3.10): reason, effective date, who approved it and notes. */
export function SuspendForm({ account, onSaved, onCancel, onExpired }: SuspendFormProps) {
  const [reason, setReason] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [notes, setNotes] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = serviceSuspendSchema.safeParse({
      reason,
      approvedBy,
      ...(effectiveDate ? { effectiveDate } : {}),
      ...(notes.trim() ? { notes } : {}),
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceControl.suspend(account.id, parsed.data));
  }

  return (
    <ProfileForm title="Suspend service" submitLabel="Suspend" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <p className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
        A suspended service is not billed. It comes back only through a reconnection, once its past-due bills are
        paid.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Approved by" value={approvedBy} onChange={setApprovedBy} required error={errors.approvedBy} maxLength={100} />
        <DateField
          label="Effective date"
          value={effectiveDate}
          onChange={setEffectiveDate}
          error={errors.effectiveDate}
          hint="Leave blank for today."
        />
      </div>
      <TextField label="Reason" value={reason} onChange={setReason} required error={errors.reason} maxLength={200} />
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={500} />
    </ProfileForm>
  );
}

/* ------------------------- Request reconnection ------------------------- */

interface RequestFormProps {
  account: ServiceAccountDetailDto;
  onSaved: (created: ReconnectionDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

export function RequestReconnectionForm({ account, onSaved, onCancel, onExpired }: RequestFormProps) {
  const [requestDate, setRequestDate] = useState("");
  const [waiveFee, setWaiveFee] = useState(false);
  const [feeWaiverReason, setFeeWaiverReason] = useState("");
  const [notes, setNotes] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = reconnectionRequestSchema.safeParse({
      waiveFee,
      ...(requestDate ? { requestDate } : {}),
      ...(waiveFee ? { feeWaiverReason } : {}),
      ...(notes.trim() ? { notes } : {}),
    });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceControl.requestReconnection(account.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Request reconnection"
      submitLabel="Request reconnection"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted">
        Allowed once no past-due bill of this service is unpaid; the current bill may still be open. The plan&apos;s
        reconnection fee goes on the next bill unless you waive it.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <DateField
          label="Request date"
          value={requestDate}
          onChange={setRequestDate}
          error={errors.requestDate}
          hint="Leave blank for today."
        />
        <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-ink">
          <input type="checkbox" checked={waiveFee} onChange={(e) => setWaiveFee(e.target.checked)} />
          Waive the reconnection fee
        </label>
      </div>
      {waiveFee && (
        <TextField
          label="Why is the fee waived?"
          value={feeWaiverReason}
          onChange={setFeeWaiverReason}
          required
          error={errors.feeWaiverReason}
          maxLength={200}
        />
      )}
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={500} />
    </ProfileForm>
  );
}

/* --------------------------- Open reconnection --------------------------- */

type Step = "assign" | "complete" | "cancel" | null;

interface OpenReconnectionProps {
  reconnection: ReconnectionDto;
  canControl: boolean;
  onChanged: () => void;
  onExpired: () => void;
}

/** The job in progress: who has it, and the next step (assign, complete or cancel). */
function OpenReconnection({ reconnection, canControl, onChanged, onExpired }: OpenReconnectionProps) {
  const [step, setStep] = useState<Step>(null);
  const done = () => {
    setStep(null);
    onChanged();
  };
  const formProps = { reconnection, onSaved: done, onCancel: () => setStep(null), onExpired };

  return (
    <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold text-ink">Reconnection in progress</span>{" "}
          <ReconnectionStatusBadge status={reconnection.status} />
          <span className="block text-muted">
            Requested {reconnection.requestDate} by {reconnection.requestedByName} · Fee {feeText(reconnection)}
            {reconnection.technicianName && <> · Technician: {reconnection.technicianName}</>}
          </span>
        </div>
        {canControl && step === null && (
          <span className="flex gap-1">
            <ActionButton label={reconnection.technicianName ? "Reassign" : "Assign technician"} onClick={() => setStep("assign")} />
            <ActionButton label="Mark completed" onClick={() => setStep("complete")} />
            <ActionButton label="Cancel request" onClick={() => setStep("cancel")} />
          </span>
        )}
      </div>
      {step !== null && <div className="mt-3">
        {step === "assign" && <AssignForm {...formProps} />}
        {step === "complete" && <CompleteForm {...formProps} />}
        {step === "cancel" && <CancelForm {...formProps} />}
      </div>}
    </div>
  );
}

interface StepFormProps {
  reconnection: ReconnectionDto;
  onSaved: () => void;
  onCancel: () => void;
  onExpired: () => void;
}

function AssignForm({ reconnection, onSaved, onCancel, onExpired }: StepFormProps) {
  const [technicians, setTechnicians] = useState<TechnicianDto[] | null>(null);
  const [technicianUserId, setTechnicianUserId] = useState(reconnection.technicianUserId ?? "");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.serviceControl.technicians().then((r) => {
      if (cancelled) return;
      if (r.ok) setTechnicians(r.data);
      else if (r.code === "UNAUTHENTICATED") onExpired();
      else reject({}, r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [onExpired, reject]);

  function submit() {
    if (!technicianUserId) return reject({ technicianUserId: "Choose a technician." });
    void save(() => window.bcis.serviceControl.assign(reconnection.id, technicianUserId));
  }

  const options = [
    { value: "", label: technicians === null ? "Loading…" : "Choose a technician" },
    ...(technicians ?? []).map((t) => ({ value: t.id, label: t.fullName })),
  ];
  return (
    <ProfileForm title="Assign technician" submitLabel="Assign" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      {technicians !== null && technicians.length === 0 ? (
        <p className="text-sm text-muted">No active user has the Technician role. An administrator can add one.</p>
      ) : (
        <SelectField
          label="Technician"
          value={technicianUserId}
          onChange={setTechnicianUserId}
          options={options}
          required
          error={errors.technicianUserId}
        />
      )}
    </ProfileForm>
  );
}

function CompleteForm({ reconnection, onSaved, onCancel, onExpired }: StepFormProps) {
  const [completionDate, setCompletionDate] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = reconnectionCompleteSchema.safeParse(completionDate ? { completionDate } : {});
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceControl.complete(reconnection.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Mark reconnection completed"
      submitLabel="Reconnect service"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted">
        The service becomes Active and is billed again from the next billing run.
        {!reconnection.feeWaived && reconnection.feeCentavos > 0 && (
          <> The reconnection fee of {formatPesos(reconnection.feeCentavos)} goes on that bill.</>
        )}
      </p>
      <DateField
        label="Completion date"
        value={completionDate}
        onChange={setCompletionDate}
        error={errors.completionDate}
        hint="Leave blank for today."
      />
    </ProfileForm>
  );
}

function CancelForm({ reconnection, onSaved, onCancel, onExpired }: StepFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = reconnectionCancelSchema.safeParse({ reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.serviceControl.cancel(reconnection.id, parsed.data.reason));
  }

  return (
    <ProfileForm title="Cancel reconnection" submitLabel="Cancel reconnection" saving={saving} error={formError} onSubmit={submit} onCancel={onCancel}>
      <p className="text-sm text-muted">The service stays suspended. A new request can be made later.</p>
      <TextField label="Reason" value={reason} onChange={setReason} required error={errors.reason} maxLength={200} />
    </ProfileForm>
  );
}

/* ------------------------------- History ------------------------------- */

interface ServiceControlSectionProps {
  account: ServiceAccountDetailDto;
  canControl: boolean;
  /** Bumped by the screen after a suspension or request so the history reloads. */
  reloadKey: number;
  /** Called after a step that may change the account (completion makes it active). */
  onChanged: () => void;
  onOpenReconnection?: (open: boolean) => void;
  onExpired: () => void;
}

/** Suspension and reconnection history of one service (spec 3.10), with the open job on top. */
export function ServiceControlSection({
  account,
  canControl,
  reloadKey,
  onChanged,
  onOpenReconnection,
  onExpired,
}: ServiceControlSectionProps) {
  const [history, setHistory] = useState<ServiceControlHistoryDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.serviceControl.history(account.id).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setHistory(r.data);
        setLoadError(null);
      } else if (r.code === "UNAUTHENTICATED") onExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [account.id, reloadKey, onExpired]);

  const open = history?.reconnections.find(isOpen) ?? null;
  useEffect(() => onOpenReconnection?.(open !== null), [open, onOpenReconnection]);

  // Nothing ever happened here: keep the screen short.
  if (history && history.suspensions.length === 0 && history.reconnections.length === 0 && !loadError) return null;

  return (
    <Section title="Suspension and reconnection">
      {loadError && (
        <p role="alert" className="text-sm text-danger">
          Could not load the suspension history. {loadError}
        </p>
      )}
      {!history && !loadError && <p className="text-sm text-muted">Loading…</p>}
      {open && <OpenReconnection reconnection={open} canControl={canControl} onChanged={onChanged} onExpired={onExpired} />}
      {history && (
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Suspensions</h3>
            {history.suspensions.length === 0 ? (
              <p className="text-muted">None.</p>
            ) : (
              <ol className="divide-y divide-slate-100">
                {history.suspensions.map((s) => (
                  <li key={s.id} className="py-2">
                    <div className="font-medium text-ink">Suspended {s.effectiveDate}</div>
                    <div>{s.reason}</div>
                    <div className="text-xs text-muted">
                      Approved by {s.approvedBy} · Recorded by {s.suspendedByName} on {formatDateTime(s.createdAt)}
                    </div>
                    <div className="text-xs text-muted">
                      At the time: {s.pastDueInvoiceCount} past-due invoice{s.pastDueInvoiceCount === 1 ? "" : "s"},{" "}
                      <span className="tabular-nums">{formatPesos(s.pastDueCentavos)}</span>
                    </div>
                    {s.notes && <div className="mt-1 whitespace-pre-wrap text-xs">{s.notes}</div>}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Reconnections</h3>
            {history.reconnections.length === 0 ? (
              <p className="text-muted">None.</p>
            ) : (
              <ol className="divide-y divide-slate-100">
                {history.reconnections.map((r) => (
                  <li key={r.id} className="py-2">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      Requested {r.requestDate} <ReconnectionStatusBadge status={r.status} />
                    </div>
                    <div className="text-xs text-muted">
                      By {r.requestedByName} · Fee {feeText(r)}
                      {r.feeWaiverReason && <> ({r.feeWaiverReason})</>}
                    </div>
                    {r.technicianName && <div className="text-xs text-muted">Technician: {r.technicianName}</div>}
                    {r.status === "completed" && (
                      <div className="text-xs text-muted">
                        Completed {r.completionDate} by {r.completedByName}
                      </div>
                    )}
                    {r.status === "cancelled" && (
                      <div className="text-xs text-muted">
                        Cancelled by {r.cancelledByName}: {r.cancelReason}
                      </div>
                    )}
                    {r.notes && <div className="mt-1 whitespace-pre-wrap text-xs">{r.notes}</div>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

import { useState, type ReactNode } from "react";
import {
  batchReconcileSchema,
  cashVariance,
  formatPesos,
  remittanceCreateSchema,
  remittanceVoidSchema,
  tryParsePesos,
  VARIANCE_KIND_LABELS,
  type VarianceKind,
} from "@bcis/shared";
import type { BatchDetailDto, BatchRemittanceDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors, TextAreaField } from "../subscribers/ProfileForm";
import { ActionButton, formatDateTime, RowError, Section } from "../subscribers/ProfileParts";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { MoneyField } from "../ui/MoneyField";
import { TextField } from "../ui/TextField";
import { Confirm } from "./Confirm";

/** "₱500.00 shortage", "₱0.00 (balanced)". */
export function differenceText(differenceCentavos: number): string {
  if (differenceCentavos === 0) return "₱0.00 (balanced)";
  return `${formatPesos(Math.abs(differenceCentavos))} ${differenceCentavos < 0 ? "shortage" : "overage"}`;
}

/** Text plus colour: a shortage is red, an overage amber, balanced green. */
export function VarianceBadge({ kind }: { kind: VarianceKind }) {
  const tone = kind === "balanced" ? "success" : kind === "shortage" ? "danger" : "warning";
  return <Badge tone={tone}>{VARIANCE_KIND_LABELS[kind]}</Badge>;
}

function Figure({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-ink">
        {value} {children}
      </dd>
    </div>
  );
}

/* ------------------------------ Remittances ------------------------------ */

interface RemittancesSectionProps {
  batch: BatchDetailDto;
  canRecord: boolean;
  onChanged: (updated: BatchDetailDto) => void;
  onSessionExpired: () => void;
}

/** Cash the collector handed over. A wrong entry is voided with a reason and stays listed. */
export function RemittancesSection({ batch, canRecord, onChanged, onSessionExpired }: RemittancesSectionProps) {
  const open = batch.status === "submitted" || batch.status === "remitted";
  const [recording, setRecording] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  const columns: Column<BatchRemittanceDto>[] = [
    {
      key: "received",
      header: "Received",
      render: (r) => (
        <>
          {formatDateTime(r.received.at)}
          <span className="block text-xs text-muted">by {r.received.byName}</span>
        </>
      ),
    },
    { key: "notes", header: "Notes", render: (r) => r.notes ?? "" },
    {
      key: "status",
      header: "Status",
      render: (r) =>
        r.voided ? (
          <>
            <Badge tone="danger">Voided</Badge>
            <span className="block text-xs text-muted">
              {r.voided.reason} · {r.voided.byName}
            </span>
          </>
        ) : (
          <Badge tone="success">Counted</Badge>
        ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (r) => <span className={r.voided ? "text-muted line-through" : ""}>{formatPesos(r.amountCentavos)}</span>,
    },
  ];
  if (canRecord && open) {
    columns.push({
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        !r.voided && (
          <button className="text-xs text-danger hover:underline" onClick={() => setVoidingId(r.id)}>
            Void…
          </button>
        ),
    });
  }
  const voiding = batch.remittances.find((r) => r.id === voidingId) ?? null;

  return (
    <Section
      title={`Remittances · ${formatPesos(batch.money.remittedCentavos)} counted`}
      action={canRecord && open && !recording && <ActionButton label="Record remittance" onClick={() => setRecording(true)} />}
    >
      {recording && (
        <RemittanceForm
          batch={batch}
          onSaved={(b) => {
            onChanged(b);
            setRecording(false);
          }}
          onCancel={() => setRecording(false)}
          onExpired={onSessionExpired}
        />
      )}
      {voiding && (
        <VoidRemittanceForm
          batch={batch}
          remittance={voiding}
          onSaved={(b) => {
            onChanged(b);
            setVoidingId(null);
          }}
          onCancel={() => setVoidingId(null)}
          onExpired={onSessionExpired}
        />
      )}
      <DataTable
        columns={columns}
        rows={batch.remittances}
        getRowKey={(r) => r.id}
        emptyMessage={open ? "No cash recorded yet. Count what the collector hands over and record it." : "No remittances."}
      />
    </Section>
  );
}

interface RemittanceFormProps {
  batch: BatchDetailDto;
  onSaved: (updated: BatchDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function RemittanceForm({ batch, onSaved, onCancel, onExpired }: RemittanceFormProps) {
  const [amountText, setAmountText] = useState("");
  const [notes, setNotes] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);
  const stillExpected = batch.money.cashCollectedCentavos - batch.money.remittedCentavos;

  function submit() {
    const amountCentavos = tryParsePesos(amountText);
    if (amountCentavos === null) return reject({ amountCentavos: "Enter a valid peso amount, for example 999.00." });
    const parsed = remittanceCreateSchema.safeParse({ amountCentavos, notes: notes.trim() || null });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.batches.recordRemittance(batch.id, parsed.data));
  }

  return (
    <ProfileForm
      title="Record cash handed over"
      submitLabel="Record remittance"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="grid grid-cols-3 gap-3">
        <MoneyField label="Cash counted" value={amountText} onChange={setAmountText} required error={errors.amountCentavos} />
      </div>
      <p className="text-xs text-muted">
        Enter what was actually counted, not what was expected. Cash collections on this batch:{" "}
        <span className="tabular-nums">{formatPesos(batch.money.cashCollectedCentavos)}</span>
        {stillExpected > 0 && (
          <>
            ; not yet handed over: <span className="tabular-nums">{formatPesos(stillExpected)}</span>
          </>
        )}
        . Cheques are not counted as cash.
      </p>
      <TextAreaField label="Notes" value={notes} onChange={setNotes} error={errors.notes} maxLength={500} />
    </ProfileForm>
  );
}

interface VoidRemittanceFormProps {
  batch: BatchDetailDto;
  remittance: BatchRemittanceDto;
  onSaved: (updated: BatchDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function VoidRemittanceForm({ batch, remittance, onSaved, onCancel, onExpired }: VoidRemittanceFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = remittanceVoidSchema.safeParse({ reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.batches.voidRemittance(batch.id, remittance.id, parsed.data.reason));
  }

  return (
    <ProfileForm
      title={`Void the ${formatPesos(remittance.amountCentavos)} remittance`}
      submitLabel="Void remittance"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted">The entry stays listed as voided and no longer counts. Record the right amount again.</p>
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Recorded in the audit log, e.g. typed the wrong amount."
        maxLength={200}
      />
    </ProfileForm>
  );
}

/* ----------------------------- Reconciliation ----------------------------- */

interface ReconcilePanelProps {
  batch: BatchDetailDto;
  onSaved: (updated: BatchDetailDto) => void;
  /** Fetch the batch again, when the server says the figures changed. */
  onReload: () => void;
  onCancel: () => void;
  onExpired: () => void;
}

/**
 * Collector Reconciliation (spec 4.3): expected cash, remitted cash, the difference, non-cash
 * totals. The difference shown here is sent back; the server refuses if it no longer matches.
 * A shortage or overage needs a reason (AT-08), and the button says exactly what is recorded.
 */
export function ReconcilePanel({ batch, onSaved, onReload, onCancel, onExpired }: ReconcilePanelProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);
  const { differenceCentavos, kind } = cashVariance(batch.money.cashCollectedCentavos, batch.money.remittedCentavos);

  function submit() {
    const parsed = batchReconcileSchema.safeParse({ differenceCentavos, varianceReason: reason.trim() || null });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(async () => {
      const r = await window.bcis.batches.reconcile(batch.id, parsed.data);
      if (!r.ok && r.code === "DIFFERENCE_CHANGED") onReload();
      return r;
    });
  }

  return (
    <ProfileForm
      title="Reconcile the collector's cash"
      submitLabel={
        kind === "balanced" ? "Reconcile (balanced)" : `Record ${differenceText(differenceCentavos)} and reconcile`
      }
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <dl className="grid grid-cols-4 gap-4">
        <Figure label="Expected cash (cash collections)" value={formatPesos(batch.money.cashCollectedCentavos)} />
        <Figure label="Remitted cash" value={formatPesos(batch.money.remittedCentavos)} />
        <Figure label="Difference" value={formatPesos(differenceCentavos)}>
          <VarianceBadge kind={kind} />
        </Figure>
        <Figure label="Non-cash (not remitted)" value={formatPesos(batch.money.nonCashCentavos)} />
      </dl>
      <p className="text-xs text-muted">
        {batch.money.collectionCount} collection{batch.money.collectionCount === 1 ? "" : "s"}; cheques{" "}
        {formatPesos(batch.money.chequeCollectedCentavos)}, paid elsewhere {formatPesos(batch.money.paidElsewhereCentavos)},
        uncollected {formatPesos(batch.money.uncollectedCentavos)}. Subscribers keep the credit for what they paid either way.
      </p>
      {kind !== "balanced" && (
        <TextField
          label={`Reason for the ${kind}`}
          value={reason}
          onChange={setReason}
          required
          error={errors.varianceReason}
          hint="Recorded on the batch and in the audit log."
          maxLength={200}
        />
      )}
    </ProfileForm>
  );
}

interface ReconciliationSummaryProps {
  batch: BatchDetailDto;
  canClose: boolean;
  onClosed: (updated: BatchDetailDto) => void;
  onExpired: () => void;
}

/** The frozen figures of a reconciled or closed batch, later exceptions, and closing. */
export function ReconciliationSummary({ batch, canClose, onClosed, onExpired }: ReconciliationSummaryProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = batch.reconciliation;
  if (!rec) return null;
  const kind = rec.varianceKind as VarianceKind;

  async function close() {
    if (!rec) return;
    setBusy(true);
    setError(null);
    const r = await window.bcis.batches.close(batch.id, rec.differenceCentavos);
    setBusy(false);
    if (r.ok) {
      setConfirming(false);
      onClosed(r.data);
    } else if (r.code === "UNAUTHENTICATED") onExpired();
    else setError(r.message);
  }

  return (
    <Section
      title="Reconciliation"
      action={
        canClose &&
        batch.status === "reconciled" &&
        !confirming && <ActionButton label="Close batch…" onClick={() => setConfirming(true)} />
      }
    >
      <dl className="grid grid-cols-4 gap-4">
        <Figure label="Expected cash" value={formatPesos(rec.expectedCashCentavos)} />
        <Figure label="Remitted cash" value={formatPesos(rec.remittedCashCentavos)} />
        <Figure label="Difference" value={formatPesos(rec.differenceCentavos)}>
          <VarianceBadge kind={kind} />
        </Figure>
        <div>
          <dt className="text-xs text-muted">Reconciled</dt>
          <dd className="text-sm text-ink">{batch.reconciled ? `${formatDateTime(batch.reconciled.at)} · ${batch.reconciled.byName}` : "—"}</dd>
        </div>
      </dl>
      {rec.varianceReason && <p className="mt-2 text-sm text-ink">Reason: {rec.varianceReason}</p>}

      {batch.reversedAfterReconciliation.length > 0 && (
        <div role="alert" className="mt-3 rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          <p className="font-medium">Reversed after reconciliation (not in the figures above):</p>
          <ul className="mt-1 list-disc pl-5">
            {batch.reversedAfterReconciliation.map((c) => (
              <li key={c.paymentId}>
                {c.receiptNumber} · {c.accountNumber} {c.fullName} · <span className="tabular-nums">{formatPesos(c.amountCentavos)}</span>{" "}
                · {c.reversalReason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <RowError message={error} />
        </div>
      )}
      {confirming && (
        <div className="mt-3">
          <Confirm
            title={`Close ${batch.batchNumber}?`}
            confirmLabel={kind === "balanced" ? "Close batch" : `Close with ${differenceText(rec.differenceCentavos)}`}
            busy={busy}
            onConfirm={() => void close()}
            onCancel={() => setConfirming(false)}
          >
            {kind === "balanced" ? (
              <>The collector's cash balanced. Closing is final.</>
            ) : (
              <>
                This batch was reconciled with a <strong>{differenceText(rec.differenceCentavos)}</strong>
                {rec.varianceReason ? ` (${rec.varianceReason})` : ""}. Closing records that you accept it as final.
              </>
            )}
          </Confirm>
        </div>
      )}
    </Section>
  );
}

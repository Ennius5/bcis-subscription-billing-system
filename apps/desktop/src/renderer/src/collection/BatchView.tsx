import { useEffect, useState, type ReactNode } from "react";
import { batchCancelSchema, formatPesos, type PermissionCode } from "@bcis/shared";
import type { ApiResult, BatchAccountDto, BatchDetailDto, BatchStepDto, CreateBatchResultDto } from "../../../preload/index";
import { SubscriberPicker } from "../payments/SubscriberPicker";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { ActionButton, formatDateTime, RowError, Section } from "../subscribers/ProfileParts";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { TextField } from "../ui/TextField";
import { addressText, BatchStatusBadge } from "./batchLabels";
import { RouteSheet } from "./RouteSheet";

type Panel = "dispatch" | "submit" | "cancel" | "add" | null;

interface BatchViewProps {
  batchId: string;
  /** From building the batch: owing subscribers left out because they are on another live batch. */
  skipped: CreateBatchResultDto["skipped"];
  permissions: readonly PermissionCode[];
  onBack: () => void;
  onSessionExpired: () => void;
}

function Tile({ label, centavos, note }: { label: string; centavos: number; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-ink">{formatPesos(centavos)}</div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}

function Step({ label, step }: { label: string; step: BatchStepDto | null }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-ink">{step ? `${formatDateTime(step.at)} · ${step.byName}` : "—"}</dd>
    </div>
  );
}

/** One collection batch: route sheet, account list, lifecycle actions. */
export function BatchView({ batchId, skipped, permissions, onBack, onSessionExpired }: BatchViewProps) {
  const canManage = permissions.includes("collection.manage");
  const [batch, setBatch] = useState<BatchDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.batches.get(batchId).then((r) => {
      if (cancelled) return;
      if (r.ok) setBatch(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [batchId, onSessionExpired]);

  /** Runs one action; the server's answer replaces the batch, or its message is shown. */
  async function act(call: () => Promise<ApiResult<BatchDetailDto>>, done: (updated: BatchDetailDto) => string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const r = await call();
    setBusy(false);
    if (r.ok) {
      setBatch(r.data);
      setPanel(null);
      setNotice(done(r.data));
    } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
    else setActionError(r.message);
  }

  function openPanel(next: Panel) {
    setPanel(next);
    setActionError(null);
    setNotice(null);
  }

  if (!batch) {
    return (
      <div>
        <button className="mb-4 text-sm text-accent hover:underline" onClick={onBack}>
          ← Back to collection batches
        </button>
        {loadError ? <RowError message={`Could not load the batch. ${loadError}`} /> : <p className="text-muted">Loading…</p>}
      </div>
    );
  }

  const open = batch.status === "open";
  const inProgress = batch.status === "in_progress";
  const live = open || inProgress;

  const columns: Column<BatchAccountDto>[] = [
    {
      key: "subscriber",
      header: "Subscriber",
      render: (a) => (
        <>
          <span className="font-medium">{a.fullName}</span>{" "}
          {a.addedLate && <Badge tone="warning">Added after dispatch</Badge>}
          <span className="block text-xs text-muted">{a.accountNumber}</span>
        </>
      ),
    },
    {
      key: "address",
      header: "Address",
      render: (a) => (
        <>
          {addressText(a) || <span className="text-muted">No address on file</span>}
          {a.landmark && <span className="block text-xs text-muted">Near {a.landmark}</span>}
        </>
      ),
    },
    { key: "area", header: "Area", render: (a) => a.areaCode ?? "—" },
    { key: "current", header: "Current bill", align: "right", render: (a) => formatPesos(a.currentCentavos) },
    { key: "arrears", header: "Arrears", align: "right", render: (a) => formatPesos(a.arrearsCentavos) },
    {
      key: "due",
      header: "Total due",
      align: "right",
      render: (a) => (
        <>
          <span className="font-medium">{formatPesos(a.totalDueCentavos)}</span>
          {a.creditCentavos > 0 && (
            <span className="block text-xs text-muted">less credit {formatPesos(a.creditCentavos)}</span>
          )}
        </>
      ),
    },
    {
      key: "collected",
      header: "Collected",
      align: "right",
      render: (a) => (
        <>
          {formatPesos(a.collectedCentavos)}
          {a.paidElsewhereCentavos > 0 && (
            <span className="block text-xs text-muted">+ {formatPesos(a.paidElsewhereCentavos)} elsewhere</span>
          )}
        </>
      ),
    },
  ];
  if (canManage && open) {
    columns.push({
      key: "actions",
      header: "",
      align: "right",
      render: (a) => (
        <button
          className="text-xs text-danger hover:underline disabled:opacity-50"
          disabled={busy}
          onClick={() =>
            void act(
              () => window.bcis.batches.removeAccount(batch.id, a.subscriberId),
              () => `${a.accountNumber} was taken off the route sheet.`,
            )
          }
        >
          Remove
        </button>
      ),
    });
  }

  return (
    <div className="space-y-4">
      <button className="text-sm text-accent hover:underline" onClick={onBack}>
        ← Back to collection batches
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-3 text-xl font-semibold text-navy">
            {batch.batchNumber}
            <BatchStatusBadge status={batch.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {batch.collector.code} · {batch.collector.fullName} · {batch.area ? batch.area.name : "All areas"} · Collection
            date {batch.collectionDate}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {live && <ActionButton label="Print route sheet" onClick={() => window.print()} />}
          {canManage && live && panel === null && (
            <>
              <ActionButton label="Add account" onClick={() => openPanel("add")} />
              {open && <ActionButton label="Dispatch…" onClick={() => openPanel("dispatch")} />}
              {inProgress && <ActionButton label="Submit…" onClick={() => openPanel("submit")} />}
              <ActionButton label="Cancel batch…" onClick={() => openPanel("cancel")} />
            </>
          )}
        </div>
      </div>

      {skipped.length > 0 && (
        <div role="alert" className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          Left out because already on another open or in-progress batch:{" "}
          {skipped.map((s) => `${s.accountNumber} ${s.fullName} (${s.batchNumber})`).join(", ")}.
        </div>
      )}
      {notice && (
        <p aria-live="polite" className="rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      )}
      {actionError && panel !== "cancel" && <RowError message={actionError} />}

      {panel === "dispatch" && (
        <Confirm
          title={`Dispatch ${batch.batchNumber}?`}
          busy={busy}
          confirmLabel="Dispatch"
          onConfirm={() =>
            void act(
              () => window.bcis.batches.dispatch(batch.id),
              (b) => `${b.batchNumber} is in progress. Collections can now be recorded.`,
            )
          }
          onCancel={() => setPanel(null)}
        >
          Print the route sheet first and hand it to {batch.collector.fullName}. After dispatch, collections can be
          recorded and accounts can still be added, but none can be removed.
        </Confirm>
      )}
      {panel === "submit" && (
        <Confirm
          title={`Submit ${batch.batchNumber}?`}
          busy={busy}
          confirmLabel="Submit"
          onConfirm={() =>
            void act(
              () => window.bcis.batches.submit(batch.id),
              (b) => `${b.batchNumber} is submitted. Record the cash the collector hands over next.`,
            )
          }
          onCancel={() => setPanel(null)}
        >
          Do this when the collector is back and every collection from the tally is entered. No more collections can be
          recorded on this batch afterwards.
        </Confirm>
      )}
      {panel === "cancel" && (
        <CancelForm
          batch={batch}
          onSaved={(b) => {
            setBatch(b);
            setPanel(null);
            setNotice(`${b.batchNumber} was cancelled. Its subscribers can be put on another batch.`);
          }}
          onCancel={() => setPanel(null)}
          onExpired={onSessionExpired}
        />
      )}
      {panel === "add" && (
        <section className="rounded-lg border border-accent/30 bg-slate-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-navy">Add a subscriber to the route sheet</h3>
          <SubscriberPicker
            onPick={(hit) =>
              void act(
                () => window.bcis.batches.addAccount(batch.id, hit.id),
                () => `${hit.accountNumber} ${hit.fullName} was added to the route sheet.`,
              )
            }
            onSessionExpired={onSessionExpired}
          />
          <button
            className="mt-3 rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-white"
            onClick={() => setPanel(null)}
          >
            Done
          </button>
        </section>
      )}

      {batch.cancelled && (
        <p className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Cancelled {formatDateTime(batch.cancelled.at)} by {batch.cancelled.byName}: {batch.cancelled.reason}
        </p>
      )}

      <div className="grid grid-cols-6 gap-3">
        <Tile label="Total due" centavos={batch.money.expectedTotalDueCentavos} note={`${batch.totals.accountCount} accounts`} />
        <Tile label="Arrears" centavos={batch.totals.arrearsCentavos} />
        <Tile label="Cash collected" centavos={batch.money.cashCollectedCentavos} note={`${batch.money.collectionCount} collections`} />
        <Tile label="Cheques" centavos={batch.money.chequeCollectedCentavos} />
        <Tile label="Paid elsewhere" centavos={batch.money.paidElsewhereCentavos} note="Office, GCash, bank" />
        <Tile label="Uncollected" centavos={batch.money.uncollectedCentavos} />
      </div>

      <Section title="Route sheet">
        <DataTable
          columns={columns}
          rows={batch.accounts}
          getRowKey={(a) => a.subscriberId}
          emptyMessage="No accounts on this batch. Use Add account to put subscribers on the route sheet."
        />
      </Section>

      <Section title="History">
        <dl className="grid grid-cols-3 gap-3">
          <Step label="Built" step={batch.created} />
          <Step label="Dispatched" step={batch.dispatched} />
          <Step label="Submitted" step={batch.submitted} />
          <Step label="Reconciled" step={batch.reconciled} />
          <Step label="Closed" step={batch.closed} />
        </dl>
        {batch.notes && <p className="mt-3 text-sm text-muted">Notes: {batch.notes}</p>}
      </Section>

      {live && <RouteSheet batch={batch} />}
    </div>
  );
}

interface ConfirmProps {
  title: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

function Confirm({ title, confirmLabel, busy, onConfirm, onCancel, children }: ConfirmProps) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
      <h3 className="text-sm font-semibold text-navy">{title}</h3>
      <p className="mt-1 text-sm text-ink">{children}</p>
      <div className="mt-3 flex gap-3">
        <button
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-60"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button
          className="rounded border border-slate-300 px-4 py-2 text-sm text-ink hover:bg-white disabled:opacity-60"
          disabled={busy}
          onClick={onCancel}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

interface CancelFormProps {
  batch: BatchDetailDto;
  onSaved: (updated: BatchDetailDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function CancelForm({ batch, onSaved, onCancel, onExpired }: CancelFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = batchCancelSchema.safeParse({ reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.batches.cancel(batch.id, parsed.data.reason));
  }

  return (
    <ProfileForm
      title={`Cancel ${batch.batchNumber}`}
      submitLabel="Cancel batch"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted">
        Only possible while nothing has been collected. The batch stays on record as cancelled, and its subscribers can
        be put on another batch.
      </p>
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="Recorded in the audit log, e.g. collector sick or bad weather."
        maxLength={200}
      />
    </ProfileForm>
  );
}

import { useEffect, useState } from "react";
import { formatPesos, GCASH_PAGE_SIZE_MAX, ledgerQuerySchema, PAYMENT_PAGE_SIZE_MAX, type PermissionCode } from "@bcis/shared";
import type { GcashSubmissionDto, PaymentListItemDto, SubscriberDto } from "../../../../preload/index";
import { PaymentStatusBadge } from "../../payments/paymentLabels";
import { PaymentView } from "../../payments/PaymentView";
import { DataTable } from "../../ui/DataTable";
import { DateField } from "../../ui/DateField";
import { ExportButtons } from "../../ui/ExportButtons";
import { schemaErrors } from "../ProfileForm";
import { ActionButton, formatDateTime, RowError, Section } from "../ProfileParts";

interface DocumentsTabProps {
  subscriber: SubscriberDto;
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/**
 * The papers of this account (spec 5: documents / receipt records): the Statement of Account,
 * the official receipts to reprint, and the GCash proof images the customer sent.
 */
export function DocumentsTab({ subscriber, permissions, onSessionExpired }: DocumentsTabProps) {
  const [reprintId, setReprintId] = useState<string | null>(null);
  const canBilling = permissions.includes("billing.view");
  const canPayments = permissions.includes("payment.view");

  if (reprintId) {
    return (
      <PaymentView
        key={reprintId}
        paymentId={reprintId}
        canReverse={false}
        onBack={() => setReprintId(null)}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  return (
    <div className="space-y-4">
      {canBilling && <StatementBox subscriber={subscriber} onSessionExpired={onSessionExpired} />}
      {canPayments && <Receipts subscriberId={subscriber.id} onReprint={setReprintId} onSessionExpired={onSessionExpired} />}
      {canPayments && <ProofImages subscriberId={subscriber.id} onSessionExpired={onSessionExpired} />}
    </div>
  );
}

function StatementBox({ subscriber, onSessionExpired }: { subscriber: SubscriberDto; onSessionExpired: () => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const parsed = ledgerQuerySchema.safeParse(range);
  const errors = parsed.success ? {} : schemaErrors(parsed.error);

  return (
    <Section title="Statement of Account">
      <div className="grid grid-cols-4 items-start gap-3">
        <DateField label="From" value={from} onChange={setFrom} error={errors.from} hint="Blank for the beginning." />
        <DateField label="To" value={to} onChange={setTo} error={errors.to} hint="Blank for today." />
        <div className="col-span-2 flex flex-col items-end gap-1">
          <span className="text-xs text-muted">Ledger, unpaid bills and aging for the range, as PDF or Excel</span>
          <ExportButtons
            onExport={(format) => window.bcis.billing.exportStatement(subscriber.id, range, format, subscriber.accountNumber)}
            onExpired={onSessionExpired}
            disabled={!parsed.success}
          />
        </div>
      </div>
    </Section>
  );
}

function Receipts({
  subscriberId,
  onReprint,
  onSessionExpired,
}: {
  subscriberId: string;
  onReprint: (paymentId: string) => void;
  onSessionExpired: () => void;
}) {
  const [rows, setRows] = useState<PaymentListItemDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.payments.list({ subscriberId, page: 1, pageSize: PAYMENT_PAGE_SIZE_MAX }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setRows(r.data.items);
        setTotal(r.data.total);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, onSessionExpired]);

  return (
    <Section title="Official receipts">
      {error && <RowError message={`Could not load receipts. ${error}`} />}
      {rows === null && !error ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <DataTable
          columns={[
            { key: "receipt", header: "Receipt no.", render: (p) => <span className="font-medium">{p.receiptNumber}</span> },
            { key: "date", header: "Paid on", render: (p) => p.paymentDate },
            { key: "status", header: "Status", render: (p) => <PaymentStatusBadge status={p.status} /> },
            { key: "amount", header: "Amount", align: "right", render: (p) => formatPesos(p.amountCentavos) },
            {
              key: "reprint",
              header: "",
              render: (p) => (
                <span className="flex justify-end">
                  <ActionButton label="Open to reprint" onClick={() => onReprint(p.id)} />
                </span>
              ),
            },
          ]}
          rows={rows ?? []}
          getRowKey={(p) => p.id}
          emptyMessage="No receipts issued to this subscriber yet."
        />
      )}
      {total > (rows?.length ?? 0) && (
        <p className="mt-2 text-xs text-muted">
          Showing the newest {rows?.length} of {total} receipts. Older ones are in Payments › Payment History.
        </p>
      )}
    </Section>
  );
}

/** Proof images load only when asked for: each is up to 5 MB. */
function ProofImages({ subscriberId, onSessionExpired }: { subscriberId: string; onSessionExpired: () => void }) {
  const [submissions, setSubmissions] = useState<GcashSubmissionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await window.bcis.gcash.list({ subscriberId, pageSize: GCASH_PAGE_SIZE_MAX });
      if (cancelled) return;
      if (!list.ok) {
        if (list.code === "UNAUTHENTICATED") return onSessionExpired();
        return setError(list.message);
      }
      const withProofs = list.data.items.filter((g) => g.proofCount > 0);
      const details = await Promise.all(withProofs.map((g) => window.bcis.gcash.get(g.id)));
      if (cancelled) return;
      setSubmissions(details.flatMap((d) => (d.ok ? [d.data] : [])));
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriberId, onSessionExpired]);

  async function show(proofId: string) {
    setImageError(null);
    const r = await window.bcis.gcash.proofImage(proofId);
    if (r.ok) setImages((all) => ({ ...all, [proofId]: r.data }));
    else if (r.code === "UNAUTHENTICATED") onSessionExpired();
    else setImageError(r.message);
  }

  return (
    <Section title="GCash proof images">
      {error && <RowError message={`Could not load GCash proofs. ${error}`} />}
      {imageError && <RowError message={`Could not open the image. ${imageError}`} />}
      {submissions === null && !error && <p className="text-sm text-muted">Loading…</p>}
      {submissions?.length === 0 && <p className="text-sm text-muted">No proof images on file for this subscriber.</p>}
      <ul className="space-y-3">
        {submissions?.map((g) =>
          g.proofs.map((proof) => (
            <li key={proof.id} className="rounded border border-slate-200 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-medium">GCash {g.referenceNumber}</span>
                  <span className="text-muted">
                    {" "}
                    · {formatPesos(g.amountCentavos)} · uploaded {formatDateTime(proof.uploadedAt)}
                  </span>
                </span>
                {!images[proof.id] && <ActionButton label="Show image" onClick={() => void show(proof.id)} />}
              </div>
              {images[proof.id] && (
                <img
                  src={images[proof.id]}
                  alt={`GCash proof for reference ${g.referenceNumber}`}
                  className="mt-2 max-h-96 rounded border border-slate-200"
                />
              )}
            </li>
          )),
        )}
      </ul>
    </Section>
  );
}

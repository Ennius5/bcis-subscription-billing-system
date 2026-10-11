import { useEffect, useState } from "react";
import { formatPesos, GCASH_PAGE_SIZE_MAX, type PermissionCode } from "@bcis/shared";
import type { GcashSubmissionListItemDto } from "../../../../preload/index";
import { GcashDetail, GcashStatusBadge } from "../../payments/GcashDetail";
import { PaymentList } from "../../payments/PaymentHistoryScreen";
import { PaymentView } from "../../payments/PaymentView";
import { DataTable } from "../../ui/DataTable";
import { RowError, Section } from "../ProfileParts";

interface PaymentsTabProps {
  subscriberId: string;
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** Posted and reversed payments, then the GCash submissions sent in for this subscriber. */
export function PaymentsTab({ subscriberId, permissions, onSessionExpired }: PaymentsTabProps) {
  const [openPaymentId, setOpenPaymentId] = useState<string | null>(null);
  const [openGcashId, setOpenGcashId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [gcash, setGcash] = useState<GcashSubmissionListItemDto[] | null>(null);
  const [gcashError, setGcashError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.gcash.list({ subscriberId, pageSize: GCASH_PAGE_SIZE_MAX }).then((r) => {
      if (cancelled) return;
      if (r.ok) setGcash(r.data.items);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setGcashError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, reloadKey, onSessionExpired]);

  const back = () => {
    setOpenPaymentId(null);
    setOpenGcashId(null);
    setReloadKey((k) => k + 1);
  };

  if (openPaymentId) {
    return (
      <PaymentView
        key={openPaymentId}
        paymentId={openPaymentId}
        canReverse={permissions.includes("payment.reverse")}
        onBack={back}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  if (openGcashId) {
    return (
      <div>
        <button className="mb-4 text-sm text-accent hover:underline" onClick={back}>
          ← Back to payments
        </button>
        <GcashDetail
          key={openGcashId}
          submissionId={openGcashId}
          canAttach={permissions.includes("payment.create")}
          canVerify={permissions.includes("gcash.verify")}
          onChanged={() => setReloadKey((k) => k + 1)}
          onSessionExpired={onSessionExpired}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PaymentList
        subscriberId={subscriberId}
        reloadKey={reloadKey}
        onOpen={setOpenPaymentId}
        onSessionExpired={onSessionExpired}
      />
      <Section title="GCash submissions">
        {gcashError && <RowError message={`Could not load GCash submissions. ${gcashError}`} />}
        {gcash === null && !gcashError ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <DataTable
            columns={[
              {
                key: "ref",
                header: "GCash reference",
                render: (g) => (
                  <button className="font-medium text-accent hover:underline" onClick={() => setOpenGcashId(g.id)}>
                    {g.referenceNumber}
                  </button>
                ),
              },
              { key: "date", header: "Sent on", render: (g) => g.transactionDate },
              { key: "sender", header: "Sender", render: (g) => g.senderName },
              { key: "proofs", header: "Proof images", align: "right", render: (g) => g.proofCount },
              { key: "status", header: "Status", render: (g) => <GcashStatusBadge status={g.status} /> },
              { key: "amount", header: "Amount", align: "right", render: (g) => formatPesos(g.amountCentavos) },
            ]}
            rows={gcash ?? []}
            getRowKey={(g) => g.id}
            emptyMessage="No GCash payments sent in for this subscriber."
          />
        )}
      </Section>
    </div>
  );
}

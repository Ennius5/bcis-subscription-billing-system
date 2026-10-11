import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { InvoiceList } from "../../billing/InvoiceList";
import { InvoiceView } from "../../billing/InvoiceView";

interface BillingTabProps {
  subscriberId: string;
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

/** Every invoice of this subscriber, all months; an invoice opens in place. */
export function BillingTab({ subscriberId, permissions, onSessionExpired }: BillingTabProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <>
      <div hidden={openId !== null}>
        <InvoiceList
          subscriberId={subscriberId}
          reloadKey={reloadKey}
          emptyMessage="No invoices yet."
          onOpen={setOpenId}
          onSessionExpired={onSessionExpired}
        />
      </div>
      {openId && (
        <InvoiceView
          key={openId}
          invoiceId={openId}
          canVoid={permissions.includes("billing.void")}
          canAdjust={permissions.includes("billing.adjust")}
          backLabel="Back to invoices"
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // an adjustment or void changes the list
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

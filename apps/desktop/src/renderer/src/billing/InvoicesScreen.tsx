import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { InvoiceList } from "./InvoiceList";
import { InvoiceView } from "./InvoiceView";

interface InvoicesScreenProps {
  title: string;
  /** "YYYY-MM" to start on one month (Current Billing), or "" for all months (Invoices). */
  initialPeriod: string;
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

export function InvoicesScreen({ title, initialPeriod, permissions, onSessionExpired }: InvoicesScreenProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <>
      {/* The list stays mounted while an invoice is open, so filters and page survive the round trip. */}
      <div hidden={openId !== null}>
        <h1 className="mb-4 text-xl font-semibold text-navy">{title}</h1>
        <InvoiceList
          initialPeriod={initialPeriod}
          reloadKey={reloadKey}
          onOpen={setOpenId}
          onSessionExpired={onSessionExpired}
        />
      </div>
      {openId && (
        <InvoiceView
          key={openId}
          invoiceId={openId}
          canVoid={permissions.includes("billing.void")}
          backLabel={`Back to ${title.toLowerCase()}`}
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // a void changes what the list shows
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

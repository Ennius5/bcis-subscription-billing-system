import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { ServiceAccountList } from "./ServiceAccountList";
import { ServiceAccountScreen } from "./ServiceAccountScreen";

interface ServiceAccountsScreenProps {
  permissions: readonly PermissionCode[];
  onSessionExpired: () => void;
}

export function ServiceAccountsScreen({ permissions, onSessionExpired }: ServiceAccountsScreenProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <>
      {/* The list stays mounted while an account is open, so filters and page survive the round trip. */}
      <div hidden={openId !== null}>
        <ServiceAccountList reloadKey={reloadKey} onOpen={setOpenId} onSessionExpired={onSessionExpired} />
      </div>
      {openId && (
        <ServiceAccountScreen
          key={openId}
          serviceAccountId={openId}
          canManage={permissions.includes("service.manage")}
          canControl={permissions.includes("suspension.manage")}
          backLabel="Back to service accounts"
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // the account may have changed what the list shows
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

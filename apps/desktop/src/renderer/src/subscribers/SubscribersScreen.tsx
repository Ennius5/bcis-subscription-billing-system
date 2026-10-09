import { useState } from "react";
import type { PermissionCode } from "@bcis/shared";
import { SubscriberList } from "./SubscriberList";
import { SubscriberProfile } from "./SubscriberProfile";

interface SubscribersScreenProps {
  permissions: readonly PermissionCode[];
  /** Opens straight to this profile, e.g. right after New Subscriber. */
  initialOpenId?: string | null;
  onSessionExpired: () => void;
}

export function SubscribersScreen({ permissions, initialOpenId = null, onSessionExpired }: SubscribersScreenProps) {
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <>
      {/* The list stays mounted while a profile is open, so filters and page survive the round trip. */}
      <div hidden={openId !== null}>
        <SubscriberList reloadKey={reloadKey} onOpen={setOpenId} onSessionExpired={onSessionExpired} />
      </div>
      {openId && (
        <SubscriberProfile
          key={openId}
          subscriberId={openId}
          canManage={permissions.includes("subscriber.manage")}
          canViewServices={permissions.includes("service.view")}
          canViewBilling={permissions.includes("billing.view")}
          canManageServices={permissions.includes("service.manage")}
          onBack={() => {
            setOpenId(null);
            setReloadKey((k) => k + 1); // the profile may have changed what the list shows
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}

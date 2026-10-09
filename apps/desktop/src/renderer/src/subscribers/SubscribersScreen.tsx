import { useState } from "react";
import { SubscriberList } from "./SubscriberList";
import { SubscriberProfile } from "./SubscriberProfile";

interface SubscribersScreenProps {
  onSessionExpired: () => void;
}

export function SubscribersScreen({ onSessionExpired }: SubscribersScreenProps) {
  const [openId, setOpenId] = useState<string | null>(null);
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

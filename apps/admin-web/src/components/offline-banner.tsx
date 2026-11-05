"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "./toast";

export const OFFLINE_MESSAGE = "You're offline. We'll retry when you're back.";
export const BACK_ONLINE_MESSAGE = "Back online.";

/** What the browser's online state should do: show the band, and announce a reconnect once. */
export function offlineNotice(
  online: boolean,
  wasOffline: boolean,
): { offline: boolean; announceBackOnline: boolean } {
  return { offline: !online, announceBackOnline: online && wasOffline };
}

/**
 * One slim band for a lost connection (#2689 rule 3), not a toast per failed request. It is a
 * polite live region, hides the moment the browser reconnects, and says "Back online" once.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const { show } = useToast();
  const wasOffline = useRef(false);

  useEffect(() => {
    const update = () => {
      const online = typeof navigator === "undefined" || navigator.onLine !== false;
      const notice = offlineNotice(online, wasOffline.current);
      setOffline(notice.offline);
      if (notice.announceBackOnline) {
        show({ message: BACK_ONLINE_MESSAGE, tone: "info" });
      }
      wasOffline.current = notice.offline;
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [show]);

  if (!offline) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      {OFFLINE_MESSAGE}
    </div>
  );
}

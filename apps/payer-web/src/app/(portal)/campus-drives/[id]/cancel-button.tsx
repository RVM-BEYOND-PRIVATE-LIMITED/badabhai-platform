"use client";

import { useState, useTransition } from "react";
import { Button, Dialog, InlineNotice } from "../../../../components/ds";
import { usePortalNavigation } from "../../../../components/portal-navigation";
import { campusDriveErrorCopy } from "../../../../lib/campus-drive-messages";
import { cancelCampusDriveAction } from "../actions";

/**
 * #2813 — Cancel a campus-drive request while it is `requested` or `scheduled`. It asks first
 * (the drive is a real commitment for the placement team), and only the confirm calls the API.
 * A repeat cancel is a 200 server-side; a final state (declined/completed) is a 409 said plainly.
 */
export function CancelCampusDriveButton({ id }: { id: string }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { navigate } = usePortalNavigation();

  function confirm() {
    setAsking(false);
    setError(null);
    startTransition(async () => {
      const res = await cancelCampusDriveAction(id);
      if (res.ok) {
        navigate(`/campus-drives/${id}`, { pendingLabel: "Campus drive request", refresh: true });
      } else {
        setError(campusDriveErrorCopy({ reason: res.reason }));
      }
    });
  }

  return (
    <>
      <Button variant="danger" loading={pending} onClick={() => setAsking(true)}>
        Cancel request
      </Button>
      {error ? (
        <InlineNotice tone="danger">
          <span>{error}</span>
        </InlineNotice>
      ) : null}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Cancel this campus-drive request?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={confirm}>
              Cancel request
            </Button>
          </>
        }
      >
        The placement team will no longer plan a drive for this request. This cannot be undone.
      </Dialog>
    </>
  );
}

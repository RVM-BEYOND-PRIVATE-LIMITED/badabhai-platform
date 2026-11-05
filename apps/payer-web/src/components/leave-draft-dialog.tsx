"use client";

import { Button, Dialog } from "./ds";
import type { LeavePrompt } from "./use-posting-draft";

/**
 * The in-app "Leave this posting?" confirmation (#2688). A dirty posting form holds an in-app
 * link click behind this DS Dialog (the native beforeunload prompt stays only for closing the
 * tab). The draft itself is already saved on this device, so leaving is recoverable — the tone is
 * neutral, not the danger reserved for irreversible actions.
 */
export function LeaveDraftDialog({ leave }: { leave: LeavePrompt }) {
  return (
    <Dialog
      open={leave.open}
      onClose={leave.cancel}
      title="Leave this posting?"
      footer={
        <>
          <Button variant="ghost" onClick={leave.cancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={leave.confirm}>
            Leave posting
          </Button>
        </>
      }
    >
      Your changes are not saved or published yet. A draft stays on this device.
    </Dialog>
  );
}

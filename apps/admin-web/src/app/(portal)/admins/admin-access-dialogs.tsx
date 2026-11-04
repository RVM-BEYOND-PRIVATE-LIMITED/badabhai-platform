"use client";

import { useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Dialog } from "../../../components/dialog";
import { CREATE_ADMIN_DESCRIPTION, CreateAdminForm } from "./create-admin-form";
import { INVITE_ADMIN_DESCRIPTION, InviteAdminForm } from "./invite-admin-form";

/**
 * The admin directory's two ways to add an admin, each a header button that opens its form in a
 * Dialog (A5, #2575) — they used to be panels at the foot of the page that the header linked down
 * to. The dialog returns focus to its button on close, and closing unmounts the form, so a
 * one-time accept link or temporary password shown in it cannot be shown again.
 */
export function CreateAdminDialog({ mayReadEvents }: { mayReadEvents: boolean }) {
  const dialog = useOneShotDialog();
  return (
    <>
      <button type="button" className="btn btn--primary" onClick={dialog.show}>
        <Icon name="user-plus" />
        <span>Create an admin</span>
      </button>
      <Dialog
        open={dialog.open}
        onClose={dialog.close}
        title="Create an admin"
        description={CREATE_ADMIN_DESCRIPTION}
      >
        <CreateAdminForm mayReadEvents={mayReadEvents} onPendingChange={dialog.onPendingChange} />
      </Dialog>
    </>
  );
}

export function InviteAdminDialog({ mayReadEvents }: { mayReadEvents: boolean }) {
  const dialog = useOneShotDialog();
  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={dialog.show}>
        <Icon name={ACTION_ICON.send} />
        <span>Invite an admin</span>
      </button>
      <Dialog
        open={dialog.open}
        onClose={dialog.close}
        title="Invite an admin"
        description={INVITE_ADMIN_DESCRIPTION}
      >
        <InviteAdminForm mayReadEvents={mayReadEvents} onPendingChange={dialog.onPendingChange} />
      </Dialog>
    </>
  );
}

/**
 * Open state for a dialog whose form returns a one-time secret. `close` — Escape, the scrim and
 * the Close button alike — does nothing while the form's request is in flight: closing then would
 * unmount the form before the secret it is about to show arrives, and it can never be fetched
 * again (the admin is created, but its temporary password is lost).
 */
function useOneShotDialog() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return {
    open,
    show: () => setOpen(true),
    close: () => {
      if (!pending) setOpen(false);
    },
    onPendingChange: setPending,
  };
}

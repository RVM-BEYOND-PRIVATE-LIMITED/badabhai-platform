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
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
        <Icon name="user-plus" />
        <span>Create an admin</span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create an admin"
        description={CREATE_ADMIN_DESCRIPTION}
      >
        <CreateAdminForm mayReadEvents={mayReadEvents} />
      </Dialog>
    </>
  );
}

export function InviteAdminDialog({ mayReadEvents }: { mayReadEvents: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
        <Icon name={ACTION_ICON.send} />
        <span>Invite an admin</span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Invite an admin"
        description={INVITE_ADMIN_DESCRIPTION}
      >
        <InviteAdminForm mayReadEvents={mayReadEvents} />
      </Dialog>
    </>
  );
}

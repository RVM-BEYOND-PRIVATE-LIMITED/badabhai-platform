"use client";

/**
 * Shared CONFIRM-ON-SPEND dialog (DS1.5) — the spend gate for unlocking a routed contact,
 * extracted from the applicant feed so every payer surface uses ONE confirm UX (C11).
 *
 * Client primitive (wraps the DS Dialog). It owns NO state: the caller supplies `open` +
 * `onCancel` + `onConfirm`, so the once-per-row guard stays in the screen, not here. The copy
 * is MOCK-neutral and FACELESS — it names NO candidate detail and carries no amount language
 * beyond "1 credit" (XT5: the unlock action body is ids-only; this dialog sends nothing).
 */
import type { ReactNode } from "react";
import { Button, Dialog } from "../ds";

export interface ConfirmSpendDialogProps {
  /** Controls visibility (e.g. `confirmWorker !== null`). */
  open: boolean;
  /** Cancel / dismiss (Esc, scrim, Cancel button, ✕). */
  onCancel: () => void;
  /** Confirm the spend — the caller runs the (ids-only) unlock exactly once per row. */
  onConfirm: () => void;
  /** Heading. @default 'Unlock routed contact?' */
  title?: ReactNode;
  /** Body copy. Defaults to the neutral MOCK explainer. */
  children?: ReactNode;
}

export function ConfirmSpendDialog({
  open,
  onCancel,
  onConfirm,
  title = "Unlock routed contact?",
  children = "This spends 1 credit and opens an in-app relay — never a phone number. You can reuse the relay until your access window ends.",
}: ConfirmSpendDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="success" onClick={onConfirm}>
            Unlock · 1 credit
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

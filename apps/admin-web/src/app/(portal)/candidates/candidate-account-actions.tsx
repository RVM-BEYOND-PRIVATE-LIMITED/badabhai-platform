"use client";

import { useState } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import type { ConfirmReason } from "../../../lib/confirm-tiers";
import type { WorkerAccountAction } from "../../../lib/candidate-account";
import { requestWorkerAccountAction } from "../../../lib/candidate-account-client";

/**
 * The candidate drawer's Account actions (#2562, A7 #2577): sign out everywhere, reset PIN,
 * suspend and unsuspend.
 *
 * A5's T2 opens for sign-out, PIN reset and unsuspend (a before/after diff and a required
 * reason); suspend is T3, so the operator also types the candidate's name. The API records the
 * reason and the action, and a 503 — the worker's sessions could not be ended — is shown with
 * Retry, never as success. The drawer re-reads the record after a success, so the status pill
 * follows.
 */
export function CandidateAccountActions({
  workerId,
  status,
  targetName,
  onChanged,
}: {
  workerId: string;
  /** The account's current status (`active`, `suspended`, …). */
  status: string;
  /** The name a T3 suspend asks the operator to type (the id when no name is disclosed). */
  targetName: string;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState<WorkerAccountAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const suspended = status === "suspended";

  async function run(reason: ConfirmReason): Promise<AdminActionOutcome> {
    if (asking === null) return { ok: false, error: "Nothing to do." };
    const outcome = await requestWorkerAccountAction(workerId, asking, reason.text);
    if (outcome.ok) setDone(doneMessage(asking));
    return outcome;
  }

  const action = asking;
  const spec = action ? ACTION_SPECS[action] : null;
  const Category = ACTION_REASON_CATEGORY;
  const common = {
    open: action !== null,
    onClose: () => setAsking(null),
    title: spec?.title ?? "Account action",
    description: spec?.description,
    changes: spec?.changes ?? [],
    confirmLabel: spec?.confirmLabel ?? "Continue",
    icon: spec?.icon,
    categories: [Category],
    onConfirm: run,
    onSettled: (outcome: AdminActionOutcome) => {
      if (outcome.ok) onChanged();
    },
  };

  return (
    <div className="cdrawer__account-actions">
      <div className="cdrawer__account-buttons">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setAsking("sign-out-all")}
        >
          <Icon name="sign-out" />
          Sign out everywhere
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setAsking("pin-reset")}
        >
          <Icon name="key" />
          Reset PIN
        </button>
        {suspended ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setAsking("unsuspend")}
          >
            <Icon name="lock-key-open" />
            Unsuspend
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => setAsking("suspend")}
          >
            <Icon name={ACTION_ICON.suspend} />
            Suspend
          </button>
        )}
      </div>
      <p className="field__help">
        Every action is recorded with your reason. A suspended worker is hidden from company
        applicant lists and cannot be unlocked.
      </p>
      {done ? (
        <p className="cfield__note" role="status">
          {done}
        </p>
      ) : null}

      {action === "suspend" ? (
        <ConfirmDialog {...common} tier="destructive" targetName={targetName} />
      ) : (
        <ConfirmDialog {...common} tier="consequential" />
      )}
    </div>
  );
}

const ACTION_REASON_CATEGORY = {
  value: "operator_reason",
  label: "Operator's reason",
} as const;

const ACTION_SPECS: Record<
  WorkerAccountAction,
  {
    title: string;
    description: string;
    confirmLabel: string;
    icon: IconName;
    changes: Array<{ label: string; before: string; after: string }>;
  }
> = {
  "sign-out-all": {
    title: "Sign this worker out everywhere",
    description:
      "Every session on every device ends; the worker signs in again with phone and PIN.",
    confirmLabel: "Sign out everywhere",
    icon: "sign-out",
    changes: [{ label: "Signed-in sessions", before: "Open", after: "All ended" }],
  },
  "pin-reset": {
    title: "Reset this worker's PIN",
    description: "The worker re-verifies by phone code before choosing a new PIN.",
    confirmLabel: "Reset PIN",
    icon: "key",
    changes: [
      { label: "PIN", before: "The worker's current PIN", after: "Reset; re-verify by phone" },
    ],
  },
  suspend: {
    title: "Suspend this worker",
    description: "The worker cannot use the app and is removed from company applicant lists.",
    confirmLabel: "Suspend worker",
    icon: ACTION_ICON.suspend,
    changes: [{ label: "Account status", before: "Active", after: "Suspended" }],
  },
  unsuspend: {
    title: "Unsuspend this worker",
    description: "The worker is restored to active and can use the app again.",
    confirmLabel: "Unsuspend worker",
    icon: ACTION_ICON.unlock,
    changes: [{ label: "Account status", before: "Suspended", after: "Active" }],
  },
};

function doneMessage(action: WorkerAccountAction): string {
  switch (action) {
    case "sign-out-all":
      return "Signed out everywhere.";
    case "pin-reset":
      return "PIN reset. The worker re-verifies by phone before choosing a new one.";
    case "suspend":
      return "Worker suspended.";
    case "unsuspend":
      return "Worker restored to active.";
  }
}

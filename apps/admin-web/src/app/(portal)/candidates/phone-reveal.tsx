"use client";

import { useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { CopyId } from "../../../components/copy-id";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import type { ConfirmReason } from "../../../lib/confirm-tiers";
import {
  PII_REVEAL_REASON_CODES,
  PII_REVEAL_REASON_LABELS,
} from "../../../lib/admin-action-vocabulary";
import { revealCandidatePhoneAction } from "./actions";
import { LOCK_REASONS, LockedTag } from "./locked-tag";

/** The reveal's reason choices — the API's closed codes, in words. */
export const REVEAL_REASON_CATEGORIES = PII_REVEAL_REASON_CODES.map((value) => ({
  value,
  label: PII_REVEAL_REASON_LABELS[value],
}));

/**
 * The phone row of the drawer's Locked group (A7, #2577): always locked — an admin never edits a
 * phone — and hidden, because the #2560 record never carries it. A session holding `reveal_pii`
 * may reveal it through the EXISTING reason-gated `POST /admin/workers/:id/reveal-contact`, behind
 * A5's T2 confirm: what changes (the phone becomes visible to you), a reason from the API's
 * closed list, and an explanation. The API records the reason with the reveal before it decrypts
 * anything, and checks the explanation without storing it — the dialog says so.
 *
 * The revealed phone lives in this component's state only: it is gone when the drawer moves to
 * another candidate or closes (the panel is keyed by worker), and nothing persists, logs or
 * caches it. `canReveal` hides the control for a role without the capability — an affordance;
 * the API refuses the reveal for every other role regardless.
 */
export function PhoneField({ workerId, canReveal }: { workerId: string; canReveal: boolean }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function reveal(reason: ConfirmReason): Promise<AdminActionOutcome> {
    const outcome = await revealCandidatePhoneAction(workerId, reason.category, reason.text);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    setPhone(outcome.phone);
    return { ok: true, changed: true, message: "Phone revealed." };
  }

  if (phone !== null) {
    return (
      <span className="cfield">
        <span className="cfield__value">
          <span className="mono">{phone}</span>
          <CopyId id={phone} label="phone" />
        </span>
        <LockedTag why={LOCK_REASONS.phone} />
        <span className="cfield__note" role="status">
          Revealed to you. The reveal is recorded with your reason.
        </span>
      </span>
    );
  }

  return (
    <span className="cfield">
      <span className="cfield__value">
        <span className="table__meta">Hidden</span>
      </span>
      <LockedTag why={LOCK_REASONS.phone} />
      {canReveal ? (
        <>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsking(true)}>
            <Icon name={ACTION_ICON.unlock} />
            Reveal phone
          </button>
          <ConfirmDialog
            open={asking}
            onClose={() => setAsking(false)}
            tier="consequential"
            title="Reveal this worker's phone"
            description="The phone is decrypted for you alone. The reason you choose is recorded with the reveal; your explanation is checked for contact details and not stored."
            changes={[{ label: "Phone", before: "Hidden", after: "Shown to you" }]}
            confirmLabel="Reveal phone"
            icon={ACTION_ICON.unlock}
            categories={REVEAL_REASON_CATEGORIES}
            onConfirm={reveal}
          />
        </>
      ) : (
        <span className="cfield__note">Your role cannot reveal contact details.</span>
      )}
    </span>
  );
}

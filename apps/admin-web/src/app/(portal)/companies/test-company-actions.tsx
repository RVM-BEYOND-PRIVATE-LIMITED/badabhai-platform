"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Dialog } from "../../../components/dialog";
import { AdminActionButton } from "../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import {
  TEST_COMPANY_REASONS,
  TEST_COMPANY_REASON_LABELS,
  type TestCompanyReason,
} from "../../../lib/numbers-vocabulary";
import { markTestCompanyAction, unmarkTestCompanyAction } from "../numbers/actions";

/**
 * "Mark as test company" / "Unmark" on the Companies page (#2884).
 *
 * A test company is left out of every company figure. The mark carries one of four closed reasons
 * and an Idempotency-Key; the unmark carries none (the route takes no body). Both are governed
 * writes and refresh the row after they settle.
 */
export function TestCompanyActions({
  companyId,
  subject,
}: {
  companyId: string;
  subject: string;
}) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<TestCompanyReason>("pilot_test");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    if (pending) return;
    setOpen(false);
    setOutcome(null);
    setKey(crypto.randomUUID());
  }

  function mark() {
    if (pending) return;
    startTransition(async () => {
      const result = await markTestCompanyAction(companyId, reason, key);
      setOutcome(result);
      if (result.ok) {
        setOpen(false);
        setKey(crypto.randomUUID());
        router.refresh();
      }
    });
  }

  return (
    <div className="row-actions">
      <button className="btn btn--ghost btn--sm" type="button" onClick={() => setOpen(true)}>
        <Icon name="flag" />
        <span>Mark as test</span>
      </button>

      <AdminActionButton
        label="Unmark"
        confirmLabel="Confirm unmark?"
        icon={ACTION_ICON.reinstate}
        subject={subject}
        action={async () => {
          const result = await unmarkTestCompanyAction(companyId);
          if (result.ok) router.refresh();
          return result;
        }}
        onSettled={setOutcome}
      />

      {outcome && !outcome.ok ? (
        <AdminActionResultBanner outcome={outcome} eventsLink={null} />
      ) : null}

      <Dialog
        open={open}
        onClose={close}
        title={`Mark ${subject} as a test company?`}
        description="A test company is left out of every company figure. Choose why it is one."
        footer={
          <>
            <button className="btn btn--ghost" type="button" onClick={close} disabled={pending}>
              Cancel
            </button>
            <button className="btn btn--primary" type="button" onClick={mark} disabled={pending}>
              <Icon name={ACTION_ICON.approve} />
              {pending ? "Marking…" : "Mark as test company"}
            </button>
          </>
        }
      >
        <label className="field" htmlFor={`${ids}-reason`}>
          <span className="field__label">Why is this a test company?</span>
          <select
            id={`${ids}-reason`}
            className="field__input"
            value={reason}
            onChange={(e) => setReason(e.target.value as TestCompanyReason)}
          >
            {TEST_COMPANY_REASONS.map((value) => (
              <option key={value} value={value}>
                {TEST_COMPANY_REASON_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={null} /> : null}
      </Dialog>
    </div>
  );
}

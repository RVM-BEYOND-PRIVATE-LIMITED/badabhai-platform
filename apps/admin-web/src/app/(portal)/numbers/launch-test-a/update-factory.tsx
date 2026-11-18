"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Dialog } from "../../../../components/dialog";
import { AdminActionResultBanner } from "../../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";
import {
  LAUNCH_TEST_RESULTS,
  LAUNCH_TEST_RESULT_LABELS,
  type LaunchTestResult,
} from "../../../../lib/numbers-vocabulary";
import type { LaunchFactory } from "../../../../lib/numbers";
import { updateLaunchFactoryAction, type UpdateLaunchFactoryInput } from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINK_REF = /^[!-~]{1,300}$/;

interface Draft {
  paymentLinkRef: string;
  linkCreatedAt: string;
  result: "" | LaunchTestResult;
  paidAt: string;
  payerId: string;
  paymentOrderId: string;
}

const EMPTY: Draft = {
  paymentLinkRef: "",
  linkCreatedAt: "",
  result: "",
  paidAt: "",
  payerId: "",
  paymentOrderId: "",
};

/**
 * The "Update" action for one launch-test factory (#2884).
 *
 * The idempotency key is minted when the dialog opens and kept across a failed submit, so the
 * retry of this edit reaches the API as the same request.
 */
export function UpdateFactory({ factory }: { factory: LaunchFactory }) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  function close() {
    if (pending) return;
    setOpen(false);
    setDraft(EMPTY);
    setOutcome(null);
    setKey(crypto.randomUUID());
  }

  function submit() {
    if (pending) return;
    const changes: UpdateLaunchFactoryInput = {};
    if (draft.paymentLinkRef.trim()) {
      if (!LINK_REF.test(draft.paymentLinkRef.trim())) {
        setOutcome({ ok: false, error: "A payment link is printable ASCII with no spaces." });
        return;
      }
      changes.paymentLinkRef = draft.paymentLinkRef.trim();
    }
    if (draft.linkCreatedAt) changes.linkCreatedAt = new Date(draft.linkCreatedAt).toISOString();
    if (draft.result) changes.result = draft.result;
    if (draft.paidAt) changes.paidAt = new Date(draft.paidAt).toISOString();
    if (draft.payerId.trim()) {
      if (!UUID.test(draft.payerId.trim())) {
        setOutcome({ ok: false, error: "That company account id is not valid." });
        return;
      }
      changes.payerId = draft.payerId.trim();
    }
    if (draft.paymentOrderId.trim()) {
      if (!UUID.test(draft.paymentOrderId.trim())) {
        setOutcome({ ok: false, error: "That payment order id is not valid." });
        return;
      }
      changes.paymentOrderId = draft.paymentOrderId.trim();
    }
    if (Object.keys(changes).length === 0) {
      setOutcome({ ok: false, error: "Choose at least one field to update." });
      return;
    }

    startTransition(async () => {
      const result = await updateLaunchFactoryAction(factory.id, changes, key);
      setOutcome(result);
      if (result.ok) {
        setOpen(false);
        setDraft(EMPTY);
        setKey(crypto.randomUUID());
        router.refresh();
      }
    });
  }

  return (
    <>
      <button className="btn btn--ghost btn--sm" type="button" onClick={() => setOpen(true)}>
        <Icon name={ACTION_ICON.edit} />
        <span>Update</span>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title="Update factory"
        description="Record what the desk did by hand: the link, the result, the account and the paid order. Blank fields are left as they are."
        footer={
          <>
            <button className="btn btn--ghost" type="button" onClick={close} disabled={pending}>
              Cancel
            </button>
            <button className="btn btn--primary" type="button" onClick={submit} disabled={pending}>
              <Icon name={ACTION_ICON.approve} />
              {pending ? "Saving…" : "Save update"}
            </button>
          </>
        }
      >
        <div className="form">
          <p className="field__help">
            Current result: <strong>{LAUNCH_TEST_RESULT_LABELS[factory.result]}</strong>
            {factory.payer_id ? ` · Account ${factory.payer_id}` : " · No account linked"}
          </p>

          <label className="field" htmlFor={`${ids}-link`}>
            <span className="field__label">Payment link reference</span>
            <input
              id={`${ids}-link`}
              className="field__input mono"
              type="text"
              spellCheck={false}
              value={draft.paymentLinkRef}
              onChange={(e) => set({ paymentLinkRef: e.target.value })}
            />
          </label>

          <label className="field" htmlFor={`${ids}-linkAt`}>
            <span className="field__label">Link created at</span>
            <input
              id={`${ids}-linkAt`}
              className="field__input"
              type="datetime-local"
              value={draft.linkCreatedAt}
              onChange={(e) => set({ linkCreatedAt: e.target.value })}
            />
          </label>

          <label className="field" htmlFor={`${ids}-result`}>
            <span className="field__label">Result</span>
            <select
              id={`${ids}-result`}
              className="field__input"
              value={draft.result}
              onChange={(e) => set({ result: e.target.value as Draft["result"] })}
            >
              <option value="">Leave unchanged</option>
              {LAUNCH_TEST_RESULTS.map((result) => (
                <option key={result} value={result}>
                  {LAUNCH_TEST_RESULT_LABELS[result]}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor={`${ids}-paidAt`}>
            <span className="field__label">Paid at</span>
            <input
              id={`${ids}-paidAt`}
              className="field__input"
              type="datetime-local"
              value={draft.paidAt}
              onChange={(e) => set({ paidAt: e.target.value })}
            />
            <span className="field__help">Set exactly when the result is paid.</span>
          </label>

          <label className="field" htmlFor={`${ids}-payer`}>
            <span className="field__label">Company account id</span>
            <input
              id={`${ids}-payer`}
              className="field__input mono"
              type="text"
              spellCheck={false}
              value={draft.payerId}
              onChange={(e) => set({ payerId: e.target.value })}
            />
          </label>

          <label className="field" htmlFor={`${ids}-order`}>
            <span className="field__label">Paid order id</span>
            <input
              id={`${ids}-order`}
              className="field__input mono"
              type="text"
              spellCheck={false}
              value={draft.paymentOrderId}
              onChange={(e) => set({ paymentOrderId: e.target.value })}
            />
          </label>

          {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={null} /> : null}
        </div>
      </Dialog>
    </>
  );
}

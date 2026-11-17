"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setWaiverAction } from "./actions";
import { Dialog } from "../../../components/dialog";

/**
 * #2750 part C — the company/job "RVM applicants free" switch. Every change asks for a
 * written reason (15–500 characters); clearing asks again. The API stores the staff name
 * and the audit row; this control only sends the state and the reason.
 */
export function WaiverSwitch({
  scope,
  companyId,
  postingId,
  active,
  setBy,
}: {
  scope: "company" | "job";
  companyId: string;
  postingId?: string;
  active: boolean;
  setBy?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(next: boolean) {
    setBusy(true);
    setMessage(null);
    const result = await setWaiverAction({
      scope,
      companyId,
      ...(postingId ? { postingId } : {}),
      active: next,
      reasonText: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    setOpen(false);
    setReason("");
    setMessage(result.message);
    router.refresh();
  }

  const label = scope === "company" ? "RVM applicants free for this company" : "RVM applicants free for this job";

  return (
    <section className="panel" aria-labelledby={`waiver-${scope}-${postingId ?? companyId}`}>
      <div className="panel__head">
        <div className="panel__text">
          <h2 className="panel__title" id={`waiver-${scope}-${postingId ?? companyId}`}>
            {label}
          </h2>
          <p className="panel__sub">
            A placement-team waiver makes an RVM student who applied cost 0 credits to open.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <p className="kv__v">
          <strong>{active ? "On" : "Off"}</strong>
          {active && setBy ? <> · set by {setBy}</> : null}
        </p>
        <div className="state__actions">
          <button type="button" className="btn btn--ghost" onClick={() => { setOpen(true); setMessage(null); }}>
            {active ? "Clear the waiver" : "Set a waiver"}
          </button>
        </div>
        {message ? <p className="field__help" role="status">{message}</p> : null}
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={active ? "Clear this waiver" : "Set this waiver"}
        description="The reason is stored with your name in the audit trail."
        footer={
          <>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || reason.trim().length < 15}
              onClick={() => void submit(!active)}
            >
              {busy ? "Saving…" : active ? "Clear waiver" : "Set waiver"}
            </button>
          </>
        }
      >
        <label className="field" htmlFor="waiver-reason">
          <span className="field__label">Reason (15–500 characters)</span>
          <textarea
            id="waiver-reason"
            className="input"
            rows={4}
            minLength={15}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </Dialog>
    </section>
  );
}

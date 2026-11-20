"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { Dialog } from "../../../components/dialog";
import {
  AdminActionResultBanner,
  successToast,
} from "../../../components/admin-action-result-banner";
import { InlineNotice } from "../../../components/inline-notice";
import { useToast } from "../../../components/toast";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import {
  createPayOnJoiningHireAction,
  updatePayOnJoiningHireAction,
  type PayOnJoiningHireInput,
} from "./actions";
import {
  PAY_ON_JOINING_NOTE_MAX,
  paiseToRupeesInput,
  rupeesToPaise,
  type PayOnJoiningHireRow,
} from "../../../lib/pay-on-joining-vocabulary";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Day = "" | "true" | "false";

interface FormValues {
  factoryPayerId: string;
  workerId: string;
  jobPostingId: string;
  partnerPayerId: string;
  joinedOn: string;
  stayCheckedOn: string;
  stayed30Days: Day;
  feeRupees: string;
  invoicedOn: string;
  factoryPaidOn: string;
  partnerPaidOn: string;
  note: string;
}

const EMPTY: FormValues = {
  factoryPayerId: "",
  workerId: "",
  jobPostingId: "",
  partnerPayerId: "",
  joinedOn: "",
  stayCheckedOn: "",
  stayed30Days: "",
  feeRupees: "",
  invoicedOn: "",
  factoryPaidOn: "",
  partnerPaidOn: "",
  note: "",
};

function fromRow(row: PayOnJoiningHireRow): FormValues {
  return {
    factoryPayerId: row.factory_payer_id,
    workerId: row.worker_id,
    jobPostingId: row.job_posting_id ?? "",
    partnerPayerId: row.partner_payer_id ?? "",
    joinedOn: row.joined_on,
    stayCheckedOn: row.stay_checked_on ?? "",
    stayed30Days:
      row.stayed_30_days === null ? "" : row.stayed_30_days ? "true" : "false",
    feeRupees: paiseToRupeesInput(row.fee_paise),
    invoicedOn: row.invoiced_on ?? "",
    factoryPaidOn: row.factory_paid_on ?? "",
    partnerPaidOn: row.partner_paid_on ?? "",
    note: row.note ?? "",
  };
}

function toInput(values: FormValues): PayOnJoiningHireInput {
  return {
    factoryPayerId: values.factoryPayerId,
    workerId: values.workerId,
    jobPostingId: values.jobPostingId,
    partnerPayerId: values.partnerPayerId,
    joinedOn: values.joinedOn,
    stayCheckedOn: values.stayCheckedOn,
    stayed30Days:
      values.stayed30Days === "" ? null : values.stayed30Days === "true",
    feeRupees: values.feeRupees,
    invoicedOn: values.invoicedOn,
    factoryPaidOn: values.factoryPaidOn,
    partnerPaidOn: values.partnerPaidOn,
    note: values.note,
  };
}

function check(values: FormValues): string | null {
  if (!UUID.test(values.factoryPayerId.trim())) return "Enter a valid factory id.";
  if (!UUID.test(values.workerId.trim())) return "Enter a valid worker id.";
  if (values.jobPostingId.trim() && !UUID.test(values.jobPostingId.trim()))
    return "Enter a valid posting id, or leave it empty.";
  if (values.partnerPayerId.trim() && !UUID.test(values.partnerPayerId.trim()))
    return "Enter a valid partner id, or leave it empty.";
  if (!DAY.test(values.joinedOn)) return "Enter the joining date.";
  if (rupeesToPaise(values.feeRupees) === null)
    return "Enter the fee in rupees, with at most two decimal places.";
  const stayChecked = values.stayCheckedOn !== "";
  const hasOutcome = values.stayed30Days !== "";
  if (stayChecked !== hasOutcome)
    return "Enter both the 30-day check date and its outcome, or neither.";
  if (values.partnerPaidOn && !values.partnerPayerId.trim())
    return "Add the partner before recording when the partner was paid.";
  if (
    values.partnerPayerId.trim() &&
    values.partnerPayerId.trim() === values.factoryPayerId.trim()
  )
    return "The partner must be a different company from the factory.";
  if (values.note.length > PAY_ON_JOINING_NOTE_MAX)
    return `The note must be at most ${PAY_ON_JOINING_NOTE_MAX} characters.`;
  return null;
}

/**
 * The add/edit dialog for one pay-on-joining hire.
 *
 * EDIT IS SEEDED FROM THE LIST ROW. There is no `GET :id` route: the list already carries every
 * field the form needs, so opening the dialog costs no extra read and cannot show a record the
 * operator did not just see.
 *
 * The form sends only the fields the API accepts. The partner's share, its percent, the derived
 * payment state and the admin ids are server-owned and never appear in the body.
 */
export function PayOnJoiningHireDialog({
  mode,
  initial,
}: {
  mode: "create" | "edit";
  initial?: PayOnJoiningHireRow;
}) {
  const router = useRouter();
  const { show } = useToast();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FormValues>(() =>
    initial ? fromRow(initial) : EMPTY,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const title = mode === "create" ? "Record a hire" : "Edit hire record";

  function openDialog() {
    setValues(initial ? fromRow(initial) : EMPTY);
    setFormError(null);
    setOutcome(null);
    setOpen(true);
  }

  function close() {
    if (pending) return;
    setOpen(false);
  }

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFormError(null);
    setOutcome(null);
  }

  function submit() {
    if (pending) return;
    const problem = check(values);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    startTransition(async () => {
      const input = toInput(values);
      const result =
        mode === "create"
          ? await createPayOnJoiningHireAction(input)
          : await updatePayOnJoiningHireAction(initial!.id, input);
      setOutcome(result);
      if (result.ok) {
        show(successToast(result, null));
        router.refresh();
        setOpen(false);
        setValues(initial ? fromRow(initial) : EMPTY);
      }
    });
  }

  return (
    <>
      <button
        className={mode === "create" ? "btn btn--primary" : "btn btn--ghost btn--sm"}
        type="button"
        onClick={openDialog}
      >
        <Icon name={mode === "create" ? "plus" : "pencil-simple"} />
        <span>{mode === "create" ? "Record a hire" : "Edit"}</span>
        {mode === "edit" ? <span className="sr-only"> hire record</span> : null}
      </button>

      <Dialog
        open={open}
        onClose={close}
        title={title}
        description="The record only — nothing here raises an invoice or pays anyone."
        footer={
          <>
            <button className="btn btn--ghost" type="button" onClick={close} disabled={pending}>
              Cancel
            </button>
            <button className="btn btn--primary" type="button" onClick={submit} disabled={pending}>
              <span>{pending ? "Saving…" : mode === "create" ? "Record hire" : "Save changes"}</span>
            </button>
          </>
        }
      >
        {formError ? (
          <InlineNotice tone="warning" title="Check the form">
            {formError}
          </InlineNotice>
        ) : null}
        {outcome && !outcome.ok ? (
          <AdminActionResultBanner outcome={outcome} eventsLink={null} onRetry={submit} />
        ) : null}

        <form className="form" onSubmit={(e) => e.preventDefault()} noValidate>
          <div className="form-grid">
            <label className="field" htmlFor={`${ids}-factory`}>
              <span className="field__label">
                Factory id<span className="req">*</span>
              </span>
              <input
                id={`${ids}-factory`}
                className="field__input mono"
                value={values.factoryPayerId}
                onChange={(e) => set("factoryPayerId", e.target.value)}
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-worker`}>
              <span className="field__label">
                Worker id<span className="req">*</span>
              </span>
              <input
                id={`${ids}-worker`}
                className="field__input mono"
                value={values.workerId}
                onChange={(e) => set("workerId", e.target.value)}
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-job`}>
              <span className="field__label">Posting id</span>
              <input
                id={`${ids}-job`}
                className="field__input mono"
                value={values.jobPostingId}
                onChange={(e) => set("jobPostingId", e.target.value)}
                placeholder="e.g. 0b7c5d2e-1f3a-4c8e-9d61-2a4f6b8c0e13"
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-partner`}>
              <span className="field__label">Partner id</span>
              <input
                id={`${ids}-partner`}
                className="field__input mono"
                value={values.partnerPayerId}
                onChange={(e) => set("partnerPayerId", e.target.value)}
                placeholder="e.g. 0b7c5d2e-1f3a-4c8e-9d61-2a4f6b8c0e13"
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-joined`}>
              <span className="field__label">
                Joined on<span className="req">*</span>
              </span>
              <input
                id={`${ids}-joined`}
                className="field__input"
                type="date"
                value={values.joinedOn}
                onChange={(e) => set("joinedOn", e.target.value)}
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-fee`}>
              <span className="field__label">
                Fee (₹)<span className="req">*</span>
              </span>
              <input
                id={`${ids}-fee`}
                className="field__input"
                inputMode="decimal"
                value={values.feeRupees}
                onChange={(e) => set("feeRupees", e.target.value)}
                placeholder="e.g. 5000"
                autoComplete="off"
                disabled={pending}
              />
              <span className="field__help">Entered in rupees; sent to the server as paise.</span>
            </label>

            <label className="field" htmlFor={`${ids}-stay-date`}>
              <span className="field__label">30-day check on</span>
              <input
                id={`${ids}-stay-date`}
                className="field__input"
                type="date"
                value={values.stayCheckedOn}
                onChange={(e) => set("stayCheckedOn", e.target.value)}
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-stay-outcome`}>
              <span className="field__label">Stayed 30 days</span>
              <select
                id={`${ids}-stay-outcome`}
                className="field__input"
                value={values.stayed30Days}
                onChange={(e) => set("stayed30Days", e.target.value as Day)}
                disabled={pending}
              >
                <option value="">Not checked</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
              <span className="field__help">The date and the outcome go together, or neither.</span>
            </label>

            <label className="field" htmlFor={`${ids}-invoiced`}>
              <span className="field__label">Invoiced on</span>
              <input
                id={`${ids}-invoiced`}
                className="field__input"
                type="date"
                value={values.invoicedOn}
                onChange={(e) => set("invoicedOn", e.target.value)}
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-factory-paid`}>
              <span className="field__label">Factory paid on</span>
              <input
                id={`${ids}-factory-paid`}
                className="field__input"
                type="date"
                value={values.factoryPaidOn}
                onChange={(e) => set("factoryPaidOn", e.target.value)}
                disabled={pending}
              />
            </label>

            <label className="field" htmlFor={`${ids}-partner-paid`}>
              <span className="field__label">Partner paid on</span>
              <input
                id={`${ids}-partner-paid`}
                className="field__input"
                type="date"
                value={values.partnerPaidOn}
                onChange={(e) => set("partnerPaidOn", e.target.value)}
                disabled={pending}
              />
              <span className="field__help">Needs a partner id.</span>
            </label>
          </div>

          <label className="field" htmlFor={`${ids}-note`}>
            <span className="field__label">Note</span>
            <textarea
              id={`${ids}-note`}
              className="field__input"
              rows={3}
              maxLength={PAY_ON_JOINING_NOTE_MAX}
              value={values.note}
              onChange={(e) => set("note", e.target.value)}
              disabled={pending}
            />
            <span className="field__help">
              Up to {PAY_ON_JOINING_NOTE_MAX} characters. No phone number, email or other id.
            </span>
          </label>
        </form>
      </Dialog>
    </>
  );
}

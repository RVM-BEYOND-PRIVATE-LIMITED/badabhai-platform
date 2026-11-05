"use client";

import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Icon, type IconName } from "@badabhai/icons";
import { Dialog } from "./dialog";
import { AdminActionResultBanner } from "./admin-action-result-banner";
import { FieldError, FormSummary, useFormValidation } from "./form-feedback";
import {
  REASON_CATEGORIES,
  REASON_MIN_CHARS,
  confirmBlockers,
  reasonLongEnough,
  toConfirmReason,
  typedNameMatches,
  type ConfirmDraft,
  type ConfirmReason,
  type ReasonCategory,
} from "../lib/confirm-tiers";
import type { AdminActionOutcome } from "../lib/admin-action-result";

/** One row of the before/after diff a T2/T3 dialog shows. */
export interface ConfirmChange {
  label: string;
  before: ReactNode;
  after: ReactNode;
}

interface ConfirmDialogBase {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** What the action changes, field by field. */
  changes: readonly ConfirmChange[];
  /** The confirm button's copy ("Suspend payer"). */
  confirmLabel: string;
  icon?: IconName;
  categories?: readonly ReasonCategory[];
  /** Runs the action with the operator's reason; called only once every gate is met. */
  onConfirm: (reason: ConfirmReason) => Promise<AdminActionOutcome>;
  /** Every outcome, success or failure. A success also closes the dialog. */
  onSettled?: (outcome: AdminActionOutcome) => void;
  /**
   * Where focus goes when it closes, for a success that REPLACES the control that opened it (the
   * revealed phone, in place of Reveal phone): asked as it closes; the trigger otherwise.
   */
  returnFocus?: () => HTMLElement | null;
}

export type ConfirmDialogProps =
  | (ConfirmDialogBase & { tier: "consequential"; targetName?: undefined })
  | (ConfirmDialogBase & {
      tier: "destructive";
      /** The name the operator must type to confirm (the company's, the admin's). */
      targetName: string;
    });

const EMPTY: ConfirmDraft = { category: "", reason: "", typedName: "" };

/**
 * The T2 / T3 confirmation (A5, #2575; rules in lib/confirm-tiers.ts).
 *
 * T2 `consequential`: the diff of what changes, and a required reason — a category plus at least
 * REASON_MIN_CHARS characters. T3 `destructive`: all of that, plus typing the target's name, and
 * focus STARTS ON CANCEL so a reflexive Enter never fires it. The confirm button stays disabled
 * until every gate is met, and the first unmet one is named under it.
 *
 * A failure stays in the dialog with the server's own text, so the operator can retry without
 * re-entering the reason; a success closes it. Closing at any point clears what was entered.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    onClose,
    title,
    description,
    changes,
    confirmLabel,
    icon,
    categories = REASON_CATEGORIES,
    onConfirm,
    onSettled,
    returnFocus,
    tier,
    targetName,
  } = props;
  const [draft, setDraft] = useState<ConfirmDraft>(EMPTY);
  const [failure, setFailure] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const blockers = confirmBlockers(tier, draft, categories, targetName);
  const reasonLength = draft.reason.trim().length;
  const destructive = tier === "destructive";
  const validation = useFormValidation({
    order: destructive
      ? (["category", "reason", "typedName"] as const)
      : (["category", "reason"] as const),
    focus: (field) => {
      if (field === "category") categoryRef.current?.focus();
      else if (field === "reason") reasonRef.current?.focus();
      else nameRef.current?.focus();
    },
    fieldId: (field) =>
      field === "typedName" ? `${id}-name` : field === "reason" ? `${id}-reason` : `${id}-category`,
    validate: () => {
      const errors: Partial<Record<"category" | "reason" | "typedName", string>> = {};
      if (!categories.some((c) => c.value === draft.category))
        errors.category = "Choose a reason category.";
      if (!reasonLongEnough(draft.reason))
        errors.reason = `Explain the reason in at least ${REASON_MIN_CHARS} characters.`;
      if (destructive && !typedNameMatches(draft.typedName, targetName ?? ""))
        errors.typedName = "Type the name exactly to confirm.";
      return errors;
    },
  });

  function close() {
    if (pending) return;
    setDraft(EMPTY);
    setFailure(null);
    onClose();
  }

  function confirm() {
    if (pending || blockers.length > 0) return;
    if (validation.submit() !== null) return;
    setFailure(null);
    startTransition(async () => {
      const outcome = await onConfirm(toConfirmReason(draft));
      onSettled?.(outcome);
      if (outcome.ok) {
        setDraft(EMPTY);
        setFailure(null);
        onClose();
      } else setFailure(outcome);
    });
  }

  const set = (patch: Partial<ConfirmDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      initialFocusRef={destructive ? cancelRef : undefined}
      returnFocus={returnFocus}
      footer={
        <>
          {blockers.length > 0 ? (
            <p className="overlay__hint" id={`${id}-blocker`}>
              {blockers[0]}
            </p>
          ) : null}
          <button ref={cancelRef} type="button" className="btn btn--ghost" onClick={close}>
            <span>Cancel</span>
          </button>
          <button
            type="button"
            className={`btn ${destructive ? "btn--danger" : "btn--primary"}`}
            disabled={blockers.length > 0 || pending}
            aria-describedby={blockers.length > 0 ? `${id}-blocker` : undefined}
            onClick={confirm}
          >
            {icon ? <Icon name={icon} /> : null}
            <span>{pending ? "Working…" : confirmLabel}</span>
          </button>
        </>
      }
    >
      <table className="diff">
        <caption className="sr-only">What changes</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.label}>
              <th scope="row">{c.label}</th>
              <td className="diff__before">{c.before}</td>
              <td className="diff__after">{c.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={validation.shaking ? "form form--shake" : "form"}>
        <FormSummary errors={validation.visible} />
        <label className="field" htmlFor={`${id}-category`}>
          <span className="field__label">
            Reason<span className="req">*</span>
          </span>
          <select
            id={`${id}-category`}
            ref={categoryRef}
            className="field__input"
            required
            value={draft.category}
            onChange={(e) => set({ category: e.target.value })}
            onBlur={() => validation.onBlur("category")}
            aria-invalid={validation.errors.category ? true : undefined}
            aria-describedby={
              validation.errors.category ? `${id}-category-error` : undefined
            }
          >
            <option value="" disabled>
              Choose a category
            </option>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <FieldError id={`${id}-category-error`}>{validation.errors.category}</FieldError>
        </label>
        <label className="field" htmlFor={`${id}-reason`}>
          <span className="field__label">
            Explain why<span className="req">*</span>
          </span>
          <textarea
            id={`${id}-reason`}
            ref={reasonRef}
            className="field__input"
            rows={3}
            required
            minLength={REASON_MIN_CHARS}
            value={draft.reason}
            onChange={(e) => set({ reason: e.target.value })}
            onBlur={() => validation.onBlur("reason")}
            aria-invalid={validation.errors.reason ? true : undefined}
            aria-describedby={
              validation.errors.reason
                ? `${id}-reason-count ${id}-reason-error`
                : `${id}-reason-count`
            }
          />
          <FieldError id={`${id}-reason-error`}>{validation.errors.reason}</FieldError>
          <span className="field__help" id={`${id}-reason-count`}>
            {reasonLength} of at least {REASON_MIN_CHARS} characters
          </span>
        </label>
        {destructive ? (
          <label className="field" htmlFor={`${id}-name`}>
            <span className="field__label">
              Type <strong className="confirm__name">{targetName}</strong> to confirm
              <span className="req">*</span>
            </span>
            <input
              id={`${id}-name`}
              ref={nameRef}
              className="field__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              value={draft.typedName}
              onChange={(e) => set({ typedName: e.target.value })}
              onBlur={() => validation.onBlur("typedName")}
              aria-invalid={validation.errors.typedName ? true : undefined}
              aria-describedby={
                validation.errors.typedName ? `${id}-name-error` : undefined
              }
            />
            <FieldError id={`${id}-name-error`}>{validation.errors.typedName}</FieldError>
          </label>
        ) : null}
      </div>
      {failure ? (
        <AdminActionResultBanner outcome={failure} eventsLink={null} onRetry={confirm} />
      ) : null}
    </Dialog>
  );
}

"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { AdminActionResultBanner } from "../../../../components/admin-action-result-banner";
import { FieldError, FormSummary, useFormValidation } from "../../../../components/form-feedback";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";
import {
  LAUNCH_TEST_CITY_GROUPS,
  LAUNCH_TEST_TRADE_GROUPS,
  NUMBERS_CITY_LABELS,
  NUMBERS_TRADE_LABELS,
  type LaunchTestCityGroup,
  type LaunchTestTradeGroup,
} from "../../../../lib/numbers-vocabulary";
import { recordLaunchFactoryAction } from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const LINK_REF = /^[!-~]{1,300}$/;

interface Draft {
  factoryName: string;
  factoryPhone: string;
  cityGroup: LaunchTestCityGroup;
  tradeGroup: LaunchTestTradeGroup;
  sentAt: string;
  workerIds: string;
  payerId: string;
  paymentLinkRef: string;
  linkCreatedAt: string;
}

const EMPTY: Draft = {
  factoryName: "",
  factoryPhone: "",
  cityGroup: "ncr",
  tradeGroup: "cnc_operator",
  sentAt: "",
  workerIds: "",
  payerId: "",
  paymentLinkRef: "",
  linkCreatedAt: "",
};

/**
 * "Add factory" for launch test A (#2884).
 *
 * Nothing is sent, linked or charged: the desk records what it did by hand. The Idempotency-Key is
 * minted once for the draft and reused on a failed submit, so a retry cannot record the factory
 * twice.
 */
export function RecordFactoryForm() {
  const router = useRouter();
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const validation = useFormValidation({
    order: ["factoryName", "sentAt", "workerIds"] as const,
    fieldId: (field) => `${ids}-${field}`,
    focus: (field) => {
      if (typeof document !== "undefined") document.getElementById(`${ids}-${field}`)?.focus();
    },
    validate: () => {
      const errors: Partial<Record<"factoryName" | "sentAt" | "workerIds", string>> = {};
      if (draft.factoryName.trim() === "") errors.factoryName = "Enter the factory name.";
      if (draft.sentAt.trim() === "") errors.sentAt = "Choose when the profiles were sent.";
      const workers = splitIds(draft.workerIds);
      if (workers.length === 0) errors.workerIds = "Enter at least one worker id.";
      else if (workers.length > 5) errors.workerIds = "Enter at most five worker ids.";
      else if (workers.some((id) => !UUID.test(id)))
        errors.workerIds = "Each worker id must be a valid id.";
      else if (new Set(workers).size !== workers.length)
        errors.workerIds = "Each worker can be sent once.";
      return errors;
    },
  });

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  function submit() {
    if (validation.submit() !== null || pending) return;
    const workers = splitIds(draft.workerIds);
    let sentAt: string;
    let linkCreatedAt: string | undefined;
    try {
      sentAt = new Date(draft.sentAt).toISOString();
      linkCreatedAt = draft.linkCreatedAt ? new Date(draft.linkCreatedAt).toISOString() : undefined;
    } catch {
      setOutcome({ ok: false, error: "Enter a valid date and time." });
      return;
    }
    if (draft.factoryPhone && !E164.test(draft.factoryPhone)) {
      setOutcome({ ok: false, error: "Enter the phone as E.164, for example +919876543210." });
      return;
    }
    if (draft.payerId && !UUID.test(draft.payerId)) {
      setOutcome({ ok: false, error: "That company account id is not valid." });
      return;
    }
    if (draft.paymentLinkRef && !LINK_REF.test(draft.paymentLinkRef)) {
      setOutcome({ ok: false, error: "A payment link is printable ASCII with no spaces." });
      return;
    }

    startTransition(async () => {
      const result = await recordLaunchFactoryAction({
        factoryName: draft.factoryName.trim(),
        factoryPhone: draft.factoryPhone.trim() || undefined,
        cityGroup: draft.cityGroup,
        tradeGroup: draft.tradeGroup,
        sentAt,
        workerIds: workers,
        payerId: draft.payerId.trim() || undefined,
        paymentLinkRef: draft.paymentLinkRef.trim() || undefined,
        linkCreatedAt,
        idempotencyKey: key,
      });
      setOutcome(result);
      if (result.ok) {
        setDraft(EMPTY);
        setKey(crypto.randomUUID());
        router.refresh();
      }
    });
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <FormSummary errors={validation.visible} />

      <div className="cols">
        <label className="field" htmlFor={`${ids}-factoryName`}>
          <span className="field__label">
            Factory name<span className="req">*</span>
          </span>
          <input
            id={`${ids}-factoryName`}
            className="field__input"
            type="text"
            maxLength={200}
            value={draft.factoryName}
            onChange={(e) => set({ factoryName: e.target.value })}
            onBlur={() => validation.onBlur("factoryName")}
          />
          <FieldError id={`${ids}-factoryName-error`}>{validation.errors.factoryName}</FieldError>
        </label>

        <label className="field" htmlFor={`${ids}-factoryPhone`}>
          <span className="field__label">Phone (optional, E.164)</span>
          <input
            id={`${ids}-factoryPhone`}
            className="field__input"
            type="tel"
            autoComplete="off"
            value={draft.factoryPhone}
            onChange={(e) => set({ factoryPhone: e.target.value })}
            placeholder="E.164 format"
          />
          <span className="field__help">Never shown on this screen; the desk keeps its call sheet.</span>
        </label>
      </div>

      <div className="cols">
        <label className="field" htmlFor={`${ids}-city`}>
          <span className="field__label">City group</span>
          <select
            id={`${ids}-city`}
            className="field__input"
            value={draft.cityGroup}
            onChange={(e) => set({ cityGroup: e.target.value as LaunchTestCityGroup })}
          >
            {LAUNCH_TEST_CITY_GROUPS.map((group) => (
              <option key={group} value={group}>
                {NUMBERS_CITY_LABELS[group]}
              </option>
            ))}
          </select>
        </label>

        <label className="field" htmlFor={`${ids}-trade`}>
          <span className="field__label">Trade group</span>
          <select
            id={`${ids}-trade`}
            className="field__input"
            value={draft.tradeGroup}
            onChange={(e) => set({ tradeGroup: e.target.value as LaunchTestTradeGroup })}
          >
            {LAUNCH_TEST_TRADE_GROUPS.map((group) => (
              <option key={group} value={group}>
                {NUMBERS_TRADE_LABELS[group]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field" htmlFor={`${ids}-sentAt`}>
        <span className="field__label">
          Profiles sent at<span className="req">*</span>
        </span>
        <input
          id={`${ids}-sentAt`}
          className="field__input"
          type="datetime-local"
          value={draft.sentAt}
          onChange={(e) => set({ sentAt: e.target.value })}
          onBlur={() => validation.onBlur("sentAt")}
        />
        <FieldError id={`${ids}-sentAt-error`}>{validation.errors.sentAt}</FieldError>
      </label>

      <label className="field" htmlFor={`${ids}-workerIds`}>
        <span className="field__label">
          Worker ids sent (1–5, comma separated)<span className="req">*</span>
        </span>
        <textarea
          id={`${ids}-workerIds`}
          className="field__input"
          rows={3}
          spellCheck={false}
          value={draft.workerIds}
          onChange={(e) => set({ workerIds: e.target.value })}
          onBlur={() => validation.onBlur("workerIds")}
        />
        <FieldError id={`${ids}-workerIds-error`}>{validation.errors.workerIds}</FieldError>
      </label>

      <label className="field" htmlFor={`${ids}-payer`}>
        <span className="field__label">Company account id (optional)</span>
        <input
          id={`${ids}-payer`}
          className="field__input mono"
          type="text"
          spellCheck={false}
          value={draft.payerId}
          onChange={(e) => set({ payerId: e.target.value })}
        />
      </label>

      <div className="cols">
        <label className="field" htmlFor={`${ids}-link`}>
          <span className="field__label">Payment link reference (optional)</span>
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
          <span className="field__label">Link created at (optional)</span>
          <input
            id={`${ids}-linkAt`}
            className="field__input"
            type="datetime-local"
            value={draft.linkCreatedAt}
            onChange={(e) => set({ linkCreatedAt: e.target.value })}
          />
        </label>
      </div>

      {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={null} /> : null}

      <div className="form__actions">
        <button className="btn btn--primary" type="submit" disabled={pending}>
          <Icon name={ACTION_ICON.add} />
          {pending ? "Recording…" : "Record factory"}
        </button>
      </div>
    </form>
  );
}

function splitIds(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

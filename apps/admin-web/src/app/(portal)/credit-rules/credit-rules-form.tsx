"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { FieldError } from "../../../components/form-feedback";
import { InlineNotice } from "../../../components/inline-notice";
import { StatusPill } from "../../../components/status-pill";
import { Timestamp } from "../../../components/timestamp";
import {
  CREDIT_RULE_FIELDS,
  CREDIT_RULES_REASON_MAX,
  CREDIT_RULES_REASON_MIN,
  creditRuleLabel,
  formValuesFromRules,
  isCreditRuleKey,
  validateCreditRulesForm,
  type CreditRuleFormValues,
  type CreditRulesFieldErrors,
  type CreditRulesSnapshot,
  type SaveCreditRulesResult,
} from "../../../lib/credit-rules-model";
import { saveCreditRulesAction } from "./actions";

function changedFromDefault(
  field: (typeof CREDIT_RULE_FIELDS)[number],
  values: CreditRuleFormValues,
  defaults: CreditRulesSnapshot["defaults"],
): boolean {
  const raw = values[field.key].trim();
  if (raw === "") return false;
  const value = Number(raw);
  return Number.isInteger(value) && value !== defaults[field.key];
}

function successMessage(result: Extract<SaveCreditRulesResult, { ok: true }>): string {
  if (!result.changed) {
    return `No change — the rules already matched revision ${result.revision}.`;
  }
  const labels = result.changed_keys
    .map((key) => (isCreditRuleKey(key) ? creditRuleLabel(key) : key))
    .join(", ");
  return labels
    ? `Saved as revision ${result.revision}. Changed: ${labels}.`
    : `Saved as revision ${result.revision}.`;
}

/**
 * The credit rules editor (#2878).
 *
 * Every rule is a whole number with its plain-language meaning, its bounds and the brief's
 * default beside it. A field whose current value differs from the default is marked. Saving
 * sends the WHOLE set, the revision that was loaded, and a written reason — a stale revision
 * is a 409 and changes nothing, and a 400 is shown on the field that caused it.
 */
export function CreditRulesForm({ initial }: { initial: CreditRulesSnapshot }) {
  const router = useRouter();
  const [values, setValues] = useState<CreditRuleFormValues>(() =>
    formValuesFromRules(initial.rules),
  );
  const [reason, setReason] = useState("");
  const [meta, setMeta] = useState({
    revision: initial.revision,
    source: initial.source,
    updated_at: initial.updated_at,
  });
  const [fieldErrors, setFieldErrors] = useState<CreditRulesFieldErrors>({});
  const [outcome, setOutcome] = useState<SaveCreditRulesResult | null>(null);
  const [pending, startTransition] = useTransition();

  function setValue(key: (typeof CREDIT_RULE_FIELDS)[number]["key"], value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setOutcome(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setOutcome(null);

    const validation = validateCreditRulesForm({ values, reason });
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      const first =
        CREDIT_RULE_FIELDS.find((field) => validation.errors[field.key])?.key ??
        ("reason" in validation.errors ? "reason" : null);
      if (first && typeof document !== "undefined") {
        document.getElementById(`credit-rule-${first}`)?.focus();
      }
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      const result = await saveCreditRulesAction({
        rules: validation.rules,
        expectedRevision: meta.revision,
        reasonText: reason,
      });
      setOutcome(result);
      if (result.ok) {
        setValues(formValuesFromRules(result.rules));
        setReason("");
        setFieldErrors({});
        setMeta({
          revision: result.revision,
          source: result.source,
          updated_at: result.updated_at,
        });
        router.refresh();
      } else if (result.fieldErrors) {
        setFieldErrors(result.fieldErrors);
      }
    });
  }

  const stale = outcome !== null && !outcome.ok && outcome.kind === "stale";
  const failed = outcome !== null && !outcome.ok && outcome.kind === "error";
  const invalid = outcome !== null && !outcome.ok && outcome.kind === "validation";

  return (
    <div>
      <dl className="kv">
        <dt className="kv__k">Revision</dt>
        <dd className="kv__v">{meta.revision === 0 ? "0 — no revision saved yet" : meta.revision}</dd>
        <dt className="kv__k">Last changed</dt>
        <dd className="kv__v">
          {meta.updated_at ? <Timestamp iso={meta.updated_at} /> : "Never"}
        </dd>
        <dt className="kv__k">Source</dt>
        <dd className="kv__v">
          {meta.source === "db" ? "Saved values" : "The brief's defaults"}
        </dd>
      </dl>

      {stale ? (
        <InlineNotice
          tone="warning"
          title="Someone saved these rules first"
          action={{ label: "Reload the newest revision", onClick: () => window.location.reload() }}
        >
          Your copy is out of date, so nothing was written. Reload to see the current rules and
          make your change again.
        </InlineNotice>
      ) : null}

      {failed ? <InlineNotice title="The rules were not saved">{outcome.error}</InlineNotice> : null}

      {invalid && !fieldErrors.form ? (
        <InlineNotice tone="warning" title="Check the highlighted fields">
          {outcome.error}
        </InlineNotice>
      ) : null}

      {fieldErrors.form ? (
        <InlineNotice tone="warning" title="Check the form">
          {fieldErrors.form}
        </InlineNotice>
      ) : null}

      {outcome?.ok ? (
        <InlineNotice tone="info" title="Saved">
          {successMessage(outcome)}
        </InlineNotice>
      ) : null}

      <form className="form" onSubmit={submit} noValidate aria-busy={pending}>
        <div className="form-grid">
          {CREDIT_RULE_FIELDS.map((field) => {
            const id = `credit-rule-${field.key}`;
            const helpId = `${id}-help`;
            const error = fieldErrors[field.key];
            const defaulted = initial.defaults[field.key];
            const differs = changedFromDefault(field, values, initial.defaults);
            return (
              <div className="field" key={field.key}>
                <label className="field__label" htmlFor={id}>
                  {field.label}
                  {differs ? (
                    <>
                      {" "}
                      <StatusPill value="changed" label="Changed" tone="warn" />
                    </>
                  ) : null}
                </label>
                <input
                  id={id}
                  className="field__input"
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={field.min}
                  max={field.max}
                  value={values[field.key]}
                  onChange={(event) => setValue(field.key, event.target.value)}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? `${id}-error ${helpId}` : helpId}
                  disabled={pending}
                />
                <span className="field__help" id={helpId}>
                  {field.help} Allowed {field.min}–{field.max}. <strong>default {defaulted}</strong>.
                </span>
                <FieldError id={`${id}-error`}>{error}</FieldError>
              </div>
            );
          })}
        </div>

        <label className="field" htmlFor="credit-rules-reason">
          <span className="field__label">Reason for this change (required)</span>
          <textarea
            id="credit-rules-reason"
            className="field__input"
            rows={3}
            value={reason}
            maxLength={CREDIT_RULES_REASON_MAX}
            onChange={(event) => {
              setReason(event.target.value);
              setFieldErrors((prev) => {
                if (!prev.reason) return prev;
                const next = { ...prev };
                delete next.reason;
                return next;
              });
              setOutcome(null);
            }}
            aria-invalid={fieldErrors.reason ? "true" : undefined}
            aria-describedby="credit-rules-reason-help credit-rules-reason-error"
            disabled={pending}
          />
          <span className="field__help" id="credit-rules-reason-help">
            {CREDIT_RULES_REASON_MIN}–{CREDIT_RULES_REASON_MAX} characters, kept with the audit
            record. Do not include a phone number or email address.
          </span>
          <FieldError id="credit-rules-reason-error">{fieldErrors.reason}</FieldError>
        </label>

        <div className="form-actions">
          <button type="submit" className="btn btn--primary" disabled={pending}>
            <Icon name="floppy-disk" />
            <span>{pending ? "Saving…" : "Save credit rules"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

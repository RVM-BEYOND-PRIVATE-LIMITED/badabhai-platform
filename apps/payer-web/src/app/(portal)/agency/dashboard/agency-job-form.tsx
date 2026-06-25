"use client";

import { useState, useTransition } from "react";
import { NEEDED_BY, TRADE_KEYS, type AgencyJob, type NeededBy } from "../../../../lib/contracts";
import { neededByLabel, tradeLabel } from "../../../../lib/agency-view";

/**
 * Shared CREATE/EDIT form for an agency vacancy (ADR-0022, LIVE), rendered INLINE on the
 * agency dashboard.
 *
 * Runs in the BROWSER and sees NO secret. It collects ONLY the coarse, non-PII demand
 * fields (a trade enum, a generic role title, a city/area label, ₹ pay bands, year
 * counts, a coarse timing enum). There is deliberately NO employer-name field and NO
 * worker field — those are not demand attributes (ADR-0009 §2 / ADR-0022 privacy line).
 * The session payer is stamped server-side (XB-A); this form never sends a payer id.
 */

interface AgencyJobInputValues {
  tradeKey: string;
  title: string;
  city: string;
  area?: string;
  payMin?: number;
  payMax?: number;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  neededBy?: NeededBy;
}

/** The discriminated result the parent action wrapper returns to the form. */
export type AgencyJobFormSubmitResult = { ok: true } | { ok: false; error: string };

interface FormFields {
  tradeKey: string;
  title: string;
  city: string;
  area: string;
  payMin: string;
  payMax: string;
  minExperienceYears: string;
  maxExperienceYears: string;
  neededBy: string;
}

/**
 * Per-field client validation parity (C9). Mirrors `agencyJobInputSchema` in contracts.ts —
 * the SERVER Zod stays the AUTHORITY; this is UX parity (inline errors before a round-trip),
 * not a new gate. The numeric ceilings MUST stay in parity with the backend `agency.dto.ts`
 * consts PAY_MAX_INR / EXPERIENCE_MAX_YEARS (same VALUES — the same C10 contract).
 */
const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling (₹1 crore) — parity with contracts.ts
const EXPERIENCE_MAX_YEARS = 60; // a plausible career length ceiling — parity with contracts.ts

type FieldKey =
  | "title"
  | "city"
  | "payMin"
  | "payMax"
  | "minExperienceYears"
  | "maxExperienceYears";
type FieldErrors = Partial<Record<FieldKey, string>>;

function fromJob(job: AgencyJob): FormFields {
  return {
    tradeKey: job.tradeKey,
    title: job.title,
    city: job.city,
    area: job.area ?? "",
    payMin: job.payMin === null ? "" : String(job.payMin),
    payMax: job.payMax === null ? "" : String(job.payMax),
    minExperienceYears: job.minExperienceYears === null ? "" : String(job.minExperienceYears),
    maxExperienceYears: job.maxExperienceYears === null ? "" : String(job.maxExperienceYears),
    neededBy: job.neededBy ?? "",
  };
}

const BLANK: FormFields = {
  tradeKey: TRADE_KEYS[0],
  title: "",
  city: "",
  area: "",
  payMin: "",
  payMax: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  neededBy: "",
};

/** Parse an optional non-negative integer field; "" → undefined; bad → NaN (caught below). */
function optInt(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

/**
 * Inline per-field + cross-field validation mirroring `agencyJobInputSchema` (C9). Returns a
 * per-field error map; the form blocks submit until it is empty (parity with the posting-form
 * template). The server Zod remains the authority — this only avoids a round-trip on bad input.
 */
function validate(fields: FormFields): FieldErrors {
  const errs: FieldErrors = {};

  // Required, non-empty (schema: title/city min(1)).
  if (fields.title.trim().length < 1) errs.title = "Enter a role title.";
  if (fields.city.trim().length < 1) errs.city = "Enter a city.";

  // Numeric fields: whole, non-negative, within the C10 upper bounds.
  const payMin = optInt(fields.payMin);
  const payMax = optInt(fields.payMax);
  const minExp = optInt(fields.minExperienceYears);
  const maxExp = optInt(fields.maxExperienceYears);

  if (Number.isNaN(payMin)) errs.payMin = "Min pay must be a whole non-negative number.";
  else if (payMin !== undefined && payMin > PAY_MAX_INR)
    errs.payMin = `Min pay must be at most ${PAY_MAX_INR.toLocaleString("en-IN")}.`;

  if (Number.isNaN(payMax)) errs.payMax = "Max pay must be a whole non-negative number.";
  else if (payMax !== undefined && payMax > PAY_MAX_INR)
    errs.payMax = `Max pay must be at most ${PAY_MAX_INR.toLocaleString("en-IN")}.`;

  if (Number.isNaN(minExp))
    errs.minExperienceYears = "Min experience must be a whole non-negative number.";
  else if (minExp !== undefined && minExp > EXPERIENCE_MAX_YEARS)
    errs.minExperienceYears = `Min experience must be at most ${EXPERIENCE_MAX_YEARS} years.`;

  if (Number.isNaN(maxExp))
    errs.maxExperienceYears = "Max experience must be a whole non-negative number.";
  else if (maxExp !== undefined && maxExp > EXPERIENCE_MAX_YEARS)
    errs.maxExperienceYears = `Max experience must be at most ${EXPERIENCE_MAX_YEARS} years.`;

  // Cross-field (schema refines): payMax >= payMin; maxExp >= minExp. Only when both parse.
  if (
    !errs.payMin &&
    !errs.payMax &&
    payMin !== undefined &&
    payMax !== undefined &&
    payMax < payMin
  ) {
    errs.payMax = "Max pay must be greater than or equal to min pay.";
  }
  if (
    !errs.minExperienceYears &&
    !errs.maxExperienceYears &&
    minExp !== undefined &&
    maxExp !== undefined &&
    maxExp < minExp
  ) {
    errs.maxExperienceYears = "Max experience must be greater than or equal to min experience.";
  }

  return errs;
}

export function AgencyJobForm({
  mode,
  job,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  mode: "create" | "edit";
  job?: AgencyJob;
  onSubmit: (input: AgencyJobInputValues) => Promise<AgencyJobFormSubmitResult>;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const [fields, setFields] = useState<FormFields>(job ? fromJob(job) : BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Disable-submit-until-valid (parity with the posting-form template).
  const isValid = Object.keys(validate(fields)).length === 0;

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // Clear that field's inline error as the user edits it (mirrors posting-form).
    if (key in fieldErrors) setFieldErrors((p) => ({ ...p, [key]: undefined }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const errs = validate(fields);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const payMin = optInt(fields.payMin);
    const payMax = optInt(fields.payMax);
    const minExp = optInt(fields.minExperienceYears);
    const maxExp = optInt(fields.maxExperienceYears);

    startTransition(async () => {
      const res = await onSubmit({
        tradeKey: fields.tradeKey,
        title: fields.title,
        city: fields.city,
        area: fields.area.trim() || undefined,
        payMin,
        payMax,
        minExperienceYears: minExp,
        maxExperienceYears: maxExp,
        neededBy: (fields.neededBy || undefined) as NeededBy | undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Success: the parent updates the row list and unmounts/closes this form.
      if (mode === "create") setFields(BLANK);
    });
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="tradeKey">
          Trade<span className="req">*</span>
        </label>
        <select
          id="tradeKey"
          className="input"
          value={fields.tradeKey}
          onChange={(e) => set("tradeKey", e.target.value)}
        >
          {TRADE_KEYS.map((t) => (
            <option key={t} value={t}>
              {tradeLabel(t)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="title">
          Role title<span className="req">*</span>
        </label>
        <input
          id="title"
          className="input"
          placeholder="CNC Operator — Night Shift"
          value={fields.title}
          aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={fieldErrors.title ? "title-error" : undefined}
          onChange={(e) => set("title", e.target.value)}
        />
        {fieldErrors.title ? (
          <p className="error-text" id="title-error">
            {fieldErrors.title}
          </p>
        ) : null}
        <p className="page-sub" style={{ margin: "4px 0 0" }}>
          A generic role title — never an employer name or contact details.
        </p>
      </div>

      <div className="field">
        <label htmlFor="city">
          City<span className="req">*</span>
        </label>
        <input
          id="city"
          className="input"
          placeholder="Pune"
          value={fields.city}
          aria-invalid={fieldErrors.city ? true : undefined}
          aria-describedby={fieldErrors.city ? "city-error" : undefined}
          onChange={(e) => set("city", e.target.value)}
        />
        {fieldErrors.city ? (
          <p className="error-text" id="city-error">
            {fieldErrors.city}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="area">Area / locality</label>
        <input
          id="area"
          className="input"
          placeholder="Pimpri-Chinchwad"
          value={fields.area}
          onChange={(e) => set("area", e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="payMin">Pay band — min (₹ / month)</label>
        <input
          id="payMin"
          className="input"
          inputMode="numeric"
          placeholder="20000"
          value={fields.payMin}
          aria-invalid={fieldErrors.payMin ? true : undefined}
          aria-describedby={fieldErrors.payMin ? "payMin-error" : undefined}
          onChange={(e) => set("payMin", e.target.value)}
        />
        {fieldErrors.payMin ? (
          <p className="error-text" id="payMin-error">
            {fieldErrors.payMin}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="payMax">Pay band — max (₹ / month)</label>
        <input
          id="payMax"
          className="input"
          inputMode="numeric"
          placeholder="35000"
          value={fields.payMax}
          aria-invalid={fieldErrors.payMax ? true : undefined}
          aria-describedby={fieldErrors.payMax ? "payMax-error" : undefined}
          onChange={(e) => set("payMax", e.target.value)}
        />
        {fieldErrors.payMax ? (
          <p className="error-text" id="payMax-error">
            {fieldErrors.payMax}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="minExperienceYears">Experience — min (years)</label>
        <input
          id="minExperienceYears"
          className="input"
          inputMode="numeric"
          placeholder="1"
          value={fields.minExperienceYears}
          aria-invalid={fieldErrors.minExperienceYears ? true : undefined}
          aria-describedby={fieldErrors.minExperienceYears ? "minExperienceYears-error" : undefined}
          onChange={(e) => set("minExperienceYears", e.target.value)}
        />
        {fieldErrors.minExperienceYears ? (
          <p className="error-text" id="minExperienceYears-error">
            {fieldErrors.minExperienceYears}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="maxExperienceYears">Experience — max (years)</label>
        <input
          id="maxExperienceYears"
          className="input"
          inputMode="numeric"
          placeholder="5"
          value={fields.maxExperienceYears}
          aria-invalid={fieldErrors.maxExperienceYears ? true : undefined}
          aria-describedby={fieldErrors.maxExperienceYears ? "maxExperienceYears-error" : undefined}
          onChange={(e) => set("maxExperienceYears", e.target.value)}
        />
        {fieldErrors.maxExperienceYears ? (
          <p className="error-text" id="maxExperienceYears-error">
            {fieldErrors.maxExperienceYears}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="neededBy">Needed by</label>
        <select
          id="neededBy"
          className="input"
          value={fields.neededBy}
          onChange={(e) => set("neededBy", e.target.value)}
        >
          <option value="">— select —</option>
          {NEEDED_BY.map((n) => (
            <option key={n} value={n}>
              {neededByLabel(n)}
            </option>
          ))}
        </select>
      </div>

      <div className="btn-row">
        <button className="btn" type="submit" disabled={pending || !isValid}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button className="btn secondary" type="button" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      {mode === "edit" ? (
        <p className="page-sub" style={{ margin: 0 }}>
          A closed vacancy cannot be edited — reopen is out of scope for this release.
        </p>
      ) : null}
      <div aria-live="polite">{error ? <p className="error-text">{error}</p> : null}</div>
    </form>
  );
}

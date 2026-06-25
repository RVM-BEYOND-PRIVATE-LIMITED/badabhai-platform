"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import { TRADE_KEYS } from "../../../../lib/contracts";
import { tradeLabel } from "../../../../lib/agency-view";
import { createPostingAction } from "./actions";

/**
 * Client form for posting a job (EMPLOYER self-serve). Free-through-launch copy comes
 * from the server page.
 *
 * Brought to DEMAND-schema parity with the agency job form: a trade enum, ordered
 * C10-bounded ₹ pay bands, ordered bounded experience years, plus role/location/
 * description and a RAW `vacancies` count (the PRIMARY input — the band is derived from
 * it server-side, so the form never picks a band). Runs in the BROWSER and sees NO
 * secret; the session payer is stamped server-side (XB-A) and there is deliberately NO
 * employer-name field (the payer's own org is the session identity).
 *
 * `createPostingInputSchema` (mirrored by the action's server Zod) stays the AUTHORITY;
 * this inline `validate()` is UX parity (C9) — per-field + cross-field errors before a
 * round-trip, plus a client-side PII heuristic on the only free-text field (description).
 */

const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling — parity with contracts.ts / agency form
const EXPERIENCE_MAX_YEARS = 60; // a plausible career length ceiling — parity with contracts.ts

interface FormFields {
  tradeKey: string;
  roleTitle: string;
  locationLabel: string;
  vacancies: string;
  payMin: string;
  payMax: string;
  minExperienceYears: string;
  maxExperienceYears: string;
  description: string;
}

type FieldKey =
  | "roleTitle"
  | "vacancies"
  | "payMin"
  | "payMax"
  | "minExperienceYears"
  | "maxExperienceYears"
  | "description";
type FieldErrors = Partial<Record<FieldKey, string>>;

const BLANK: FormFields = {
  tradeKey: TRADE_KEYS[0],
  roleTitle: "",
  locationLabel: "",
  vacancies: "",
  payMin: "",
  payMax: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  description: "",
};

/** Parse an optional non-negative integer field; "" → undefined; bad → NaN (caught below). */
function optInt(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

/**
 * Inline per-field + cross-field validation mirroring `createPostingInputSchema` (C9).
 * Returns a per-field error map; the form blocks submit until it is empty. The server Zod
 * (the action) remains the authority — this only avoids a round-trip on bad input.
 */
function validate(fields: FormFields): FieldErrors {
  const errs: FieldErrors = {};

  // Role title: required, 2–120 (schema: min(2).max(120)).
  const role = fields.roleTitle.trim();
  if (role.length < 2 || role.length > 120) {
    errs.roleTitle = "Role title must be 2–120 characters.";
  }

  // Vacancies: REQUIRED whole positive integer (schema: int().positive()).
  const v = fields.vacancies.trim();
  const vacancies = Number(v);
  if (v === "" || !Number.isInteger(vacancies) || vacancies < 1) {
    errs.vacancies = "Vacancies must be a whole number of 1 or more.";
  }

  // Optional numeric fields: whole, non-negative, within the C10 upper bounds.
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

  // Description (the only free-text field): PII heuristic — block an OBVIOUS phone/email
  // client-side (the action's Zod re-screens with the same `looksLikePii` as the authority).
  const desc = fields.description.trim();
  if (desc.length > 0 && looksLikePii(desc)) {
    errs.description = "Remove contact details (phone/email) from the description.";
  }

  return errs;
}

export function PostingForm() {
  const router = useRouter();
  // useState order (mirrored by posting-form.test.tsx): fields, fieldErrors, error, navigating.
  const [fields, setFields] = useState<FormFields>(BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  // B7: after a SUCCESSFUL create we navigate away. The transition ends as soon as the
  // action resolves, but `router.push`/`refresh` are still in flight — so we latch a
  // separate `navigating` flag that stays true until this component unmounts on navigation.
  // This keeps the submit button disabled across the success→navigation window so it can
  // never look unsubmitted or be re-clicked (no double create).
  const [navigating, setNavigating] = useState(false);
  const [pending, startTransition] = useTransition();

  // Disable-submit-until-valid (parity with the agency form template).
  const isValid = Object.keys(validate(fields)).length === 0;

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // Clear that field's inline error as the user edits it (mirrors the agency form).
    if (key in fieldErrors) setFieldErrors((p) => ({ ...p, [key]: undefined }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const errs = validate(fields);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    startTransition(async () => {
      const res = await createPostingAction({
        tradeKey: fields.tradeKey,
        roleTitle: fields.roleTitle.trim(),
        locationLabel: fields.locationLabel,
        description: fields.description,
        vacancies: Number(fields.vacancies.trim()),
        payMin: optInt(fields.payMin),
        payMax: optInt(fields.payMax),
        minExperienceYears: optInt(fields.minExperienceYears),
        maxExperienceYears: optInt(fields.maxExperienceYears),
      });
      if (res.ok) {
        // Latch BEFORE navigating: keep submit disabled until this form unmounts.
        setNavigating(true);
        router.push(`/postings/${res.postingId}/applicants`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const submitDisabled = pending || navigating || !isValid;

  return (
    <form className="form" onSubmit={onSubmit}>
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
        <label htmlFor="roleTitle">
          Role title<span className="req">*</span>
        </label>
        <input
          id="roleTitle"
          className="input"
          placeholder="CNC Machinist"
          value={fields.roleTitle}
          aria-invalid={fieldErrors.roleTitle ? true : undefined}
          aria-describedby={fieldErrors.roleTitle ? "roleTitle-error" : undefined}
          onChange={(e) => set("roleTitle", e.target.value)}
        />
        {fieldErrors.roleTitle ? (
          <p className="error-text" id="roleTitle-error">
            {fieldErrors.roleTitle}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="locationLabel">Location</label>
        <input
          id="locationLabel"
          className="input"
          placeholder="Pune, MH"
          value={fields.locationLabel}
          onChange={(e) => set("locationLabel", e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="vacancies">
          Vacancies<span className="req">*</span>
        </label>
        <input
          id="vacancies"
          className="input"
          inputMode="numeric"
          placeholder="5"
          value={fields.vacancies}
          aria-invalid={fieldErrors.vacancies ? true : undefined}
          aria-describedby={fieldErrors.vacancies ? "vacancies-error" : undefined}
          onChange={(e) => set("vacancies", e.target.value)}
        />
        {fieldErrors.vacancies ? (
          <p className="error-text" id="vacancies-error">
            {fieldErrors.vacancies}
          </p>
        ) : null}
        <p className="page-sub" style={{ margin: "4px 0 0" }}>
          How many people you need. We store this as a coarse band, never the exact count.
        </p>
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
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          className="input"
          placeholder="Shift timings, machines, location notes…"
          value={fields.description}
          aria-invalid={fieldErrors.description ? true : undefined}
          aria-describedby={fieldErrors.description ? "description-error" : undefined}
          onChange={(e) => set("description", e.target.value)}
        />
        {fieldErrors.description ? (
          <p className="error-text" id="description-error">
            {fieldErrors.description}
          </p>
        ) : null}
        <p className="page-sub" style={{ margin: "4px 0 0" }}>
          Never include a phone number or email — share contact only after you unlock a candidate.
        </p>
      </div>

      <div className="btn-row">
        <button className="btn" type="submit" disabled={submitDisabled}>
          {pending || navigating ? "Posting…" : "Post job"}
        </button>
      </div>
      <div aria-live="polite">{error ? <p className="error-text">{error}</p> : null}</div>
    </form>
  );
}

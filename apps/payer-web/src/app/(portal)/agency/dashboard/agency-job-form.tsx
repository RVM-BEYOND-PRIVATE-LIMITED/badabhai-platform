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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payMin = optInt(fields.payMin);
    const payMax = optInt(fields.payMax);
    const minExp = optInt(fields.minExperienceYears);
    const maxExp = optInt(fields.maxExperienceYears);
    if ([payMin, payMax, minExp, maxExp].some((n) => Number.isNaN(n))) {
      setError("Pay and experience must be whole non-negative numbers.");
      return;
    }

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
          onChange={(e) => set("title", e.target.value)}
        />
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
          onChange={(e) => set("city", e.target.value)}
        />
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
          onChange={(e) => set("payMin", e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="payMax">Pay band — max (₹ / month)</label>
        <input
          id="payMax"
          className="input"
          inputMode="numeric"
          placeholder="35000"
          value={fields.payMax}
          onChange={(e) => set("payMax", e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="minExperienceYears">Experience — min (years)</label>
        <input
          id="minExperienceYears"
          className="input"
          inputMode="numeric"
          placeholder="1"
          value={fields.minExperienceYears}
          onChange={(e) => set("minExperienceYears", e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="maxExperienceYears">Experience — max (years)</label>
        <input
          id="maxExperienceYears"
          className="input"
          inputMode="numeric"
          placeholder="5"
          value={fields.maxExperienceYears}
          onChange={(e) => set("maxExperienceYears", e.target.value)}
        />
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
        <button className="btn" type="submit" disabled={pending}>
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
      {error ? <p className="error-text">{error}</p> : null}
    </form>
  );
}

"use client";

import { useState, useTransition } from "react";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  TRADE_KEYS,
  type AgencyJob,
  type NeededBy,
} from "../../../../lib/contracts";
import { tradeLabel } from "../../../../lib/agency-view";
import { roleOptionGroups } from "../../../../lib/job-roles";
import { neededByLabel, payTypeLabel, shiftLabel } from "../../../../lib/job-card-view";
import type { CardFields } from "../../../../lib/job-card-view";
import { workerCardGap } from "../../../../lib/worker-card-gap";
import { Button, Card, Chip, Input, Select, Textarea } from "../../../../components/ds";
import { JobCardPreview } from "../../../../components/job-card-preview";

/**
 * Shared CREATE/EDIT form for an agency vacancy (ADR-0022, LIVE) — PR-B: an agency job now traces
 * to the SAME Job Card as a company posting. It collects the role (one of the 21 — display), the
 * trade (its 15-trade matching classifier), the city/area, pay band + pay type, experience, shift,
 * timing, description and requirement/benefit chips, beside a LIVE {@link JobCardPreview}.
 *
 * The workerCardGap rule fires on CREATE (an agency job goes live immediately — create == publish),
 * blocking a thin card. On EDIT of a live job the gaps are HIGHLIGHTED, never blocked (owner ruling).
 * NO employer-name field, NO worker field (faceless/coarse); the session payer is stamped server-side.
 */

const ROLE_GROUPS = roleOptionGroups();

interface AgencyJobInputValues {
  tradeKey: string;
  roleKind: string;
  title: string;
  city: string;
  area?: string;
  payMin?: number;
  payMax?: number;
  payType?: string;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  shift?: string;
  neededBy?: NeededBy;
  description?: string;
  requirements: string[];
  benefits: string[];
}

export type AgencyJobFormSubmitResult = { ok: true } | { ok: false; error: string };

interface FormFields {
  tradeKey: string;
  roleKind: string;
  title: string;
  city: string;
  area: string;
  payMin: string;
  payMax: string;
  payType: string;
  minExperienceYears: string;
  maxExperienceYears: string;
  shift: string;
  neededBy: string;
  description: string;
}

const PAY_MAX_INR = 10_000_000;
const EXPERIENCE_MAX_YEARS = 60;

type FieldKey = "title" | "city" | "payMin" | "payMax" | "minExperienceYears" | "maxExperienceYears";
type FieldErrors = Partial<Record<FieldKey, string>>;

function fromJob(job: AgencyJob): FormFields {
  return {
    tradeKey: job.tradeKey,
    roleKind: job.roleKind ?? "",
    title: job.title,
    city: job.city,
    area: job.area ?? "",
    payMin: job.payMin === null ? "" : String(job.payMin),
    payMax: job.payMax === null ? "" : String(job.payMax),
    payType: job.payType ?? "",
    minExperienceYears: job.minExperienceYears === null ? "" : String(job.minExperienceYears),
    maxExperienceYears: job.maxExperienceYears === null ? "" : String(job.maxExperienceYears),
    shift: job.shift ?? "",
    neededBy: job.neededBy ?? "",
    description: job.description ?? "",
  };
}

const BLANK: FormFields = {
  tradeKey: TRADE_KEYS[0],
  roleKind: "",
  title: "",
  city: "",
  area: "",
  payMin: "",
  payMax: "",
  payType: "",
  minExperienceYears: "",
  maxExperienceYears: "",
  shift: "",
  neededBy: "",
  description: "",
};

function optInt(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

function nullInt(value: string): number | null {
  const n = optInt(value);
  return n === undefined || Number.isNaN(n) ? null : n;
}

function validate(fields: FormFields): FieldErrors {
  const errs: FieldErrors = {};
  if (fields.title.trim().length < 1) errs.title = "Enter a role title.";
  if (fields.city.trim().length < 1) errs.city = "Enter a city.";

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

  if (!errs.payMin && !errs.payMax && payMin !== undefined && payMax !== undefined && payMax < payMin)
    errs.payMax = "Max pay must be greater than or equal to min pay.";
  if (
    !errs.minExperienceYears &&
    !errs.maxExperienceYears &&
    minExp !== undefined &&
    maxExp !== undefined &&
    maxExp < minExp
  )
    errs.maxExperienceYears = "Max experience must be greater than or equal to min experience.";
  return errs;
}

function toCard(fields: FormFields, requirements: string[], benefits: string[]): CardFields {
  return {
    role_title: fields.title.trim() || null,
    role_kind: fields.roleKind || null,
    city: fields.city.trim() || null,
    area: fields.area.trim() || null,
    pay_min: nullInt(fields.payMin),
    pay_max: nullInt(fields.payMax),
    pay_type: fields.payType || null,
    min_experience_years: nullInt(fields.minExperienceYears),
    max_experience_years: nullInt(fields.maxExperienceYears),
    shift: fields.shift || null,
    needed_by: fields.neededBy || null,
    requirements,
    benefits,
  };
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
  // useState call order (mirrored by agency-job-form.test.tsx): fields, fieldErrors, error,
  // requirements, benefits, reqDraft, benDraft, gap.
  const [fields, setFields] = useState<FormFields>(job ? fromJob(job) : BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<string[]>(job?.requirements ?? []);
  const [benefits, setBenefits] = useState<string[]>(job?.benefits ?? []);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [gap, setGap] = useState<{ title: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const isValid = Object.keys(validate(fields)).length === 0;

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    if (key in fieldErrors) setFieldErrors((p) => ({ ...p, [key]: undefined }));
  }

  function addChip(kind: "req" | "ben") {
    const draft = (kind === "req" ? reqDraft : benDraft).trim();
    if (draft === "") return;
    if (kind === "req") {
      setRequirements((prev) => (prev.includes(draft) ? prev : [...prev, draft]));
      setReqDraft("");
    } else {
      setBenefits((prev) => (prev.includes(draft) ? prev : [...prev, draft]));
      setBenDraft("");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGap(null);

    const errs = validate(fields);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // GAP RULE on CREATE (an agency job goes live immediately — create == publish). On EDIT the
    // gaps are only highlighted below, never blocking (owner ruling).
    if (mode === "create") {
      const cardGap = workerCardGap({
        roleKind: fields.roleKind || null,
        city: fields.city,
        payMin: nullInt(fields.payMin),
        payMax: nullInt(fields.payMax),
        payType: fields.payType || null,
        expMin: nullInt(fields.minExperienceYears),
        expMax: nullInt(fields.maxExperienceYears),
        shift: fields.shift || null,
        neededBy: fields.neededBy || null,
        description: fields.description,
        requirements,
        benefits,
      });
      if (cardGap !== null) {
        setGap(cardGap);
        return;
      }
    }

    startTransition(async () => {
      const res = await onSubmit({
        tradeKey: fields.tradeKey,
        roleKind: fields.roleKind,
        title: fields.title,
        city: fields.city,
        area: fields.area.trim() || undefined,
        payMin: optInt(fields.payMin),
        payMax: optInt(fields.payMax),
        payType: fields.payType || undefined,
        minExperienceYears: optInt(fields.minExperienceYears),
        maxExperienceYears: optInt(fields.maxExperienceYears),
        shift: fields.shift || undefined,
        neededBy: (fields.neededBy || undefined) as NeededBy | undefined,
        description: fields.description.trim() || undefined,
        requirements,
        benefits,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (mode === "create") {
        setFields(BLANK);
        setRequirements([]);
        setBenefits([]);
      }
    });
  }

  return (
    <div className="posting-layout">
      <Card as="form" className="agency-job-form" onSubmit={handleSubmit}>
        <Select id="roleKind" label="Role" value={fields.roleKind} onChange={(e) => set("roleKind", e.target.value)}>
          <option value="">— pick the role —</option>
          {ROLE_GROUPS.map((group) => (
            <optgroup key={group.family} label={group.label}>
              {group.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>

        <Select id="tradeKey" label="Trade (matching)" value={fields.tradeKey} onChange={(e) => set("tradeKey", e.target.value)}>
          {TRADE_KEYS.map((t) => (
            <option key={t} value={t}>
              {tradeLabel(t)}
            </option>
          ))}
        </Select>

        <Input id="title" label="Role title" placeholder="CNC Operator — Night Shift" value={fields.title} error={fieldErrors.title} aria-invalid={fieldErrors.title ? true : undefined} hint="A generic role title — never an employer name or contact details." onChange={(e) => set("title", e.target.value)} />

        <div className="agency-job-form__pair">
          <Input id="city" label="City" placeholder="Pune" value={fields.city} error={fieldErrors.city} aria-invalid={fieldErrors.city ? true : undefined} onChange={(e) => set("city", e.target.value)} />
          <Input id="area" label="Area / locality" optional placeholder="Pimpri-Chinchwad" value={fields.area} onChange={(e) => set("area", e.target.value)} />
        </div>

        <div className="agency-job-form__pair">
          <Input id="payMin" label="Pay band — min (₹ / month)" optional inputMode="numeric" placeholder="20000" value={fields.payMin} error={fieldErrors.payMin} aria-invalid={fieldErrors.payMin ? true : undefined} onChange={(e) => set("payMin", e.target.value)} />
          <Input id="payMax" label="Pay band — max (₹ / month)" optional inputMode="numeric" placeholder="35000" value={fields.payMax} error={fieldErrors.payMax} aria-invalid={fieldErrors.payMax ? true : undefined} onChange={(e) => set("payMax", e.target.value)} />
        </div>

        <Select id="payType" label="Pay type" value={fields.payType} onChange={(e) => set("payType", e.target.value)}>
          <option value="">— pick the pay type —</option>
          {PAY_TYPES.map((p) => (
            <option key={p} value={p}>
              {payTypeLabel(p)}
            </option>
          ))}
        </Select>

        <div className="agency-job-form__pair">
          <Input id="minExperienceYears" label="Experience — min (years)" optional inputMode="numeric" placeholder="1" value={fields.minExperienceYears} error={fieldErrors.minExperienceYears} aria-invalid={fieldErrors.minExperienceYears ? true : undefined} onChange={(e) => set("minExperienceYears", e.target.value)} />
          <Input id="maxExperienceYears" label="Experience — max (years)" optional inputMode="numeric" placeholder="5" value={fields.maxExperienceYears} error={fieldErrors.maxExperienceYears} aria-invalid={fieldErrors.maxExperienceYears ? true : undefined} onChange={(e) => set("maxExperienceYears", e.target.value)} />
        </div>

        <div className="agency-job-form__pair">
          <Select id="shift" label="Shift" value={fields.shift} onChange={(e) => set("shift", e.target.value)}>
            <option value="">— pick the shift —</option>
            {SHIFTS.map((s) => (
              <option key={s} value={s}>
                {shiftLabel(s)}
              </option>
            ))}
          </Select>
          <Select id="neededBy" label="Needed by" value={fields.neededBy} onChange={(e) => set("neededBy", e.target.value)}>
            <option value="">— pick joining time —</option>
            {NEEDED_BY.map((n) => (
              <option key={n} value={n}>
                {neededByLabel(n)}
              </option>
            ))}
          </Select>
        </div>

        <Textarea id="description" label="Description" optional value={fields.description} rows={3} hint="What the work is. Never a phone/email or a company name." onChange={(e) => set("description", e.target.value)} />

        <div className="chip-editor">
          <div className="chip-editor__row">
            <Input id="requirements" label="Requirements" optional placeholder="e.g. Fanuc control" value={reqDraft} onChange={(e) => setReqDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChip("req"); } }} />
            <Button type="button" variant="secondary" iconLeft="plus" onClick={() => addChip("req")}>Add</Button>
          </div>
          {requirements.length > 0 ? (
            <div className="chip-editor__chips">
              {requirements.map((item, i) => (
                <Chip key={`${item}:${i}`} onRemove={() => setRequirements((p) => p.filter((_, j) => j !== i))}>{item}</Chip>
              ))}
            </div>
          ) : null}
        </div>
        <div className="chip-editor">
          <div className="chip-editor__row">
            <Input id="benefits" label="Benefits" optional placeholder="e.g. PF + ESI" value={benDraft} onChange={(e) => setBenDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChip("ben"); } }} />
            <Button type="button" variant="secondary" iconLeft="plus" onClick={() => addChip("ben")}>Add</Button>
          </div>
          {benefits.length > 0 ? (
            <div className="chip-editor__chips">
              {benefits.map((item, i) => (
                <Chip key={`${item}:${i}`} onRemove={() => setBenefits((p) => p.filter((_, j) => j !== i))}>{item}</Chip>
              ))}
            </div>
          ) : null}
        </div>

        {gap !== null ? (
          <div className="alert alert--warning" role="alert">
            <i className="ph-fill ph-warning alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__title">{gap.title}</p>
              <p className="alert__body">{gap.message}</p>
            </div>
          </div>
        ) : null}

        <div className="agency-job-form__actions">
          <Button type="submit" disabled={pending || !isValid} loading={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
          {onCancel ? (
            <Button variant="secondary" type="button" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
        <div aria-live="polite" className="agency-job-form__status">
          {error ? <p className="agency-job-form__error">{error}</p> : null}
        </div>
      </Card>

      <aside className="posting-preview" aria-label="Live card preview">
        <JobCardPreview fields={toCard(fields, requirements, benefits)} />
      </aside>
    </div>
  );
}

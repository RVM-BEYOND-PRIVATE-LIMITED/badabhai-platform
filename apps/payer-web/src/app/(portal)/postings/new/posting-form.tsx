"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  type MatchSkillWire,
  type ReachPreview,
} from "../../../../lib/contracts";
import { roleOptionGroups } from "../../../../lib/job-roles";
import { neededByLabel, payTypeLabel, shiftLabel } from "../../../../lib/job-card-view";
import type { CardFields } from "../../../../lib/job-card-view";
import { workerCardGap } from "../../../../lib/worker-card-gap";
import { bandForVacancies, baseApplicantQuotaForBand } from "../../../../lib/pricing-config";
import { Badge, Button, Chip, Input, Select, Textarea } from "../../../../components/ds";
import { JobCardPreview } from "../../../../components/job-card-preview";
import { createPostingAction } from "./actions";
import { MatchSkillPicker, type MatchSelection } from "./match-skill-picker";

/**
 * Post a job (EMPLOYER self-serve) — PR-B: the posting form is the TRACEABLE SOURCE of every Job
 * Card field. The RoleKindSelect leads (all 21 roles, grouped), then every card field, then the
 * skill picker, with a LIVE {@link JobCardPreview} built from the same `CardFields` the card mapper
 * reads. NO mock data; the session payer is stamped server-side (XB-A) and there is NO employer-name
 * field. `createPostingInputSchema` (re-run in the action) stays the AUTHORITY; the inline checks are
 * UX parity. The workerCardGap rule is enforced on CREATE + PUBLISH (owner ruling).
 */

const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling — parity with contracts.ts
const EXPERIENCE_MAX_YEARS = 60; // a plausible career length ceiling — parity with contracts.ts

const ROLE_GROUPS = roleOptionGroups();

interface FormFields {
  roleKind: string;
  roleTitle: string;
  locationLabel: string;
  vacancies: string;
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

type FieldKey =
  | "roleTitle"
  | "vacancies"
  | "city"
  | "payMin"
  | "payMax"
  | "minExperienceYears"
  | "maxExperienceYears"
  | "description";
type FieldErrors = Partial<Record<FieldKey, string>>;

const BLANK: FormFields = {
  roleKind: "",
  roleTitle: "",
  locationLabel: "",
  vacancies: "",
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

/** Parse an optional non-negative integer field; "" → undefined; bad → NaN (caught below). */
function optInt(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

/** "" → null; otherwise the parsed int (or null when unparseable) — for the preview/gap only. */
function nullInt(value: string): number | null {
  const n = optInt(value);
  return n === undefined || Number.isNaN(n) ? null : n;
}

/** Inline per-field + cross-field validation mirroring `createPostingInputSchema` (UX parity). */
function validate(fields: FormFields): FieldErrors {
  const errs: FieldErrors = {};

  const role = fields.roleTitle.trim();
  if (role.length < 2 || role.length > 120) errs.roleTitle = "Role title must be 2–120 characters.";

  const v = fields.vacancies.trim();
  const vacancies = Number(v);
  if (v === "" || !Number.isInteger(vacancies) || vacancies < 1) {
    errs.vacancies = "Vacancies must be a whole number of 1 or more.";
  }

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

  if (!errs.payMin && !errs.payMax && payMin !== undefined && payMax !== undefined && payMax < payMin) {
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

  const desc = fields.description.trim();
  if (desc.length > 0 && looksLikePii(desc)) {
    errs.description = "Remove contact details (phone/email) from the description.";
  }

  return errs;
}

/** The current form as the CardFields the preview + the gap rule read. */
function toCardFields(fields: FormFields, requirements: string[], benefits: string[]): CardFields {
  return {
    role_title: fields.roleTitle.trim() || null,
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

export function PostingForm({
  quotaStep = null,
  matchSkills = [],
}: {
  quotaStep?: number | null;
  matchSkills?: MatchSkillWire[];
} = {}) {
  const router = useRouter();
  // useState call order (mirrored positionally by posting-form.test.tsx): fields, fieldErrors,
  // error, navigating, selection, preview. NEW state is APPENDED AFTER this prefix (requirements,
  // benefits, reqDraft, benDraft, gap) so the positional seeding above keeps working.
  const [fields, setFields] = useState<FormFields>(BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [selection, setSelection] = useState<MatchSelection>({
    matchSkillIds: [],
    untickedRelatedIds: [],
  });
  const [preview, setPreview] = useState<ReachPreview | null>(null);
  // APPENDED — see the note above.
  const [requirements, setRequirements] = useState<string[]>([]);
  const [benefits, setBenefits] = useState<string[]>([]);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [gap, setGap] = useState<{ title: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const isValid =
    Object.keys(validate(fields)).length === 0 && selection.matchSkillIds.length > 0;

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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGap(null);

    const errs = validate(fields);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // GAP RULE — CREATE + PUBLISH only (owner ruling): every card row must be filled before a
    // posting goes live, or the worker's card has a hole. The API stays permissive; this blocks.
    const card = toCardFields(fields, requirements, benefits);
    const cardGap = workerCardGap({
      roleKind: card.role_kind,
      city: card.city ?? "",
      payMin: card.pay_min,
      payMax: card.pay_max,
      payType: card.pay_type,
      expMin: card.min_experience_years,
      expMax: card.max_experience_years,
      shift: card.shift,
      neededBy: card.needed_by,
      description: fields.description,
      requirements,
      benefits,
    });
    if (cardGap !== null) {
      setGap(cardGap);
      return;
    }

    startTransition(async () => {
      const res = await createPostingAction({
        roleKind: fields.roleKind,
        roleTitle: fields.roleTitle.trim(),
        locationLabel: fields.locationLabel,
        description: fields.description,
        vacancies: Number(fields.vacancies.trim()),
        city: fields.city,
        area: fields.area,
        payMin: optInt(fields.payMin),
        payMax: optInt(fields.payMax),
        payType: fields.payType || undefined,
        minExperienceYears: optInt(fields.minExperienceYears),
        maxExperienceYears: optInt(fields.maxExperienceYears),
        shift: fields.shift || undefined,
        neededBy: fields.neededBy || undefined,
        requirements,
        benefits,
        matchSkillIds: selection.matchSkillIds,
        untickedRelatedIds: selection.untickedRelatedIds,
      });
      if (res.ok) {
        setNavigating(true);
        router.push(`/postings/${res.postingId}/applicants`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const submitDisabled = pending || navigating || !isValid;

  const vacanciesNum = Number(fields.vacancies.trim());
  const hasVacancies =
    fields.vacancies.trim() !== "" && Number.isInteger(vacanciesNum) && vacanciesNum >= 1;
  const derivedBand = hasVacancies ? bandForVacancies(vacanciesNum) : null;
  const derivedQuota = derivedBand !== null ? baseApplicantQuotaForBand(derivedBand, quotaStep) : null;

  return (
    <div className="posting-layout">
      <form className="form" onSubmit={onSubmit}>
        <div className="form__section">
          <p className="form__legend">The role</p>

          <Select
            id="roleKind"
            label="Role"
            value={fields.roleKind}
            onChange={(e) => set("roleKind", e.target.value)}
          >
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

          <Input
            id="roleTitle"
            label="Role title"
            placeholder="CNC Machinist"
            value={fields.roleTitle}
            error={fieldErrors.roleTitle}
            aria-invalid={fieldErrors.roleTitle ? true : undefined}
            onChange={(e) => set("roleTitle", e.target.value)}
          />

          <Input
            id="locationLabel"
            label="Location note"
            optional
            placeholder="Pune, MH"
            value={fields.locationLabel}
            hint="Free text for your own note — the worker's card shows the City below, not this."
            onChange={(e) => set("locationLabel", e.target.value)}
          />

          <div className="form-grid">
            <Input
              id="city"
              label="City"
              placeholder="Pune"
              value={fields.city}
              hint="The place shown on the worker's card."
              onChange={(e) => set("city", e.target.value)}
            />
            <Input
              id="area"
              label="Area / locality"
              optional
              placeholder="Pimpri-Chinchwad"
              value={fields.area}
              onChange={(e) => set("area", e.target.value)}
            />
          </div>

          <div className="posting-form__vacancies">
            <Input
              id="vacancies"
              label="Vacancies"
              inputMode="numeric"
              placeholder="5"
              value={fields.vacancies}
              error={fieldErrors.vacancies}
              aria-invalid={fieldErrors.vacancies ? true : undefined}
              hint="How many people you need. We store this as a coarse band, never the exact count."
              onChange={(e) => set("vacancies", e.target.value)}
            />
            {derivedBand !== null ? (
              <div className="posting-form__band" aria-live="polite">
                <Badge icon="users-three">Band {derivedBand}</Badge>
                {derivedQuota !== null ? (
                  <Badge tone="brand">
                    <span className="bb-mono">{derivedQuota}</span> applicant slots
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="form__section">
          <p className="form__legend">Pay and timing</p>

          <div className="form-grid">
            <Input
              id="payMin"
              label="Pay band — min (₹ / month)"
              inputMode="numeric"
              placeholder="20000"
              value={fields.payMin}
              error={fieldErrors.payMin}
              aria-invalid={fieldErrors.payMin ? true : undefined}
              onChange={(e) => set("payMin", e.target.value)}
            />
            <Input
              id="payMax"
              label="Pay band — max (₹ / month)"
              inputMode="numeric"
              placeholder="35000"
              value={fields.payMax}
              error={fieldErrors.payMax}
              aria-invalid={fieldErrors.payMax ? true : undefined}
              onChange={(e) => set("payMax", e.target.value)}
            />
          </div>

          <Select
            id="payType"
            label="Pay type"
            value={fields.payType}
            hint="What the band means. We never guess net-vs-gross."
            onChange={(e) => set("payType", e.target.value)}
          >
            <option value="">— pick the pay type —</option>
            {PAY_TYPES.map((p) => (
              <option key={p} value={p}>
                {payTypeLabel(p)}
              </option>
            ))}
          </Select>

          <div className="form-grid">
            <Input
              id="minExperienceYears"
              label="Experience — min (years)"
              inputMode="numeric"
              placeholder="1"
              value={fields.minExperienceYears}
              error={fieldErrors.minExperienceYears}
              aria-invalid={fieldErrors.minExperienceYears ? true : undefined}
              onChange={(e) => set("minExperienceYears", e.target.value)}
            />
            <Input
              id="maxExperienceYears"
              label="Experience — max (years)"
              inputMode="numeric"
              placeholder="5"
              value={fields.maxExperienceYears}
              error={fieldErrors.maxExperienceYears}
              aria-invalid={fieldErrors.maxExperienceYears ? true : undefined}
              onChange={(e) => set("maxExperienceYears", e.target.value)}
            />
          </div>

          <div className="form-grid">
            <Select
              id="shift"
              label="Shift"
              value={fields.shift}
              onChange={(e) => set("shift", e.target.value)}
            >
              <option value="">— pick the shift —</option>
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  {shiftLabel(s)}
                </option>
              ))}
            </Select>
            <Select
              id="neededBy"
              label="Needed by"
              value={fields.neededBy}
              onChange={(e) => set("neededBy", e.target.value)}
            >
              <option value="">— pick joining time —</option>
              {NEEDED_BY.map((n) => (
                <option key={n} value={n}>
                  {neededByLabel(n)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="form__section">
          <p className="form__legend">Requirements and benefits</p>
          <ChipEditor
            id="requirements"
            label="Requirements"
            placeholder="e.g. Fanuc control"
            draft={reqDraft}
            items={requirements}
            onDraft={setReqDraft}
            onAdd={() => addChip("req")}
            onRemove={(i) => setRequirements((prev) => prev.filter((_, j) => j !== i))}
          />
          <ChipEditor
            id="benefits"
            label="Benefits"
            placeholder="e.g. PF + ESI"
            draft={benDraft}
            items={benefits}
            onDraft={setBenDraft}
            onAdd={() => addChip("ben")}
            onRemove={(i) => setBenefits((prev) => prev.filter((_, j) => j !== i))}
          />
        </div>

        {matchSkills.length > 0 ? (
          <MatchSkillPicker
            vocabulary={matchSkills}
            selection={selection}
            onChange={setSelection}
            onPreviewChange={setPreview}
          />
        ) : (
          <div className="alert alert--danger">
            <i className="ph-fill ph-warning-circle alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__title">Could not load the skill list</p>
              <p className="alert__body">
                Reload the page — a job needs at least one skill before workers can find it.
              </p>
            </div>
          </div>
        )}

        <div className="form__section">
          <p className="form__legend">Description</p>
          <Textarea
            id="description"
            label="Description"
            placeholder="Shift timings, machines, location notes…"
            value={fields.description}
            error={fieldErrors.description}
            aria-invalid={fieldErrors.description ? true : undefined}
            hint="Never include a phone number or email — share contact only after you unlock a candidate."
            onChange={(e) => set("description", e.target.value)}
          />
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

        <div className="form-actions">
          <Button
            type="submit"
            size="lg"
            className="posting-cta"
            iconRight={pending || navigating ? undefined : "rocket-launch"}
            disabled={submitDisabled}
            loading={pending || navigating}
          >
            {pending || navigating
              ? "Posting…"
              : preview?.zero_reach
                ? "Post anyway — reaches nobody yet"
                : "Post job"}
          </Button>
        </div>
        <div aria-live="polite" className="form-status">
          {error ? <p className="posting-form__error">{error}</p> : null}
        </div>
      </form>

      <aside className="posting-preview" aria-label="Live card preview">
        <JobCardPreview fields={toCardFields(fields, requirements, benefits)} />
      </aside>
    </div>
  );
}

/** A small add-a-chip editor: an input + Add button, and the current chips as removable pills. */
function ChipEditor({
  id,
  label,
  placeholder,
  draft,
  items,
  onDraft,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  placeholder: string;
  draft: string;
  items: string[];
  onDraft: (v: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="chip-editor">
      <div className="chip-editor__row">
        <Input
          id={id}
          label={label}
          optional
          placeholder={placeholder}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <Button type="button" variant="secondary" iconLeft="plus" onClick={onAdd}>
          Add
        </Button>
      </div>
      {items.length > 0 ? (
        <div className="chip-editor__chips">
          {items.map((item, i) => (
            <Chip key={`${item}:${i}`} onRemove={() => onRemove(i)}>
              {item}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

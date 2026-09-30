"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import { Badge, Button, Chip, Input, Select, Textarea } from "../../../../../components/ds";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  type MatchSkillWire,
  type ReachPreview,
} from "../../../../../lib/contracts";
import { roleOptionGroups } from "../../../../../lib/job-roles";
import { neededByLabel, payTypeLabel, shiftLabel } from "../../../../../lib/job-card-view";
import type { CardFields } from "../../../../../lib/job-card-view";
import { workerCardGaps } from "../../../../../lib/worker-card-gap";
import type { PostingEditInitial } from "../../../../../lib/payer-api";
import { JobCardPreview } from "../../../../../components/job-card-preview";
import { MatchSkillPicker, type MatchSelection } from "../../new/match-skill-picker";
import { updatePostingAction } from "./actions";

/**
 * Edit a posting (EMPLOYER self-serve; LIVE `PATCH /payer/job-postings/:id`) — PR-B. Every card
 * field + the role + the MatchSkillPicker (prefilled), beside a LIVE {@link JobCardPreview}. The
 * card fields are ONE contract with create (same `CardFields`). DRAFT → "Save draft" (no gap block)
 * + "Publish" (gap block + ≥1 skill). OPEN/PAUSED → "Save changes" (gaps HIGHLIGHTED, never blocked
 * — owner ruling). The `initial` prop drives the `clear` diff (a blanked field is unset server-side).
 */

const PAY_MAX_INR = 10_000_000;
const ROLE_GROUPS = roleOptionGroups();

interface FormFields {
  roleTitle: string;
  roleKind: string;
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

export interface EditPostingInitial extends PostingEditInitial {
  roleTitle: string;
  /** A count INSIDE the stored band, as the edit seed (the server re-derives from a submitted count). */
  vacanciesHint: number;
}

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

function seedEnum(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : "";
}

export function EditPostingForm({
  postingId,
  status,
  initial,
  matchSkills = [],
  matchSelection,
}: {
  postingId: string;
  status: string;
  initial: EditPostingInitial;
  matchSkills?: MatchSkillWire[];
  matchSelection?: MatchSelection;
}) {
  const router = useRouter();
  // useState order (mirrored positionally by edit-posting-form.test.tsx): fields, requirements,
  // benefits, reqDraft, benDraft, error, selection, preview.
  const [fields, setFields] = useState<FormFields>({
    roleTitle: initial.roleTitle,
    roleKind: initial.roleKind ?? "",
    locationLabel: initial.locationLabel ?? "",
    vacancies: String(initial.vacanciesHint),
    city: initial.city ?? "",
    area: initial.area ?? "",
    payMin: initial.payMin !== null ? String(initial.payMin) : "",
    payMax: initial.payMax !== null ? String(initial.payMax) : "",
    payType: seedEnum(initial.payType, PAY_TYPES),
    minExperienceYears: initial.minExperienceYears !== null ? String(initial.minExperienceYears) : "",
    maxExperienceYears: initial.maxExperienceYears !== null ? String(initial.maxExperienceYears) : "",
    shift: seedEnum(initial.shift, SHIFTS),
    neededBy: seedEnum(initial.neededBy, NEEDED_BY),
    description: initial.description ?? "",
  });
  const [requirements, setRequirements] = useState<string[]>(initial.requirements ?? []);
  const [benefits, setBenefits] = useState<string[]>(initial.benefits ?? []);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<MatchSelection>(
    matchSelection ?? { matchSkillIds: [], untickedRelatedIds: [] },
  );
  const [preview, setPreview] = useState<ReachPreview | null>(null);
  const [pending, startTransition] = useTransition();

  const isDraft = status === "draft";

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function card(): CardFields {
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

  /** The gaps STILL open — highlighted (never blocked) so the payer sees what the card is missing. */
  const gaps = workerCardGaps({
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

  function clientValidate(): string | null {
    if ([...fields.roleTitle.trim()].length < 2) return "Role title must be at least 2 characters.";
    const count = Number(fields.vacancies);
    if (!Number.isInteger(count) || count <= 0) return "Vacancies must be a positive number.";
    if (fields.description.trim() !== "" && looksLikePii(fields.description)) {
      return "Remove contact details (phone/email) from the description.";
    }
    const min = optInt(fields.payMin);
    const max = optInt(fields.payMax);
    if (Number.isNaN(min) || (min !== undefined && min > PAY_MAX_INR)) {
      return "Min pay must be a whole number within the allowed range.";
    }
    if (Number.isNaN(max) || (max !== undefined && max > PAY_MAX_INR)) {
      return "Max pay must be a whole number within the allowed range.";
    }
    if (min !== undefined && max !== undefined && max < min) {
      return "Max pay must be greater than or equal to min pay.";
    }
    return null;
  }

  function submit(mode: "save" | "publish") {
    const clientError = clientValidate();
    if (clientError !== null) {
      setError(clientError);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await updatePostingAction({
        postingId,
        roleTitle: fields.roleTitle.trim(),
        roleKind: fields.roleKind || undefined,
        // OMIT the count when untouched — re-submitting the prefill hint would re-derive (and for a
        // "25+" posting DOWNGRADE) the stored band on an unrelated edit.
        vacancies:
          fields.vacancies === String(initial.vacanciesHint) ? undefined : Number(fields.vacancies),
        locationLabel: fields.locationLabel.trim() || undefined,
        description: fields.description.trim() || undefined,
        city: fields.city.trim() || undefined,
        area: fields.area.trim() || undefined,
        payMin: optInt(fields.payMin),
        payMax: optInt(fields.payMax),
        payType: fields.payType || undefined,
        minExperienceYears: optInt(fields.minExperienceYears),
        maxExperienceYears: optInt(fields.maxExperienceYears),
        shift: fields.shift || undefined,
        neededBy: fields.neededBy || undefined,
        requirements,
        benefits,
        initial,
        ...(mode === "publish" ? { publish: selection } : {}),
      });
      if (res.ok) {
        router.push(`/postings/${postingId}`);
      } else {
        setError(res.error);
      }
    });
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

  const publishDisabled = pending || selection.matchSkillIds.length === 0;

  return (
    <div className="posting-layout">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit("save");
        }}
      >
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
          <Input label="Role title" value={fields.roleTitle} onChange={(e) => set("roleTitle", e.target.value)} required />
          <div className="form-grid">
            <Input label="Location note (optional)" value={fields.locationLabel} onChange={(e) => set("locationLabel", e.target.value)} />
            <Input label="Vacancies" type="number" min={1} value={fields.vacancies} onChange={(e) => set("vacancies", e.target.value)} required />
          </div>
          <div className="form-grid">
            <Input label="City" value={fields.city} onChange={(e) => set("city", e.target.value)} />
            <Input label="Area / locality (optional)" value={fields.area} onChange={(e) => set("area", e.target.value)} />
          </div>
        </div>

        <div className="form__section">
          <p className="form__legend">Pay and timing</p>
          <div className="form-grid">
            <Input label="Pay — min (₹ / month)" type="number" min={0} inputMode="numeric" value={fields.payMin} onChange={(e) => set("payMin", e.target.value)} />
            <Input label="Pay — max (₹ / month)" type="number" min={0} inputMode="numeric" value={fields.payMax} onChange={(e) => set("payMax", e.target.value)} />
          </div>
          <Select id="payType" label="Pay type" value={fields.payType} onChange={(e) => set("payType", e.target.value)}>
            <option value="">— pick the pay type —</option>
            {PAY_TYPES.map((p) => (
              <option key={p} value={p}>
                {payTypeLabel(p)}
              </option>
            ))}
          </Select>
          <div className="form-grid">
            <Input label="Experience — min (years)" type="number" min={0} inputMode="numeric" value={fields.minExperienceYears} onChange={(e) => set("minExperienceYears", e.target.value)} />
            <Input label="Experience — max (years)" type="number" min={0} inputMode="numeric" value={fields.maxExperienceYears} onChange={(e) => set("maxExperienceYears", e.target.value)} />
          </div>
          <div className="form-grid">
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
        </div>

        <div className="form__section">
          <p className="form__legend">Requirements and benefits</p>
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
        </div>

        <div className="form__section">
          <p className="form__legend">Description</p>
          <Textarea label="Description (optional — no phone/email)" value={fields.description} onChange={(e) => set("description", e.target.value)} rows={4} />
        </div>

        {isDraft && matchSkills.length > 0 ? (
          <MatchSkillPicker vocabulary={matchSkills} selection={selection} onChange={setSelection} onPreviewChange={setPreview} />
        ) : null}

        {gaps.length > 0 ? (
          <div className="alert alert--warning" role="status">
            <i className="ph-fill ph-warning alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__title">This card still has gaps</p>
              <p className="alert__body">
                Still to fill: {gaps.map((g) => g.title.toLowerCase()).join(", ")}.
                {isDraft ? " Publishing needs them filled." : " You can save now and finish later."}
              </p>
            </div>
          </div>
        ) : null}

        <div className="form-status">
          <div aria-live="polite">
            {error !== null ? (
              <div className="alert alert--danger">
                <i className="ph-fill ph-warning-circle alert__icon" aria-hidden="true" />
                <div className="alert__text">
                  <p className="alert__title">Your changes were not saved</p>
                  <p className="alert__body">{error}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="form-actions">
          {isDraft ? (
            <>
              <Button type="submit" variant="secondary" loading={pending} disabled={pending}>
                Save draft
              </Button>
              <Button
                type="button"
                loading={pending}
                disabled={publishDisabled}
                iconRight="rocket-launch"
                onClick={() => submit("publish")}
              >
                {preview?.zero_reach ? "Publish anyway — reaches nobody yet" : "Publish"}
              </Button>
            </>
          ) : (
            <Button type="submit" loading={pending} disabled={pending}>
              Save changes
            </Button>
          )}
        </div>
      </form>

      <aside className="posting-preview" aria-label="Live card preview">
        {isDraft ? <Badge tone="neutral" upper>draft</Badge> : null}
        <JobCardPreview fields={card()} />
      </aside>
    </div>
  );
}

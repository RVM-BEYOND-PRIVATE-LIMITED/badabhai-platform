"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
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
import {
  CARD_NUMBER_FIELDS,
  gapInputFromValues,
  liveCardFieldError,
  parseWholeNumber,
  readCardForm,
  withChipDraft,
  ALL_NUMBERS_REVEALED,
  numberPairOf,
  revealNumberPair,
  type CardNumberField,
  type CardNumberPair,
  type RevealedNumbers,
} from "../../../../lib/job-card-form";
import { focusControl, revealWholeControl } from "../../../../lib/form-focus";
import { companyPostingFacts } from "../../../../lib/posting-facts";
import { workerCardGap, type WorkerCardGap } from "../../../../lib/worker-card-gap";
import { bandForVacancies, baseApplicantQuotaForBand } from "../../../../lib/pricing-config";
import { Badge, Button, Input, Select, Textarea } from "../../../../components/ds";
import { ChipEditor } from "../../../../components/chip-editor";
import { PostingActions, PostingPreviewRail, zeroReachLabel } from "../../../../components/posting-preview-rail";
import { createPostingAction } from "./actions";
import { MatchSkillPicker, type MatchSelection } from "./match-skill-picker";

/**
 * New posting (EMPLOYER self-serve) — the posting form is the TRACEABLE SOURCE of every Job Card
 * field. The role leads (all 21 roles, grouped), then every card field, then the skill picker.
 * Beside it, the {@link PostingPreviewRail}: the worker's card built LIVE from the SAME
 * `readCardForm` values the submit sends, the facts the card does not show, and the publish
 * button — together on screen. NO mock data; the session payer is stamped server-side (XB-A) and
 * there is NO employer-name field. `createPostingInputSchema` (re-run in the action) stays the
 * AUTHORITY; the inline checks are UX parity. The workerCardGap rule is enforced on CREATE +
 * PUBLISH (owner ruling).
 */

const ROLE_GROUPS = roleOptionGroups();
const FORM_ID = "posting-form";

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

type FieldKey = "roleTitle" | "vacancies" | "description";
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


/** The openings box as a whole number ≥ 1, or null. */
function openingsOf(raw: string): number | null {
  const n = parseWholeNumber(raw);
  return n.kind === "ok" && n.value >= 1 ? n.value : null;
}

/** The non-card checks (the card numbers are `readCardForm`'s issues). UX parity with the schema. */
function validate(fields: FormFields): FieldErrors {
  const errs: FieldErrors = {};
  const role = fields.roleTitle.trim();
  if (role.length < 2 || role.length > 120) errs.roleTitle = "Role title must be 2–120 characters.";
  if (openingsOf(fields.vacancies) === null) {
    errs.vacancies = "Openings must be a whole number of 1 or more.";
  }
  const desc = fields.description.trim();
  if (desc.length > 0 && looksLikePii(desc)) {
    errs.description = "Remove contact details (phone/email) from the description.";
  }
  return errs;
}

export function PostingForm({
  quotaStep = null,
  matchSkills = [],
  lead,
}: {
  quotaStep?: number | null;
  matchSkills?: MatchSkillWire[];
  /** The page head + notices, drawn at the top of the form column (the rail starts beside it). */
  lead?: ReactNode;
} = {}) {
  const router = useRouter();
  // useState call order (mirrored positionally by posting-form.test.tsx): fields, fieldErrors,
  // error, navigating, selection, preview, requirements, benefits, reqDraft, benDraft, gap,
  // revealed. NEW state is APPENDED, never inserted, so the positional seeding keeps working.
  const [fields, setFields] = useState<FormFields>(BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [selection, setSelection] = useState<MatchSelection>({
    matchSkillIds: [],
    untickedRelatedIds: [],
  });
  const [preview, setPreview] = useState<ReachPreview | null>(null);
  const [requirements, setRequirements] = useState<string[]>([]);
  const [benefits, setBenefits] = useState<string[]>([]);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [gap, setGap] = useState<WorkerCardGap | null>(null);
  const [revealed, setRevealed] = useState<RevealedNumbers>({});
  const [pending, startTransition] = useTransition();

  // THE ONE READ — the preview, the inline errors, the gap rule and the submit all use it.
  const read = readCardForm(
    { ...fields, title: fields.roleTitle },
    { requirements, benefits, reqDraft, benDraft },
  );
  const hasCardIssue = Object.keys(read.issues).length > 0;
  const isValid =
    Object.keys(validate(fields)).length === 0 &&
    !hasCardIssue &&
    selection.matchSkillIds.length > 0;

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    const pair = numberPairOf(key);
    if (pair !== null) setRevealed((prev) => revealNumberPair(prev, pair, false));
    if (key in fieldErrors) setFieldErrors((p) => ({ ...p, [key]: undefined }));
    if (gap !== null && gap.field === key) setGap(null);
  }

  /** Leaving one end of a min/max pair shows that pair's order error (typing never flashes it). */
  function reveal(pair: CardNumberPair) {
    setRevealed((prev) => revealNumberPair(prev, pair, true));
  }

  const numberError = (key: CardNumberField) =>
    liveCardFieldError(read.issues, key, revealed[key] === true);

  /** The gap that refused the last publish, shown AT its control — where focus lands. */
  const gapError = (control: string) =>
    gap !== null && gap.field === control ? gap.message : undefined;
  /** A control's error: its own validation first, then the refused-publish gap. */
  const errorOf = (control: string, own?: string) => own ?? gapError(control);

  function addChip(kind: "req" | "ben") {
    if (gap !== null && gap.field === (kind === "req" ? "requirements" : "benefits")) setGap(null);
    if (kind === "req") {
      setRequirements((prev) => withChipDraft(prev, reqDraft).list);
      setReqDraft("");
    } else {
      setBenefits((prev) => withChipDraft(prev, benDraft).list);
      setBenDraft("");
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGap(null);

    // A chip still in its box is part of the posting (`read.values` already carries it) — show it
    // as added, so a refused publish does not leave it looking unsaved.
    setRequirements(read.values.requirements);
    setBenefits(read.values.benefits);
    setReqDraft("");
    setBenDraft("");

    const errs = validate(fields);
    setFieldErrors(errs);
    if (hasCardIssue) setRevealed(ALL_NUMBERS_REVEALED);
    const firstBad =
      (Object.keys(errs) as FieldKey[])[0] ?? CARD_NUMBER_FIELDS.find((f) => read.issues[f]);
    if (firstBad !== undefined) {
      focusControl(firstBad);
      return;
    }

    // GAP RULE — CREATE + PUBLISH only (owner ruling): every card row must be filled before a
    // posting goes live, or the worker's card has a hole. The API stays permissive; this blocks.
    const cardGap = workerCardGap(gapInputFromValues(read.values, fields.description));
    if (cardGap !== null) {
      setGap(cardGap);
      focusControl(cardGap.field);
      return;
    }

    const v = read.values;
    startTransition(async () => {
      const res = await createPostingAction({
        roleKind: v.roleKind ?? "",
        roleTitle: v.title,
        locationLabel: fields.locationLabel,
        description: fields.description,
        vacancies: openingsOf(fields.vacancies) ?? 0,
        city: v.city ?? "",
        area: v.area ?? "",
        payMin: v.payMin,
        payMax: v.payMax,
        payType: v.payType,
        minExperienceYears: v.minExperienceYears,
        maxExperienceYears: v.maxExperienceYears,
        shift: v.shift,
        neededBy: v.neededBy,
        requirements: v.requirements,
        benefits: v.benefits,
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

  const openings = openingsOf(fields.vacancies);
  const derivedBand = openings !== null ? bandForVacancies(openings) : null;
  const derivedQuota = derivedBand !== null ? baseApplicantQuotaForBand(derivedBand, quotaStep) : null;

  const busy = pending || navigating;
  const primary = (
    <Button
      type="submit"
      form={FORM_ID}
      className="posting-cta"
      iconRight={busy ? undefined : "rocket-launch"}
      disabled={submitDisabled}
      loading={busy}
    >
      {busy
        ? "Publishing…"
        : preview?.zero_reach
          ? zeroReachLabel
          : "Publish posting"}
    </Button>
  );
  // ONE status: the rail footer shows it on desktop, the dock below 1024px (the form's own end
  // repeats only the buttons) — so the reason always sits by the button the payer pressed.
  // The gap is NOT announced here: focus moves to its field, whose description reads it (once).
  const statusLine =
    gap !== null ? (
      <p className="posting-actions__msg posting-actions__msg--warning">
        <strong>{gap.title}.</strong> {gap.message}
      </p>
    ) : null;
  // The server's refusal has no field to focus — it is announced, from the live slot.
  const outcomeLine = error ? (
    <p className="posting-actions__msg posting-actions__msg--danger">{error}</p>
  ) : null;

  return (
    <div className="posting-layout posting-layout--editor">
      <div className="posting-layout__main">
        {lead}
        <form id={FORM_ID} className="form" onSubmit={onSubmit}>
          <div className="form__section">
            <p className="form__legend">The role</p>

            <Select
              id="roleKind"
              label="Role"
              value={fields.roleKind}
              error={errorOf("roleKind")}
              aria-invalid={errorOf("roleKind") ? true : undefined}
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
              hint="The heading of the worker's card."
              onChange={(e) => set("roleTitle", e.target.value)}
            />

            <Input
              id="locationLabel"
              label="Location note"
              optional
              placeholder="Pune, MH"
              value={fields.locationLabel}
              hint="Free text for your own note — the worker's card shows the area and city below, not this."
              onChange={(e) => set("locationLabel", e.target.value)}
            />

            <div className="form-grid">
              <Input
                id="city"
                label="City"
                placeholder="Pune"
                value={fields.city}
                error={errorOf("city")}
                aria-invalid={errorOf("city") ? true : undefined}
                hint="Shown on the worker's card as “Area, City”."
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
                label="Openings"
                inputMode="numeric"
                placeholder="5"
                value={fields.vacancies}
                error={fieldErrors.vacancies}
                aria-invalid={fieldErrors.vacancies ? true : undefined}
                hint="How many people you need. We store this as a coarse band, never the exact count. Not on the worker's card."
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
                error={errorOf("payMin", numberError("payMin"))}
                aria-invalid={errorOf("payMin", numberError("payMin")) ? true : undefined}
                onChange={(e) => set("payMin", e.target.value)}
                onBlur={() => reveal("pay")}
              />
              <Input
                id="payMax"
                label="Pay band — max (₹ / month)"
                inputMode="numeric"
                placeholder="35000"
                value={fields.payMax}
                error={errorOf("payMax", numberError("payMax"))}
                aria-invalid={errorOf("payMax", numberError("payMax")) ? true : undefined}
                onChange={(e) => set("payMax", e.target.value)}
                onBlur={() => reveal("pay")}
              />
            </div>

            <Select
              id="payType"
              label="Pay type"
              value={fields.payType}
              error={errorOf("payType")}
              aria-invalid={errorOf("payType") ? true : undefined}
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
                error={errorOf("minExperienceYears", numberError("minExperienceYears"))}
                aria-invalid={errorOf("minExperienceYears", numberError("minExperienceYears")) ? true : undefined}
                onChange={(e) => set("minExperienceYears", e.target.value)}
                onBlur={() => reveal("experience")}
              />
              <Input
                id="maxExperienceYears"
                label="Experience — max (years)"
                inputMode="numeric"
                placeholder="5"
                value={fields.maxExperienceYears}
                error={errorOf("maxExperienceYears", numberError("maxExperienceYears"))}
                aria-invalid={errorOf("maxExperienceYears", numberError("maxExperienceYears")) ? true : undefined}
                onChange={(e) => set("maxExperienceYears", e.target.value)}
                onBlur={() => reveal("experience")}
              />
            </div>

            <div className="form-grid">
              <Select
                id="shift"
                label="Shift"
                value={fields.shift}
                error={errorOf("shift")}
                aria-invalid={errorOf("shift") ? true : undefined}
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
                error={errorOf("neededBy")}
                aria-invalid={errorOf("neededBy") ? true : undefined}
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
              error={errorOf("requirements")}
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
              error={errorOf("benefits")}
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
              <Icon name="warning-circle" className="alert__icon" />
              <div className="alert__text">
                <p className="alert__title">Could not load the skill list</p>
                <p className="alert__body">
                  Reload the page — a posting needs at least one skill before workers can find it.
                </p>
              </div>
            </div>
          )}

          <div className="form__section">
            <p className="form__legend">Description</p>
            <Textarea
              id="description"
              label="Description"
              onFocus={revealWholeControl}
              placeholder="Shift timings, machines, location notes…"
              value={fields.description}
              error={errorOf("description", fieldErrors.description)}
              aria-invalid={errorOf("description", fieldErrors.description) ? true : undefined}
              hint="Workers read this when they open the job. Never include a phone number or email — share contact only after you unlock an applicant."
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="posting-layout__end">
            <PostingActions>{primary}</PostingActions>
          </div>
        </form>
      </div>

      <PostingPreviewRail
        fields={read.card}
        draft={read.draft}
        facts={companyPostingFacts({
          roleKind: read.values.roleKind ?? null,
          openings: fields.vacancies,
          locationNote: fields.locationLabel,
          matchSkills: { ids: selection.matchSkillIds, vocabulary: matchSkills },
          description: fields.description,
        })}
        actions={
          <PostingActions status={statusLine} outcome={outcomeLine}>
            {primary}
          </PostingActions>
        }
        primary={primary}
        status={statusLine}
        outcome={outcomeLine}
        busy={busy}
      />
    </div>
  );
}

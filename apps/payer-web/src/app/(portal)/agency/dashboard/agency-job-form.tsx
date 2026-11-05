"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { Icon } from "@badabhai/icons";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  TRADE_KEYS,
  type AgencyJob,
  type MatchSkillWire,
  type NeededBy,
} from "../../../../lib/contracts";
import { tradeLabel } from "../../../../lib/agency-view";
import { roleOptionGroups } from "../../../../lib/job-roles";
import { neededByLabel, payTypeLabel, shiftLabel } from "../../../../lib/job-card-view";
import {
  CARD_NUMBER_FIELDS,
  gapInputFromValues,
  liveCardFieldError,
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
import { formatInr } from "../../../../lib/format";
import { agencyPostingFacts } from "../../../../lib/posting-facts";
import {
  workerCardGap,
  workerCardGaps,
  type WorkerCardGap,
} from "../../../../lib/worker-card-gap";
import {
  BadaBhaiLogo,
  Button,
  Input,
  Select,
  Textarea,
  fieldFeedbackId,
} from "../../../../components/ds";
import { ChipEditor } from "../../../../components/chip-editor";
import { PostingActions, PostingPreviewRail } from "../../../../components/posting-preview-rail";
// The COMPANY form's picker, reused verbatim (#2104): one closed vocabulary, one cap, one set of
// chips. It lives beside the company form it was built for; nothing about it is company-specific
// but the untick affordance, which this form turns off (`relatedUnticks`).
import { MatchSkillPicker, type MatchSelection } from "../../postings/new/match-skill-picker";

/**
 * Shared CREATE/EDIT form for an agency posting (ADR-0022, LIVE) — an agency job traces to the
 * SAME Job Card as a company posting. It collects the role (one of the 21 — display), the trade
 * (its 15-trade classifier), the city/area, pay band + pay type, experience, shift, timing,
 * description and requirement/benefit chips, then the MATCH SKILLS, beside the
 * {@link PostingPreviewRail}: the worker's card built from the SAME `readCardForm` values the
 * submit sends.
 *
 * MATCH SKILLS (ADR-0050 §6.1 step 2, #2104). The skill half is the company form's own
 * {@link MatchSkillPicker} — one closed vocabulary, one cap, one set of chips — and it is what
 * decides who sees this vacancy: `jobs.match_skill_ids` is copied to the system-owned V1 twin,
 * and a trade is NEVER read for matching (ADR-0050 C4). Required by this form (Q9) although
 * optional at the API, through the same disable-until-valid + inline-error path as the title and
 * city: an agency job with no pick gets a `paused` twin and reaches nobody. Unticks are NOT
 * offered — the twin's reach is `match ∪ related(match)` with no unticks (Q2) — so the related
 * chips are shown locked and `untickedRelatedIds` is never sent (there is no field for it).
 * On EDIT the pick is sent ONLY when it changed, because an omitted `match_skill_ids` means
 * unchanged.
 *
 * The workerCardGap rule fires on CREATE (an agency job goes live immediately — create == publish),
 * blocking a thin card. On EDIT of a live job the gaps are HIGHLIGHTED, never blocked (owner ruling).
 * NO company-name field, NO worker field (faceless/coarse); the session payer is stamped server-side.
 *
 * Two hosts, each on its own page: New posting (`/agency/jobs/new`) and Edit posting
 * (`/agency/jobs/<id>/edit`). Each passes its page head as `lead` and LEAVES the page when the save
 * succeeds — so a saved form stays busy until it is gone (no second save of the same values).
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
  /**
   * ADR-0050 §6.1 step 2 — the match pick. ABSENT means "unchanged": the form omits it on an
   * EDIT whose pick the payer did not touch, and the seam then omits `match_skill_ids`. Always
   * present on a CREATE (the form requires a pick, Q9).
   */
  matchSkillIds?: string[];
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

/**
 * The non-card controls this form validates ITSELF. `matchSkillIds` is the picker's GROUP, not a
 * DS field: it refuses through the same two steps (disable-until-valid, then its message at the
 * control with focus) because it is required exactly as hard (#2104 / ADR-0050 Q9).
 */
type FieldKey =
  | "roleKind"
  | "title"
  | "city"
  | "payMin"
  | "payMax"
  | "payType"
  | "minExperienceYears"
  | "maxExperienceYears"
  | "shift"
  | "neededBy"
  | "matchSkillIds";
type FieldErrors = Partial<Record<FieldKey, string>>;

/**
 * DOM ids that differ from their field's name. The invite panel has its own `#city`, and the agency
 * dashboard once drew this form beside it: two `#city`s gave the job form's label, its description
 * and a refused create's focus to the wrong box. The id stays distinct so the two can never collide
 * again. Focus (`controlId`) goes by these ids.
 */
const CONTROL_ID: Readonly<Partial<Record<string, string>>> = { city: "job-city" };
const controlId = (field: string): string => CONTROL_ID[field] ?? field;

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

/**
 * The non-card checks (the card numbers are `readCardForm`'s issues). UX parity with the schema,
 * plus the one rule the schema deliberately does NOT carry: a match pick is required by the FORM
 * (ADR-0050 Q9) while it stays optional at the API, because an edit that did not touch the pick
 * omits it legitimately.
 */
function validate(fields: FormFields, matchSkillIds: readonly string[]): FieldErrors {
  const errs: FieldErrors = {};
  if (fields.title.trim().length < 1) errs.title = "Enter a role title.";
  if (fields.city.trim().length < 1) errs.city = "Enter a city.";
  // No pick ⇒ the V1 twin of this job is `paused` and the vacancy reaches nobody (ADR-0050 §3
  // status rule 5). Say that, rather than "required".
  if (matchSkillIds.length < 1) {
    errs.matchSkillIds = "Pick at least one skill — without one, no worker can see this posting.";
  }
  return errs;
}

/**
 * ORDER-FREE equality for a match pick (ADR-0050): a pick is a SET, so the same ids in another
 * order are the same pick and an edit must not re-send them. Mirrors the API's own `sameSkillSet`
 * (agency.service.ts), which is what decides whether a patch changes the row and emits
 * `match_skills`. De-duplicated on both sides for the same reason it is there: so the comparison
 * is of the SETS, not of two lists that happen to be the same length.
 */
function sameMatchPick(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

export function AgencyJobForm({
  mode,
  job,
  matchSkills = [],
  onSubmit,
  onCancel,
  submitLabel,
  lead,
  payerRef = "—",
}: {
  mode: "create" | "edit";
  job?: AgencyJob;
  /**
   * The closed match vocabulary, read SERVER-side by the host page (`listMatchSkills()`) so the
   * session Bearer never reaches the browser. `[]` is the page's signal that the read FAILED —
   * the form then says so and keeps the submit refused, rather than saving a vacancy no worker
   * can see. Same rule, same copy as the company posting form (#2104).
   */
  matchSkills?: MatchSkillWire[];
  onSubmit: (input: AgencyJobInputValues) => Promise<AgencyJobFormSubmitResult>;
  onCancel?: () => void;
  submitLabel: string;
  /**
   * What heads the form column — the page's own header on New posting and Edit posting — so the
   * preview rail starts level with the top of the page's content, not below the header.
   */
  lead?: ReactNode;
  /** A short, non-PII payer reference for the designer preview card. */
  payerRef?: string;
}) {
  // useState call order (mirrored POSITIONALLY by agency-job-form.test.tsx): fields, fieldErrors,
  // error, requirements, benefits, reqDraft, benDraft, gap, revealed, navigating, selection.
  // APPEND new state only.
  const [fields, setFields] = useState<FormFields>(job ? fromJob(job) : BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<string[]>(job?.requirements ?? []);
  const [benefits, setBenefits] = useState<string[]>(job?.benefits ?? []);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [gap, setGap] = useState<WorkerCardGap | null>(null);
  const [revealed, setRevealed] = useState<RevealedNumbers>({});
  // Set once a save SUCCEEDED: the host is navigating away, so the form stays busy until it unmounts.
  const [navigating, setNavigating] = useState(false);
  // ADR-0050 §6.1 step 2 — the match pick, prefilled on EDIT from the stored `match_skill_ids`
  // (absent / `[]` on a job created before the picker ⇒ nothing picked, which the form then
  // requires). `untickedRelatedIds` stays `[]` for its whole life: an agency twin has no unticks
  // (Q2), so the picker is drawn with none offered and none is ever sent.
  const [selection, setSelection] = useState<MatchSelection>({
    matchSkillIds: job?.matchSkillIds ?? [],
    untickedRelatedIds: [],
  });
  // APPENDED — preserves every earlier positional useState index (agency-job-form.test.tsx).
  const [step, setStep] = useState(1);
  const [pending, startTransition] = useTransition();
  const busy = pending || navigating;

  // One form per page; the id names the job regardless — the rail's buttons submit it through the
  // `form` attribute.
  const formId = `agency-job-form-${job?.id ?? "new"}`;

  // THE ONE READ — the preview, the inline errors, the gap rule and the submit all use it.
  const read = readCardForm(fields, { requirements, benefits, reqDraft, benDraft });
  const hasCardIssue = Object.keys(read.issues).length > 0;
  const isValid =
    Object.keys(validate(fields, selection.matchSkillIds)).length === 0 && !hasCardIssue;

  /** A pick clears its refusal the moment one is made — as typing clears a field's (`set`). */
  function pick(next: MatchSelection) {
    setSelection(next);
    if (next.matchSkillIds.length > 0 && fieldErrors.matchSkillIds !== undefined) {
      setFieldErrors((p) => ({ ...p, matchSkillIds: undefined }));
    }
  }

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

  /** A control's error: its own validation first, then the refused-create gap — where focus lands. */
  const errorOf = (control: string, own?: string) =>
    own ?? (gap !== null && gap.field === control ? gap.message : undefined);

  /**
   * STEP GATE — the same fields the create path already insists on (the worker-card gap),
   * applied one card at a time. The server remains the authority; this is UX parity with the
   * company posting wizard.
   */
  function validateStep(which: 1 | 2): FieldErrors {
    const errs: FieldErrors = {};
    if (which === 1) {
      if (fields.roleKind.trim() === "") errs.roleKind = "Pick the role from the list.";
      if (fields.title.trim().length < 1) errs.title = "Enter a role title.";
      if (fields.city.trim().length < 1) errs.city = "Enter a city.";
      return errs;
    }
    if (fields.payMin.trim() === "") errs.payMin = "Add the minimum pay.";
    else {
      const issue = liveCardFieldError(read.issues, "payMin", true);
      if (issue !== undefined) errs.payMin = issue;
    }
    if (fields.payMax.trim() === "") errs.payMax = "Add the maximum pay.";
    else {
      const issue = liveCardFieldError(read.issues, "payMax", true);
      if (issue !== undefined) errs.payMax = issue;
    }
    if (fields.payType.trim() === "") errs.payType = "Pick the pay type.";
    if (fields.minExperienceYears.trim() === "") {
      errs.minExperienceYears = "Add the minimum experience.";
    } else {
      const issue = liveCardFieldError(read.issues, "minExperienceYears", true);
      if (issue !== undefined) errs.minExperienceYears = issue;
    }
    if (fields.maxExperienceYears.trim() === "") {
      errs.maxExperienceYears = "Add the maximum experience.";
    } else {
      const issue = liveCardFieldError(read.issues, "maxExperienceYears", true);
      if (issue !== undefined) errs.maxExperienceYears = issue;
    }
    if (fields.shift.trim() === "") errs.shift = "Pick the shift.";
    if (fields.neededBy.trim() === "") errs.neededBy = "Pick needed by.";
    return errs;
  }

  /** Advance only when the CURRENT card is complete; focus the first missing control. */
  function goNext() {
    if (step === 1) {
      const errs = validateStep(1);
      setFieldErrors((prev) => ({ ...prev, ...errs }));
      const first = (Object.keys(errs) as FieldKey[])[0];
      if (first !== undefined) {
        focusControl(controlId(first));
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setRevealed(ALL_NUMBERS_REVEALED);
      const errs = validateStep(2);
      setFieldErrors((prev) => ({ ...prev, ...errs }));
      const first = (Object.keys(errs) as FieldKey[])[0];
      if (first !== undefined) {
        focusControl(controlId(first));
        return;
      }
      setStep(3);
    }
  }

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

  /** EDIT highlights every gap still open (never blocking — owner ruling); CREATE blocks below. */
  const editGaps =
    mode === "edit" ? workerCardGaps(gapInputFromValues(read.values, fields.description)) : [];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGap(null);

    // A chip still in its box is part of the posting (`read.values` carries it) — show it added.
    setRequirements(read.values.requirements);
    setBenefits(read.values.benefits);
    setReqDraft("");
    setBenDraft("");

    const errs = validate(fields, selection.matchSkillIds);
    setFieldErrors(errs);
    if (hasCardIssue) setRevealed(ALL_NUMBERS_REVEALED);
    const firstBad =
      (Object.keys(errs) as FieldKey[])[0] ?? CARD_NUMBER_FIELDS.find((f) => read.issues[f]);
    if (firstBad !== undefined) {
      focusControl(controlId(firstBad));
      return;
    }

    // GAP RULE on CREATE (an agency job goes live immediately — create == publish). On EDIT the
    // gaps are only highlighted, never blocking (owner ruling).
    if (mode === "create") {
      const cardGap = workerCardGap(gapInputFromValues(read.values, fields.description));
      if (cardGap !== null) {
        setGap(cardGap);
        focusControl(controlId(cardGap.field));
        return;
      }
    }

    const v = read.values;
    // ADR-0050 §6.1 step 2 — a CREATE always carries the pick; an EDIT carries it only when it
    // CHANGED, because an omitted `match_skill_ids` means unchanged. Order-free (`sameMatchPick`),
    // so re-ticking the same skills in another order is not a change: the twin is not re-synced
    // and `job.updated` does not claim a `match_skills` edit that did not happen.
    const pickUnchanged =
      mode === "edit" && sameMatchPick(selection.matchSkillIds, job?.matchSkillIds ?? []);
    startTransition(async () => {
      const res = await onSubmit({
        tradeKey: fields.tradeKey,
        roleKind: v.roleKind ?? "",
        title: v.title,
        city: v.city ?? "",
        area: v.area,
        payMin: v.payMin,
        payMax: v.payMax,
        payType: v.payType,
        minExperienceYears: v.minExperienceYears,
        maxExperienceYears: v.maxExperienceYears,
        shift: v.shift,
        neededBy: v.neededBy as NeededBy | undefined,
        description: fields.description.trim() || undefined,
        requirements: v.requirements,
        benefits: v.benefits,
        ...(pickUnchanged ? {} : { matchSkillIds: selection.matchSkillIds }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // The host leaves the page (create → the new posting, edit → its details). The values stay
      // as saved — the card does not blank under the payer — and nothing can be saved twice.
      setNavigating(true);
    });
  }

  const primary = (
    <Button type="submit" form={formId} disabled={busy || !isValid} loading={busy}>
      {busy ? "Saving…" : submitLabel}
    </Button>
  );
  // ONE status: the rail footer on desktop, the dock below 1024px (the form's end repeats only
  // the buttons) — the reason a create was refused sits by the button the payer pressed. The gap
  // is NOT announced here: focus moves to its field, whose description reads it (once).
  const statusLine = (
    <>
      {gap !== null ? (
        <p className="posting-actions__msg posting-actions__msg--warning">
          <strong>{gap.title}.</strong> {gap.message}
        </p>
      ) : null}
      {editGaps.length > 0 ? (
        <p className="posting-actions__msg posting-actions__msg--warning" role="status">
          <strong>Still to fill:</strong> {editGaps.map((g) => g.title.toLowerCase()).join(", ")}.
          {" You can save now and finish later."}
        </p>
      ) : null}
    </>
  );
  // The server's refusal has no field to focus — it is announced, from the live slot.
  const outcomeLine = error ? (
    <p className="posting-actions__msg posting-actions__msg--danger">{error}</p>
  ) : null;
  const buttons = (
    <>
      {primary}
      {onCancel ? (
        <Button variant="secondary" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </>
  );

  const STEP_TITLES = ["Role & Worksite", "Pay & Experience", "Skills & Perks"];
  const roleLabel =
    ROLE_GROUPS.flatMap((g) => g.options).find((o) => o.value === fields.roleKind)?.label ??
    (fields.title.trim() !== "" ? fields.title : "Your role title");
  const selectedSkillLabels = matchSkills
    .filter((s) => selection.matchSkillIds.includes(s.skill_id))
    .map((s) => s.label)
    .slice(0, 4);
  const locationText = [fields.area.trim(), fields.city.trim()].filter(Boolean).join(", ");
  const payText =
    read.values.payMin !== undefined && read.values.payMax !== undefined
      ? `${formatInr(read.values.payMin)} – ${formatInr(read.values.payMax)}`
      : "Not set";
  const expText =
    read.values.minExperienceYears !== undefined || read.values.maxExperienceYears !== undefined
      ? `${read.values.minExperienceYears ?? 0} – ${read.values.maxExperienceYears ?? 0} Years`
      : "Not set";

  return (
    <div className="mw-layout">
      <div className="mw-main">
        {lead}
        <form id={formId} className="form mw-form" onSubmit={handleSubmit}>
          <ol className="mw-stepper" aria-label="Posting steps">
            {STEP_TITLES.map((title, i) => {
              const n = i + 1;
              const state = step === n ? "active" : step > n ? "done" : "todo";
              return (
                <li className={`mw-step mw-step--${state}`} key={title}>
                  <span className="mw-step__dot">
                    {state === "done" ? <Icon name="check" /> : n}
                  </span>
                  <span className="mw-step__text">
                    <span className="mw-step__eyebrow">STEP {n} OF 3</span>
                    <span className="mw-step__title">{title}</span>
                  </span>
                  {i < STEP_TITLES.length - 1 ? (
                    <span className="mw-step__line" aria-hidden="true" />
                  ) : null}
                </li>
              );
            })}
          </ol>

          <section className="mw-card" hidden={step !== 1}>
            <div className="mw-card__head">
              <div>
                <h2 className="mw-card__title">Step 1: Role &amp; Worksite Details</h2>
                <p className="mw-card__sub">
                  Specify the technical trade and the place the work happens.
                </p>
              </div>
              <span className="mw-pill mw-pill--warm">In Progress</span>
            </div>
            <div className="mw-card__body">
              <Select
                id="roleKind"
                label="Role Category"
                value={fields.roleKind}
                error={errorOf("roleKind")}
                aria-invalid={errorOf("roleKind") ? true : undefined}
                hint="Files the posting under the right role; workers still see your title."
                onChange={(e) => set("roleKind", e.target.value)}
              >
                <option value="">— pick the role category —</option>
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

              <Select
                id="tradeKey"
                label="Trade (matching)"
                value={fields.tradeKey}
                onChange={(e) => set("tradeKey", e.target.value)}
              >
                {TRADE_KEYS.map((t) => (
                  <option key={t} value={t}>
                    {tradeLabel(t)}
                  </option>
                ))}
              </Select>

              <Input
                id="title"
                label="Role Title"
                placeholder="CNC Operator — Night Shift"
                value={fields.title}
                error={fieldErrors.title}
                aria-invalid={fieldErrors.title ? true : undefined}
                hint="The heading of the worker's card — a generic role title, never a company name or contact details."
                onChange={(e) => set("title", e.target.value)}
              />

              <div className="mw-grid2">
                <Input
                  id={controlId("city")}
                  label="City"
                  placeholder="Pune"
                  value={fields.city}
                  error={errorOf("city", fieldErrors.city)}
                  aria-invalid={errorOf("city", fieldErrors.city) ? true : undefined}
                  onChange={(e) => set("city", e.target.value)}
                />
                <Input
                  id="area"
                  label="Area / Locality"
                  optional
                  placeholder="Pimpri-Chinchwad"
                  value={fields.area}
                  onChange={(e) => set("area", e.target.value)}
                />
              </div>
            </div>
            <div className="mw-card__foot">
              {onCancel ? (
                <Button variant="secondary" type="button" disabled={busy} onClick={onCancel}>
                  Cancel
                </Button>
              ) : (
                <span />
              )}
              <button
                type="button"
                className="bb-btn bb-btn--primary bb-btn--sm"
                onClick={goNext}
              >
                Next: Pay &amp; Experience <Icon name="arrow-right" />
              </button>
            </div>
          </section>

          <section className="mw-card" hidden={step !== 2}>
            <div className="mw-card__head">
              <div>
                <h2 className="mw-card__title">Step 2: Pay &amp; Experience</h2>
                <p className="mw-card__sub">
                  Set the pay band, experience window, shift and joining time.
                </p>
              </div>
              <span className="mw-pill">In Progress</span>
            </div>
            <div className="mw-card__body">
              <div className="mw-grid2">
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
                onChange={(e) => set("payType", e.target.value)}
              >
                <option value="">— pick the pay type —</option>
                {PAY_TYPES.map((p) => (
                  <option key={p} value={p}>
                    {payTypeLabel(p)}
                  </option>
                ))}
              </Select>

              <div className="mw-grid2">
                <Input
                  id="minExperienceYears"
                  label="Experience — min (years)"
                  inputMode="numeric"
                  placeholder="1"
                  value={fields.minExperienceYears}
                  error={errorOf("minExperienceYears", numberError("minExperienceYears"))}
                  aria-invalid={
                    errorOf("minExperienceYears", numberError("minExperienceYears"))
                      ? true
                      : undefined
                  }
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
                  aria-invalid={
                    errorOf("maxExperienceYears", numberError("maxExperienceYears"))
                      ? true
                      : undefined
                  }
                  onChange={(e) => set("maxExperienceYears", e.target.value)}
                  onBlur={() => reveal("experience")}
                />
              </div>

              <div className="mw-grid2">
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
            <div className="mw-card__foot">
              <button
                type="button"
                className="bb-btn bb-btn--secondary bb-btn--sm"
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button
                type="button"
                className="bb-btn bb-btn--primary bb-btn--sm"
                onClick={goNext}
              >
                Next: Skills &amp; Perks <Icon name="arrow-right" />
              </button>
            </div>
          </section>

          <section className="mw-card" hidden={step !== 3}>
            <div className="mw-card__head">
              <div>
                <h2 className="mw-card__title">Step 3: Skills &amp; Perks</h2>
                <p className="mw-card__sub">
                  Pick the skills workers search by, then add the detail and perks.
                </p>
              </div>
              <span className="mw-pill">In Progress</span>
            </div>
            <div className="mw-card__body">
              <Textarea
                id="description"
                label="Description"
                value={fields.description}
                rows={3}
                onFocus={revealWholeControl}
                error={errorOf("description")}
                aria-invalid={errorOf("description") ? true : undefined}
                hint="What the work is — workers read it when they open the posting. Never a phone/email or a company name."
                onChange={(e) => set("description", e.target.value)}
              />

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
                  onRemove={(i) => setRequirements((p) => p.filter((_, j) => j !== i))}
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
                  onRemove={(i) => setBenefits((p) => p.filter((_, j) => j !== i))}
                />
              </div>

              <div
                id={controlId("matchSkillIds")}
                className="agency-job-form__match"
                tabIndex={-1}
                aria-describedby={
                  fieldErrors.matchSkillIds
                    ? fieldFeedbackId(controlId("matchSkillIds"))
                    : undefined
                }
              >
                {matchSkills.length > 0 ? (
                  <MatchSkillPicker
                    vocabulary={matchSkills}
                    selection={selection}
                    onChange={pick}
                    relatedUnticks={false}
                  />
                ) : (
                  <div className="alert alert--danger">
                    <Icon name="warning-circle" className="alert__icon" />
                    <div className="alert__text">
                      <p className="alert__title">Could not load the skill list</p>
                      <p className="alert__body">
                        Reload the page — a posting needs at least one skill before workers can
                        find it.
                      </p>
                    </div>
                  </div>
                )}
                {fieldErrors.matchSkillIds ? (
                  <span
                    id={fieldFeedbackId(controlId("matchSkillIds"))}
                    className="bb-field__error"
                  >
                    <Icon name="warning-circle" />
                    {fieldErrors.matchSkillIds}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="mw-card__foot">
              <button
                type="button"
                className="bb-btn bb-btn--secondary bb-btn--sm"
                onClick={() => setStep(2)}
              >
                Back
              </button>
              <span className="mw-card__foothint">Publish from the panel on the right →</span>
            </div>
          </section>
        </form>
      </div>

      <aside className="mw-rail" aria-label="Posting preview and publishing">
        <div className="mw-railcards">
          <div className="mw-mini mw-mini--green">
            <span className="mw-mini__icon">
              <Icon name="rocket-launch" />
            </span>
            <div className="mw-mini__body">
              <p className="mw-mini__title">100% Free Through Launch</p>
              <p className="mw-mini__meta">₹0 cost</p>
              <p className="mw-mini__sub">
                Publish unlimited agency roles during this beta testing window.
              </p>
            </div>
          </div>
          <div className="mw-mini">
            <span className="mw-mini__icon mw-mini__icon--green">
              <Icon name="check" />
            </span>
            <div className="mw-mini__body">
              <p className="mw-mini__title">0 Credits billed today</p>
              <p className="mw-mini__sub">No credits deducted during beta. Publish for free.</p>
            </div>
          </div>
        </div>

        <div className="mw-preview">
          <div className="mw-preview__head">
            <span className="mw-dot" aria-hidden="true" />
            <span>LIVE WORKER CARD PREVIEW</span>
            <span className="mw-preview__hint">Updates live as you type</span>
          </div>
          <div className="mw-worker">
            <div className="mw-worker__top">
              <div className="mw-worker__brand">
                <BadaBhaiLogo theme="ink" size={26} />
                <span className="mw-worker__verified">VERIFIED</span>
              </div>
              <Icon name="buildings" className="mw-worker__ghost" />
            </div>
            <p className="mw-worker__payer">Payer ID: {payerRef}</p>
            <div className="mw-worker__titlerow">
              <h3 className="mw-worker__title">{roleLabel}</h3>
            </div>
            <p className="mw-worker__place">
              <Icon name="map-pin" />
              <span>{locationText !== "" ? locationText : "Area, City"}</span>
            </p>
            <div className="mw-worker__stats">
              <div>
                <span className="mw-worker__label">MONTHLY TAKE-HOME</span>
                <strong>{payText}</strong>
              </div>
              <div>
                <span className="mw-worker__label">EXPERIENCE</span>
                <strong>{expText}</strong>
              </div>
            </div>
            <p className="mw-worker__label">REQUIRED SKILLS</p>
            <div className="mw-worker__chips">
              {(selectedSkillLabels.length > 0 ? selectedSkillLabels : ["Pick a skill"]).map(
                (label) => (
                  <span className="mw-chip" key={`skill:${label}`}>
                    {label}
                  </span>
                ),
              )}
              {requirements.map((label) => (
                <span className="mw-chip" key={`req:${label}`}>
                  {label}
                </span>
              ))}
            </div>
            <div className="mw-worker__foot">
              <span>{fields.shift !== "" ? shiftLabel(fields.shift) : "Shift"}</span>
              <span>{benefits.length > 0 ? benefits.join(" + ") : "Benefits"}</span>
            </div>
          </div>
        </div>

        <div className="mw-audit">
          <div className="mw-audit__head">
            <h3 className="mw-audit__title">Internal Audit Summary</h3>
            <span className="mw-audit__pill">Recruiter view</span>
          </div>
          <dl className="mw-audit__list">
            <div className="mw-audit__row">
              <dt>Role Code</dt>
              <dd>{fields.roleKind !== "" ? fields.roleKind : "—"}</dd>
            </div>
            <div className="mw-audit__row">
              <dt>Trade</dt>
              <dd>{tradeLabel(fields.tradeKey)}</dd>
            </div>
            <div className="mw-audit__row">
              <dt>Location</dt>
              <dd>{locationText !== "" ? locationText : "—"}</dd>
            </div>
            <div className="mw-audit__row">
              <dt>Urgency</dt>
              <dd>{fields.neededBy !== "" ? neededByLabel(fields.neededBy) : "—"}</dd>
            </div>
          </dl>
          <p className="mw-audit__note">
            Workers read detailed technical specs inside full job view.
          </p>
        </div>

        <div className="mw-rail__actions">
          <PostingActions status={statusLine} outcome={outcomeLine}>
            {primary}
          </PostingActions>
        </div>

        <p className="mw-rail__foot">
          <span>
            <Icon name="check-circle" /> Instant Activation
          </span>
          <span>
            <Icon name="check-circle" /> 0 credits billed today
          </span>
        </p>
      </aside>

      <PostingPreviewRail
        hidden
        fields={read.card}
        draft={read.draft}
        facts={agencyPostingFacts({
          roleKind: read.values.roleKind ?? null,
          tradeKey: fields.tradeKey,
          description: fields.description,
        })}
        actions={<PostingActions>{buttons}</PostingActions>}
        primary={primary}
        status={statusLine}
        outcome={outcomeLine}
        busy={busy}
      />
    </div>
  );
}

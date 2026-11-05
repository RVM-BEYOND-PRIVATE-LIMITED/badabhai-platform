"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { Icon } from "@badabhai/icons";
import { looksLikePii } from "@badabhai/validators";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  type MatchSkillWire,
  type PostingTradeFormWire,
  type ReachPreview,
} from "../../../../lib/contracts";
import {
  POSTING_TRADE_REQUIRED_MESSAGE,
  isPostingTrade,
  withTradeRequired,
  type PostingTradesProblem,
} from "../../../../lib/posting-trades";
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
import {
  focusControl,
  focusControlOnNextFrame,
  focusStepHeading,
  revealWholeControl,
} from "../../../../lib/form-focus";
import { postingDraftKey } from "../../../../lib/posting-draft";
import { usePostingDraft } from "../../../../components/use-posting-draft";
import { DraftRestoredNotice } from "../../../../components/draft-restored-notice";
import { companyPostingFacts } from "../../../../lib/posting-facts";
import { workerCardGap, type WorkerCardGap } from "../../../../lib/worker-card-gap";
import { bandForVacancies, baseApplicantQuotaForBand } from "../../../../lib/pricing-config";
import { Badge, Button, Input, Select, Textarea } from "../../../../components/ds";
import { JobCardPreview } from "../../../../components/job-card-preview";
import { ChipEditor } from "../../../../components/chip-editor";
import {
  PostingActions,
  PostingPreviewRail,
  zeroReachLabel,
} from "../../../../components/posting-preview-rail";
import { createPostingAction } from "./actions";
import { withPublishedReach } from "../../../../lib/published-reach";
import { usePortalNavigation } from "../../../../components/portal-navigation";
import type { MatchSelection } from "./match-skill-picker";
import { TradePostingFields, derivedMatchSkills, type TradeFormValue } from "../trade-fields";
import { PostingTradePicker } from "../trade-picker";

/**
 * New posting (EMPLOYER self-serve) — the posting form is the TRACEABLE SOURCE of every Job Card
 * field. The role leads — REQUIRED, one of the 16 trades the API serves (#2645: a company job
 * matches only within them, #2635) — then every card field, then the trade's own fields, from
 * which the server derives the match skills. There is no free role list, no flat skill picker:
 * when the 16 trades did not load, the picker says why with a Retry and posting is refused.
 * Beside it, the {@link PostingPreviewRail}: the worker's card built LIVE from the SAME
 * `readCardForm` values the submit sends, the facts the card does not show, and the publish
 * button — together on screen. NO mock data; the session payer is stamped server-side (XB-A) and
 * there is NO employer-name field. `createPostingInputSchema` (re-run in the action) stays the
 * AUTHORITY; the inline checks are UX parity. The workerCardGap rule is enforced on CREATE +
 * PUBLISH (owner ruling).
 */

const FORM_ID = "posting-form";
const BLANK_TRADE: TradeFormValue = { tradeLevel: "", answers: {} };
/** A new posting starts from nothing — the base its local draft is checked against. */
const DRAFT_BASE = "new";
/** The heading a step change moves focus to (W4). */
const stepHeadingId = (n: number) => `posting-step-${n}-title`;

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

// Every control that can receive a server-side field error (#1912) as well as the client checks.
type FieldKey =
  | "roleTitle"
  | "roleKind"
  | "locationLabel"
  | "vacancies"
  | "city"
  | "area"
  | "payMin"
  | "payMax"
  | "payType"
  | "minExperienceYears"
  | "maxExperienceYears"
  | "shift"
  | "neededBy"
  | "requirements"
  | "benefits"
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

/** What the new-posting draft keeps on this device (W4). */
interface NewPostingDraft {
  fields: FormFields;
  requirements: string[];
  benefits: string[];
  reqDraft: string;
  benDraft: string;
  selection: MatchSelection;
  trade: TradeFormValue & { matchSkillIds: string[] };
}

/**
 * True once the payer has entered anything — the form then differs from a blank one. Not the old
 * flat pick (`selection`): no control sets it since #2645 and it is never sent, so a pick restored
 * from an older draft is no change to lose.
 */
export function isNewPostingDirty(d: NewPostingDraft): boolean {
  return (
    Object.values(d.fields).some((v) => v.trim() !== "") ||
    d.requirements.length > 0 ||
    d.benefits.length > 0 ||
    d.reqDraft.trim() !== "" ||
    d.benDraft.trim() !== "" ||
    d.trade.tradeLevel !== "" ||
    Object.keys(d.trade.answers).length > 0
  );
}

/**
 * A draft kept on this device as the form restores it (W4): what `onRestore` applies, and what
 * `isDirty` judges before restoring. A part an older draft lacks starts blank.
 */
function restoredNewPostingDraft(saved: Partial<NewPostingDraft>): NewPostingDraft {
  return {
    fields: { ...BLANK, ...saved.fields },
    requirements: saved.requirements ?? [],
    benefits: saved.benefits ?? [],
    reqDraft: saved.reqDraft ?? "",
    benDraft: saved.benDraft ?? "",
    selection: saved.selection ?? { matchSkillIds: [], untickedRelatedIds: [] },
    trade: saved.trade ?? { ...BLANK_TRADE, matchSkillIds: [] },
  };
}

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
  payerId,
  quotaStep = null,
  matchSkills = [],
  postingTrades = [],
  postingTradesProblem = null,
  lead,
  free = true,
}: {
  /** The signed-in payer (the session's opaque id) — the local draft is kept per payer (W4). */
  payerId: string;
  quotaStep?: number | null;
  /** The match vocabulary — labels only here; the trade decides the match set (#2635). */
  matchSkills?: MatchSkillWire[];
  /** The 16-trade posting catalogue (migration 0141) — the ONLY roles a company job can name. */
  postingTrades?: PostingTradeFormWire[];
  /** Why `postingTrades` is empty (#2645) — said at the picker, with a Retry. */
  postingTradesProblem?: PostingTradesProblem | null;
  /** The page head + notices, drawn at the top of the form column (the rail starts beside it). */
  lead?: ReactNode;
  /** The "free through launch" notice (sourced from the page's config flag). */
  free?: boolean;
}) {
  // useState call order (mirrored positionally by posting-form.test.tsx): fields, fieldErrors,
  // error, navigating, selection, preview, requirements, benefits, reqDraft, benDraft, gap,
  // revealed. NEW state is APPENDED, never inserted, so the positional seeding keeps working.
  const [fields, setFields] = useState<FormFields>(BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  // No flat skill picker since #2645 (the trade owns the match set); kept for the positional
  // state order and the stored draft's shape (W4).
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
  // APPENDED — keeps every earlier positional useState index intact (posting-form.test.tsx).
  const [step, setStep] = useState(1);
  // Appended after the seeded prefix: the trade-specific form's rung + answers.
  const [trade, setTrade] = useState<TradeFormValue & { matchSkillIds: string[] }>({
    ...BLANK_TRADE,
    matchSkillIds: [],
  });
  const [pending, startTransition] = useTransition();
  // The publish lands on the new posting's Applicants with the shell's "Opening Applicants…" cue
  // (the button stays "Publishing…" — `navigating` — until the page is gone).
  const { navigate } = usePortalNavigation();

  // W4 — the half-filled posting is kept on this device and leaving it asks first.
  const draftPayload: NewPostingDraft = {
    fields,
    requirements,
    benefits,
    reqDraft,
    benDraft,
    selection,
    trade,
  };
  const draft = usePostingDraft<NewPostingDraft>({
    storageKey: postingDraftKey({ kind: "new", payerId }),
    base: DRAFT_BASE,
    payload: draftPayload,
    dirty: isNewPostingDirty(draftPayload),
    // #2645 — a draft whose one change is the old flat pick restores as a blank form: dropped.
    isDirty: (saved) => isNewPostingDirty(restoredNewPostingDraft(saved)),
    off: navigating,
    onRestore: (saved) => {
      const restored = restoredNewPostingDraft(saved);
      setFields(restored.fields);
      setRequirements(restored.requirements);
      setBenefits(restored.benefits);
      setReqDraft(restored.reqDraft);
      setBenDraft(restored.benDraft);
      setSelection(restored.selection);
      setTrade(restored.trade);
    },
  });

  /** Show step `n` and land on its heading (focus + scroll — W4). */
  function goToStep(n: number) {
    setStep(n);
    focusStepHeading(stepHeadingId(n));
  }

  /** The payer dropped the changes restored from this device: a fresh form from step 1 (W4). */
  function discardRestored() {
    draft.discard();
    setFields(BLANK);
    setFieldErrors({});
    setError(null);
    setSelection({ matchSkillIds: [], untickedRelatedIds: [] });
    setPreview(null);
    setRequirements([]);
    setBenefits([]);
    setReqDraft("");
    setBenDraft("");
    setGap(null);
    setRevealed({});
    setTrade({ ...BLANK_TRADE, matchSkillIds: [] });
    goToStep(1);
  }

  // THE ONE READ — the preview, the inline errors, the gap rule and the submit all use it.
  const read = readCardForm(
    { ...fields, title: fields.roleTitle },
    { requirements, benefits, reqDraft, benDraft },
  );
  const hasCardIssue = Object.keys(read.issues).length > 0;
  // #2645 — the picked trade's form, or undefined until one of the 16 is picked. Its match set
  // (base skill + match chips) is derived from the catalogue, never kept apart from it.
  const tradeForm = postingTrades.find((form) => form.role_kind === fields.roleKind);
  const activeMatchSkillIds = tradeForm ? derivedMatchSkills(tradeForm, trade.answers) : [];

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // The trade fields belong to a role. A role change must never keep the previous
    // role's chips (a turner's controller is not a welder's process).
    if (key === "roleKind") {
      const form = postingTrades.find((tradeForm) => tradeForm.role_kind === value);
      setTrade({
        ...BLANK_TRADE,
        matchSkillIds: form ? derivedMatchSkills(form, {}) : [],
      });
      setSelection({ matchSkillIds: [], untickedRelatedIds: [] });
      setPreview(null);
    }
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
  /**
   * A control's error: its own validation first, then a SERVER field error (#1912 — the API
   * refused this field at write), then the refused-publish gap.
   */
  const errorOf = (control: string, own?: string) =>
    own ?? fieldErrors[control as FieldKey] ?? gapError(control);

  /**
   * STEP GATE — the same completeness the create/publish path enforces (`workerCardGap` +
   * `createPostingInputSchema`), applied step by step so a payer cannot walk past an empty
   * Role & Worksite / Pay & Openings card. The server remains the authority; this is UX parity.
   */
  function validateStep(which: 1 | 2): FieldErrors {
    const errs: FieldErrors = {};
    if (which === 1) {
      if (!isPostingTrade(postingTrades, fields.roleKind)) {
        errs.roleKind = POSTING_TRADE_REQUIRED_MESSAGE;
      }
      const title = fields.roleTitle.trim();
      if (title.length < 2 || title.length > 120) {
        errs.roleTitle = "Role title must be 2–120 characters.";
      }
      if (fields.city.trim() === "") {
        errs.city = "Add the city — it is the place shown on the worker's card.";
      }
      return errs;
    }

    if (openingsOf(fields.vacancies) === null) {
      errs.vacancies = "Openings must be a whole number of 1 or more.";
    }
    const payMinIssue = liveCardFieldError(read.issues, "payMin", true);
    const payMaxIssue = liveCardFieldError(read.issues, "payMax", true);
    const expMinIssue = liveCardFieldError(read.issues, "minExperienceYears", true);
    const expMaxIssue = liveCardFieldError(read.issues, "maxExperienceYears", true);
    if (fields.payMin.trim() === "") errs.payMin = "Add the minimum pay.";
    else if (payMinIssue !== undefined) errs.payMin = payMinIssue;
    if (fields.payMax.trim() === "") errs.payMax = "Add the maximum pay.";
    else if (payMaxIssue !== undefined) errs.payMax = payMaxIssue;
    if (fields.payType.trim() === "") errs.payType = "Pick the pay type.";
    if (fields.minExperienceYears.trim() === "") {
      errs.minExperienceYears = "Add the minimum experience.";
    } else if (expMinIssue !== undefined) errs.minExperienceYears = expMinIssue;
    if (fields.maxExperienceYears.trim() === "") {
      errs.maxExperienceYears = "Add the maximum experience.";
    } else if (expMaxIssue !== undefined) errs.maxExperienceYears = expMaxIssue;
    if (fields.shift.trim() === "") errs.shift = "Pick the shift.";
    if (fields.neededBy.trim() === "") errs.neededBy = "Pick needed by.";
    return errs;
  }

  /** Advance only when the CURRENT step is complete; focus the first missing control. */
  function goNext() {
    if (step === 1) {
      const errs = validateStep(1);
      setFieldErrors((prev) => ({ ...prev, ...errs }));
      const first = (Object.keys(errs) as FieldKey[])[0];
      if (first !== undefined) {
        focusControl(first);
        return;
      }
      goToStep(2);
      return;
    }
    if (step === 2) {
      setRevealed(ALL_NUMBERS_REVEALED);
      const errs = validateStep(2);
      setFieldErrors((prev) => ({ ...prev, ...errs }));
      const first = (Object.keys(errs) as FieldKey[])[0];
      if (first !== undefined) {
        focusControl(first);
        return;
      }
      goToStep(3);
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

    // #2645 — a company job is always one of the 16 trades: refused AT the picker, before anything
    // is sent. It leads the form, so it is the first control focus goes to.
    const errs: FieldErrors = {
      ...(tradeForm === undefined ? { roleKind: POSTING_TRADE_REQUIRED_MESSAGE } : {}),
      ...validate(fields),
    };
    setFieldErrors(errs);
    if (hasCardIssue) setRevealed(ALL_NUMBERS_REVEALED);
    const firstBad =
      (Object.keys(errs) as FieldKey[])[0] ?? CARD_NUMBER_FIELDS.find((f) => read.issues[f]);
    if (firstBad !== undefined) {
      if (firstBad === "roleKind" && step !== 1) {
        // The picker leads step 1: show that step, then land on the picker once it is drawn.
        setStep(1);
        focusControlOnNextFrame(firstBad);
      } else focusControl(firstBad);
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

    // No separate "pick a skill" refusal: the picked trade always carries its own match skill
    // (`derivedMatchSkills`), and the trade is required above (#2645).
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
        // ALWAYS the trade form (#2645) — `{}` when no chip is picked — so the server derives the
        // match set from the trade; the rung only when one is picked (it is display-only).
        tradeLevel: trade.tradeLevel || undefined,
        tradeAnswers: trade.answers,
        matchSkillIds: activeMatchSkillIds,
        untickedRelatedIds: [],
      });
      if (res.ok) {
        setNavigating(true);
        draft.discard();
        if (res.tradeRequired) {
          // #2645 — created, but the API would not put it live without one of the 16 trades:
          // open the new draft's edit page refused AT its trade picker.
          navigate(withTradeRequired(`/postings/${res.postingId}/edit`), {
            pendingLabel: "Edit posting",
            refresh: true,
          });
          return;
        }
        navigate(withPublishedReach(`/postings/${res.postingId}/applicants`, res.reached), {
          pendingLabel: "Applicants",
          refresh: true,
        });
      } else {
        // #1912 — the server refused a field (it re-runs the PII screen); show its
        // message ON that input, not only in the banner.
        if (res.fieldErrors) setFieldErrors(res.fieldErrors as FieldErrors);
        setError(res.error);
      }
    });
  }

  // Only a request in flight disables the CTA. Validation — the missing trade included, even when
  // the 16 trades did not load — is surfaced by onSubmit, not by a dead button.
  const submitDisabled = pending || navigating;

  const openings = openingsOf(fields.vacancies);
  const derivedBand = openings !== null ? bandForVacancies(openings) : null;
  const derivedQuota =
    derivedBand !== null ? baseApplicantQuotaForBand(derivedBand, quotaStep) : null;

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
      {busy ? "Publishing…" : preview?.zero_reach ? zeroReachLabel : "Publish posting"}
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

  const STEP_TITLES = ["Role & Worksite", "Pay & Openings", "Skills & Perks"];
  const locationText = [fields.area.trim(), fields.city.trim()].filter(Boolean).join(", ");
  const facts = companyPostingFacts({
    roleKind: read.values.roleKind ?? null,
    openings: fields.vacancies,
    locationNote: fields.locationLabel,
    tradeLevel: trade.tradeLevel || null,
    tradeAnswers: trade.answers,
    postingTrades,
    matchSkills: { ids: activeMatchSkillIds, vocabulary: matchSkills },
    description: fields.description,
  });

  return (
    <div className="mw-layout">
      <div className="mw-main">
        {lead}
        <form id={FORM_ID} className="form mw-form" onSubmit={onSubmit}>
          <ol className="mw-stepper" aria-label="Posting steps">
            {STEP_TITLES.map((title, i) => {
              const n = i + 1;
              const state = step === n ? "active" : step > n ? "done" : "todo";
              return (
                <li
                  className={`mw-step mw-step--${state}`}
                  key={title}
                  aria-current={state === "active" ? "step" : undefined}
                >
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
          <p
            className="mw-draft-cue"
            data-shown={draft.saved ? "true" : "false"}
            aria-hidden={!draft.saved}
          >
            <Icon name="check-circle" /> Draft saved on this device
          </p>
          {draft.restored ? <DraftRestoredNotice onDiscard={discardRestored} /> : null}

          <section className="mw-card" hidden={step !== 1}>
            <div className="mw-card__head">
              <div>
                <h2 className="mw-card__title" id={stepHeadingId(1)} tabIndex={-1}>
                  Step 1: Role &amp; Worksite Details
                </h2>
                <p className="mw-card__sub">
                  Specify the technical trade and factory premises location.
                </p>
              </div>
              <span className="mw-pill mw-pill--warm">In Progress</span>
            </div>
            <div className="mw-card__body">
              <PostingTradePicker
                id="roleKind"
                label="Role Category"
                hint="One of the 16 trades we match on — it decides which workers see this posting."
                trades={postingTrades}
                problem={postingTradesProblem}
                value={fields.roleKind}
                error={errorOf("roleKind")}
                onChange={(value) => set("roleKind", value)}
              />

              <Input
                id="roleTitle"
                label="Role Title"
                placeholder="CNC Machinist"
                value={fields.roleTitle}
                error={fieldErrors.roleTitle}
                aria-invalid={fieldErrors.roleTitle ? true : undefined}
                hint="The primary header text shown prominently on worker job cards."
                onChange={(e) => set("roleTitle", e.target.value)}
              />

              <div className="mw-grid2">
                <Input
                  id="city"
                  label="City"
                  placeholder="Pune"
                  value={fields.city}
                  error={errorOf("city")}
                  aria-invalid={errorOf("city") ? true : undefined}
                  onChange={(e) => set("city", e.target.value)}
                />
                <Input
                  id="area"
                  label="Area / Locality"
                  optional
                  placeholder="Pimpri-Chinchwad"
                  value={fields.area}
                  error={errorOf("area")}
                  aria-invalid={errorOf("area") ? true : undefined}
                  onChange={(e) => set("area", e.target.value)}
                />
              </div>

              <Input
                id="locationLabel"
                label="Internal Plant / Shift Note"
                optional
                placeholder="Pune, MH – Line 3 Bay B"
                value={fields.locationLabel}
                error={errorOf("locationLabel")}
                aria-invalid={errorOf("locationLabel") ? true : undefined}
                hint="Optional – visible only to you."
                onChange={(e) => set("locationLabel", e.target.value)}
              />
            </div>
            <div className="mw-card__foot">
              <button type="button" className="bb-btn bb-btn--primary" onClick={goNext}>
                Next: Pay &amp; Openings <Icon name="arrow-right" />
              </button>
            </div>
          </section>

          <section className="mw-card" hidden={step !== 2}>
            <div className="mw-card__head">
              <div>
                <h2 className="mw-card__title" id={stepHeadingId(2)} tabIndex={-1}>
                  Step 2: Pay &amp; Openings
                </h2>
                <p className="mw-card__sub">Set the pay band, openings and joining window.</p>
              </div>
            </div>
            <div className="mw-card__body">
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
                onClick={() => goToStep(1)}
              >
                Back
              </button>
              <button type="button" className="bb-btn bb-btn--primary" onClick={goNext}>
                Next: Skills &amp; Perks <Icon name="arrow-right" />
              </button>
            </div>
          </section>

          <section className="mw-card" hidden={step !== 3}>
            <div className="mw-card__head">
              <div>
                <h2 className="mw-card__title" id={stepHeadingId(3)} tabIndex={-1}>
                  Step 3: Skills &amp; Perks
                </h2>
                <p className="mw-card__sub">Pick the skills workers search by, then add perks.</p>
              </div>
            </div>
            <div className="mw-card__body">
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

              <div id="match-skills">
                {/* The trade's own fields — the ONLY match input of a company job (#2645): no
                    flat skill picker, no "could not load the skill list" fallback. */}
                <TradePostingFields
                  trades={postingTrades}
                  roleKind={fields.roleKind}
                  value={{ tradeLevel: trade.tradeLevel, answers: trade.answers }}
                  onChange={(next) => {
                    const form = postingTrades.find((t) => t.role_kind === fields.roleKind);
                    setTrade({
                      ...next,
                      matchSkillIds: form ? derivedMatchSkills(form, next.answers) : [],
                    });
                  }}
                  onMatchSkillIdsChange={() => undefined}
                  onPreviewChange={setPreview}
                  vocabulary={matchSkills}
                  reachRoleKind={fields.roleKind || undefined}
                />
              </div>

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
                  hint="Workers read this when they open the posting. Never include a phone number or email — share contact only after you unlock an applicant."
                  onChange={(e) => set("description", e.target.value)}
                />
              </div>
            </div>
            <div className="mw-card__foot">
              <button
                type="button"
                className="bb-btn bb-btn--secondary bb-btn--sm"
                onClick={() => goToStep(2)}
              >
                Back
              </button>
              {/* The hint names where Publish IS at this width (W4): the rail beside the form on
                  a wide screen, the bar pinned to the bottom of the screen at 1100px and below. */}
              <span className="mw-card__foothint mw-card__foothint--wide">
                Publish from the panel on the right →
              </span>
              <span className="mw-card__foothint mw-card__foothint--narrow">
                Publish from the bar at the bottom of the screen ↓
              </span>
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
              <p className="mw-mini__title">{free ? "100% Free Through Launch" : "Paid posting"}</p>
              <p className="mw-mini__meta">{free ? "₹0 cost" : "See billing"}</p>
              <p className="mw-mini__sub">
                {free
                  ? "Publish unlimited job openings during this beta testing window."
                  : "Paid plans are billed per posting."}
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

          {/* The one worker card, exactly as the phone draws it (JobCardPreview). The heading
              above already gives it context, so the preview caption is hidden here. */}
          <JobCardPreview fields={read.card} draft={read.draft} showCaption={false} expand />
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
              <dt>Target Openings</dt>
              <dd>{fields.vacancies !== "" ? fields.vacancies : "—"}</dd>
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
          {/* The DESKTOP rail is where the payer reads the outcome, so it carries the same
              status/outcome slots as the phone dock (the shared hidden rail keeps the dock). */}
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

      {/* The shared rail keeps the live-slot/dock behaviour the form has always had, in the
          DOM but out of sight behind the designer layout. */}
      <PostingPreviewRail
        hidden
        fields={read.card}
        draft={read.draft}
        facts={facts}
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

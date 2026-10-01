"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { looksLikePii } from "@badabhai/validators";
import { Button, Input, Select, Textarea } from "../../../../../components/ds";
import { ChipEditor } from "../../../../../components/chip-editor";
import { PostingActions, PostingPreviewRail } from "../../../../../components/posting-preview-rail";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  type MatchSkillWire,
  type ReachPreview,
} from "../../../../../lib/contracts";
import { roleOptionGroups } from "../../../../../lib/job-roles";
import { neededByLabel, payTypeLabel, shiftLabel } from "../../../../../lib/job-card-view";
import {
  CARD_NUMBER_FIELDS,
  cardIssueMessage,
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
} from "../../../../../lib/job-card-form";
import { companyPostingFacts } from "../../../../../lib/posting-facts";
import { workerCardGap, workerCardGaps } from "../../../../../lib/worker-card-gap";
import type { PostingEditInitial } from "../../../../../lib/payer-api";
import { MatchSkillPicker, type MatchSelection } from "../../new/match-skill-picker";
import { updatePostingAction } from "./actions";

/**
 * Edit a posting (EMPLOYER self-serve; LIVE `PATCH /payer/job-postings/:id`). Every card field +
 * the role + the MatchSkillPicker (prefilled), beside the {@link PostingPreviewRail} — the worker's
 * card built from the SAME `readCardForm` values the save sends. DRAFT → "Save draft" (no gap
 * block) + "Publish posting" (gap block + ≥1 skill). OPEN/PAUSED → "Save changes" (gaps
 * HIGHLIGHTED, never blocked — owner ruling). The `initial` prop drives the `clear` diff (a
 * blanked field is unset server-side); the page keys this form on the saved revision, so it is
 * re-seeded whenever the server copy changes.
 */

const ROLE_GROUPS = roleOptionGroups();
const FORM_ID = "edit-posting-form";

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

function seedEnum(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : "";
}

/** Moves focus (and so the scroll) to a control the payer has to fix. A no-op outside a browser. */
function focusControl(id: string) {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.focus();
}

export function EditPostingForm({
  postingId,
  status,
  initial,
  matchSkills = [],
  matchSelection,
  lead,
}: {
  postingId: string;
  status: string;
  initial: EditPostingInitial;
  matchSkills?: MatchSkillWire[];
  matchSelection?: MatchSelection;
  /** The page head, drawn at the top of the form column (the rail starts beside it). */
  lead?: ReactNode;
}) {
  const router = useRouter();
  // useState order (mirrored positionally by edit-posting-form.test.tsx): fields, requirements,
  // benefits, reqDraft, benDraft, error, selection, preview, revealed. APPEND new state only.
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
  const [revealed, setRevealed] = useState<RevealedNumbers>({});
  const [pending, startTransition] = useTransition();

  const isDraft = status === "draft";

  // THE ONE READ — the preview, the inline errors, the gaps and the save all use it.
  const read = readCardForm(
    { ...fields, title: fields.roleTitle },
    { requirements, benefits, reqDraft, benDraft },
  );

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    const pair = numberPairOf(key);
    if (pair !== null) setRevealed((prev) => revealNumberPair(prev, pair, false));
  }

  /** Leaving one end of a min/max pair shows that pair's order error (typing never flashes it). */
  function reveal(pair: CardNumberPair) {
    setRevealed((prev) => revealNumberPair(prev, pair, true));
  }

  const numberError = (key: CardNumberField) =>
    liveCardFieldError(read.issues, key, revealed[key] === true);

  /** The gaps STILL open — highlighted (never blocked) so the payer sees what the card is missing. */
  const gaps = workerCardGaps(gapInputFromValues(read.values, fields.description));

  /** The first problem a save would hit, with the control to take the payer to. */
  function clientValidate(): { message: string; control: string } | null {
    if ([...fields.roleTitle.trim()].length < 2) {
      return { message: "Role title must be at least 2 characters.", control: "roleTitle" };
    }
    const count = parseWholeNumber(fields.vacancies);
    if (count.kind !== "ok" || count.value <= 0) {
      return { message: "Openings must be a positive number.", control: "vacancies" };
    }
    if (fields.description.trim() !== "" && looksLikePii(fields.description)) {
      return { message: "Remove contact details (phone/email) from the description.", control: "description" };
    }
    // A number that cannot be saved as typed must block the save: sending it as "not stated"
    // would CLEAR the stored value through the `clear` diff.
    for (const field of CARD_NUMBER_FIELDS) {
      const issue = read.issues[field];
      if (issue !== undefined) return { message: cardIssueMessage(field, issue), control: field };
    }
    return null;
  }

  function submit(mode: "save" | "publish") {
    // A chip still in its box is part of the posting (`read.values` carries it) — show it added.
    setRequirements(read.values.requirements);
    setBenefits(read.values.benefits);
    setReqDraft("");
    setBenDraft("");

    const problem = clientValidate();
    if (problem !== null) {
      setError(problem.message);
      if (Object.keys(read.issues).length > 0) setRevealed(ALL_NUMBERS_REVEALED);
      focusControl(problem.control);
      return;
    }
    if (mode === "publish") {
      // The action re-runs the gap rule (the authority); checking here first takes the payer
      // straight to the missing field instead of round-tripping.
      const gap = workerCardGap(gapInputFromValues(read.values, fields.description));
      if (gap !== null) {
        setError(`${gap.title}: ${gap.message}`);
        focusControl(gap.field);
        return;
      }
    }
    setError(null);
    const v = read.values;
    const count = parseWholeNumber(fields.vacancies);
    startTransition(async () => {
      const res = await updatePostingAction({
        postingId,
        roleTitle: v.title,
        roleKind: v.roleKind,
        // OMIT the count when untouched — re-submitting the prefill hint would re-derive (and for a
        // "25+" posting DOWNGRADE) the stored band on an unrelated edit.
        vacancies:
          fields.vacancies === String(initial.vacanciesHint) || count.kind !== "ok"
            ? undefined
            : count.value,
        locationLabel: fields.locationLabel.trim() || undefined,
        description: fields.description.trim() || undefined,
        city: v.city,
        area: v.area,
        payMin: v.payMin,
        payMax: v.payMax,
        payType: v.payType,
        minExperienceYears: v.minExperienceYears,
        maxExperienceYears: v.maxExperienceYears,
        shift: v.shift,
        neededBy: v.neededBy,
        requirements: v.requirements,
        benefits: v.benefits,
        initial,
        ...(mode === "publish" ? { publish: selection } : {}),
      });
      if (res.ok) {
        // Refresh as well as navigate: the router cache must not hand a later Back the pre-save
        // edit page (and its pre-save `initial`, which drives the clear diff).
        router.push(`/postings/${postingId}`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function addChip(kind: "req" | "ben") {
    if (kind === "req") {
      setRequirements((prev) => withChipDraft(prev, reqDraft).list);
      setReqDraft("");
    } else {
      setBenefits((prev) => withChipDraft(prev, benDraft).list);
      setBenDraft("");
    }
  }

  const publishDisabled = pending || selection.matchSkillIds.length === 0;
  const primary = isDraft ? (
    <Button
      type="button"
      loading={pending}
      disabled={publishDisabled}
      iconRight="rocket-launch"
      onClick={() => submit("publish")}
    >
      {preview?.zero_reach ? "Publish anyway — reaches nobody yet" : "Publish posting"}
    </Button>
  ) : (
    <Button type="submit" form={FORM_ID} loading={pending} disabled={pending}>
      Save changes
    </Button>
  );
  const actions = (
    <PostingActions
      status={
        <>
          {gaps.length > 0 ? (
            <p className="posting-actions__msg posting-actions__msg--warning" role="status">
              <strong>Still to fill:</strong> {gaps.map((g) => g.title.toLowerCase()).join(", ")}.
              {isDraft ? " Publishing needs them filled." : " You can save now and finish later."}
            </p>
          ) : null}
          {error !== null ? (
            <p className="posting-actions__msg posting-actions__msg--danger">
              <strong>Your changes were not saved.</strong> {error}
            </p>
          ) : null}
        </>
      }
    >
      {isDraft ? (
        <Button type="submit" form={FORM_ID} variant="secondary" loading={pending} disabled={pending}>
          Save draft
        </Button>
      ) : null}
      {primary}
    </PostingActions>
  );

  return (
    <div className="posting-layout posting-layout--editor">
      <div className="posting-layout__main">
        {lead}
        <form
          id={FORM_ID}
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
            <Input
              id="roleTitle"
              label="Role title"
              value={fields.roleTitle}
              hint="The heading of the worker's card."
              onChange={(e) => set("roleTitle", e.target.value)}
              required
            />
            <div className="form-grid">
              <Input
                id="locationLabel"
                label="Location note"
                optional
                value={fields.locationLabel}
                onChange={(e) => set("locationLabel", e.target.value)}
              />
              <Input
                id="vacancies"
                label="Openings"
                inputMode="numeric"
                value={fields.vacancies}
                onChange={(e) => set("vacancies", e.target.value)}
                required
              />
            </div>
            <div className="form-grid">
              <Input id="city" label="City" value={fields.city} onChange={(e) => set("city", e.target.value)} />
              <Input
                id="area"
                label="Area / locality"
                optional
                value={fields.area}
                onChange={(e) => set("area", e.target.value)}
              />
            </div>
          </div>

          <div className="form__section">
            <p className="form__legend">Pay and timing</p>
            <div className="form-grid">
              <Input
                id="payMin"
                label="Pay — min (₹ / month)"
                inputMode="numeric"
                value={fields.payMin}
                error={numberError("payMin")}
                aria-invalid={numberError("payMin") ? true : undefined}
                onChange={(e) => set("payMin", e.target.value)}
                onBlur={() => reveal("pay")}
              />
              <Input
                id="payMax"
                label="Pay — max (₹ / month)"
                inputMode="numeric"
                value={fields.payMax}
                error={numberError("payMax")}
                aria-invalid={numberError("payMax") ? true : undefined}
                onChange={(e) => set("payMax", e.target.value)}
                onBlur={() => reveal("pay")}
              />
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
              <Input
                id="minExperienceYears"
                label="Experience — min (years)"
                inputMode="numeric"
                value={fields.minExperienceYears}
                error={numberError("minExperienceYears")}
                aria-invalid={numberError("minExperienceYears") ? true : undefined}
                onChange={(e) => set("minExperienceYears", e.target.value)}
                onBlur={() => reveal("experience")}
              />
              <Input
                id="maxExperienceYears"
                label="Experience — max (years)"
                inputMode="numeric"
                value={fields.maxExperienceYears}
                error={numberError("maxExperienceYears")}
                aria-invalid={numberError("maxExperienceYears") ? true : undefined}
                onChange={(e) => set("maxExperienceYears", e.target.value)}
                onBlur={() => reveal("experience")}
              />
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
            <ChipEditor
              id="requirements"
              label="Requirements"
              placeholder="e.g. Fanuc control"
              draft={reqDraft}
              items={requirements}
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
              onDraft={setBenDraft}
              onAdd={() => addChip("ben")}
              onRemove={(i) => setBenefits((p) => p.filter((_, j) => j !== i))}
            />
          </div>

          <div className="form__section">
            <p className="form__legend">Description</p>
            <Textarea
              id="description"
              label="Description"
              value={fields.description}
              hint="Workers read this when they open the job. No phone number or email."
              onChange={(e) => set("description", e.target.value)}
              rows={4}
            />
          </div>

          {isDraft && matchSkills.length > 0 ? (
            <MatchSkillPicker vocabulary={matchSkills} selection={selection} onChange={setSelection} onPreviewChange={setPreview} />
          ) : null}

          <div className="posting-layout__end">{actions}</div>
        </form>
      </div>

      <PostingPreviewRail
        fields={read.card}
        draft={read.draft}
        facts={companyPostingFacts({
          roleKind: read.values.roleKind ?? null,
          openings: fields.vacancies,
          locationNote: fields.locationLabel,
          matchSkills:
            matchSkills.length > 0 ? { ids: selection.matchSkillIds, vocabulary: matchSkills } : null,
          description: fields.description,
        })}
        actions={actions}
        primary={primary}
      />
    </div>
  );
}

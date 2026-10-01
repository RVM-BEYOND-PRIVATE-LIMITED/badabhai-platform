"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
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
import { agencyPostingFacts } from "../../../../lib/posting-facts";
import {
  workerCardGap,
  workerCardGaps,
  type WorkerCardGap,
} from "../../../../lib/worker-card-gap";
import { Button, Input, Select, Textarea } from "../../../../components/ds";
import { ChipEditor } from "../../../../components/chip-editor";
import { PostingActions, PostingPreviewRail } from "../../../../components/posting-preview-rail";

/**
 * Shared CREATE/EDIT form for an agency posting (ADR-0022, LIVE) — an agency job traces to the
 * SAME Job Card as a company posting. It collects the role (one of the 21 — display), the trade
 * (its 15-trade matching classifier), the city/area, pay band + pay type, experience, shift,
 * timing, description and requirement/benefit chips, beside the {@link PostingPreviewRail}: the
 * worker's card built from the SAME `readCardForm` values the submit sends.
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

type FieldKey = "title" | "city";
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

/** The non-card checks (the card numbers are `readCardForm`'s issues). UX parity with the schema. */
function validate(fields: FormFields): FieldErrors {
  const errs: FieldErrors = {};
  if (fields.title.trim().length < 1) errs.title = "Enter a role title.";
  if (fields.city.trim().length < 1) errs.city = "Enter a city.";
  return errs;
}

export function AgencyJobForm({
  mode,
  job,
  onSubmit,
  onCancel,
  submitLabel,
  lead,
}: {
  mode: "create" | "edit";
  job?: AgencyJob;
  onSubmit: (input: AgencyJobInputValues) => Promise<AgencyJobFormSubmitResult>;
  onCancel?: () => void;
  submitLabel: string;
  /**
   * What heads the form column — the create card's heading, or the vacancy row's own header on
   * edit — so the preview rail starts level with the top of the host, not below it.
   */
  lead?: ReactNode;
}) {
  // useState call order (mirrored by agency-job-form.test.tsx): fields, fieldErrors, error,
  // requirements, benefits, reqDraft, benDraft, gap, revealed. APPEND new state only.
  const [fields, setFields] = useState<FormFields>(job ? fromJob(job) : BLANK);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<string[]>(job?.requirements ?? []);
  const [benefits, setBenefits] = useState<string[]>(job?.benefits ?? []);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [gap, setGap] = useState<WorkerCardGap | null>(null);
  const [revealed, setRevealed] = useState<RevealedNumbers>({});
  const [pending, startTransition] = useTransition();

  // One form per job on the page (the create form and each row's edit form never coexist, but the
  // id stays unique regardless) — the rail's buttons submit it through the `form` attribute.
  const formId = `agency-job-form-${job?.id ?? "new"}`;

  // THE ONE READ — the preview, the inline errors, the gap rule and the submit all use it.
  const read = readCardForm(fields, { requirements, benefits, reqDraft, benDraft });
  const hasCardIssue = Object.keys(read.issues).length > 0;
  const isValid = Object.keys(validate(fields)).length === 0 && !hasCardIssue;

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

    const errs = validate(fields);
    setFieldErrors(errs);
    if (hasCardIssue) setRevealed(ALL_NUMBERS_REVEALED);
    const firstBad =
      (Object.keys(errs) as FieldKey[])[0] ?? CARD_NUMBER_FIELDS.find((f) => read.issues[f]);
    if (firstBad !== undefined) {
      focusControl(firstBad);
      return;
    }

    // GAP RULE on CREATE (an agency job goes live immediately — create == publish). On EDIT the
    // gaps are only highlighted, never blocking (owner ruling).
    if (mode === "create") {
      const cardGap = workerCardGap(gapInputFromValues(read.values, fields.description));
      if (cardGap !== null) {
        setGap(cardGap);
        focusControl(cardGap.field);
        return;
      }
    }

    const v = read.values;
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

  const primary = (
    <Button type="submit" form={formId} disabled={pending || !isValid} loading={pending}>
      {pending ? "Saving…" : submitLabel}
    </Button>
  );
  // ONE status: the rail footer on desktop, the dock below 1024px (the form's end repeats only
  // the buttons) — the reason a create was refused sits by the button the payer pressed.
  const statusLine = (
    <>
      {gap !== null ? (
        <p className="posting-actions__msg posting-actions__msg--warning" role="alert">
          <strong>{gap.title}.</strong> {gap.message}
        </p>
      ) : null}
      {editGaps.length > 0 ? (
        <p className="posting-actions__msg posting-actions__msg--warning" role="status">
          <strong>Still to fill:</strong> {editGaps.map((g) => g.title.toLowerCase()).join(", ")}.
          {" You can save now and finish later."}
        </p>
      ) : null}
      {error ? <p className="posting-actions__msg posting-actions__msg--danger">{error}</p> : null}
    </>
  );
  const buttons = (
    <>
      {primary}
      {onCancel ? (
        <Button variant="secondary" type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="posting-layout posting-layout--editor">
      <div className="posting-layout__main">
        {lead}
        <form id={formId} className="agency-job-form" onSubmit={handleSubmit}>
          <Select id="roleKind" label="Role" value={fields.roleKind} error={errorOf("roleKind")} aria-invalid={errorOf("roleKind") ? true : undefined} onChange={(e) => set("roleKind", e.target.value)}>
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

          <Input id="title" label="Role title" placeholder="CNC Operator — Night Shift" value={fields.title} error={fieldErrors.title} aria-invalid={fieldErrors.title ? true : undefined} hint="The heading of the worker's card — a generic role title, never an employer name or contact details." onChange={(e) => set("title", e.target.value)} />

          <div className="agency-job-form__pair">
            <Input id="city" label="City" placeholder="Pune" value={fields.city} error={errorOf("city", fieldErrors.city)} aria-invalid={errorOf("city", fieldErrors.city) ? true : undefined} onChange={(e) => set("city", e.target.value)} />
            <Input id="area" label="Area / locality" optional placeholder="Pimpri-Chinchwad" value={fields.area} onChange={(e) => set("area", e.target.value)} />
          </div>

          <div className="agency-job-form__pair">
            <Input id="payMin" label="Pay band — min (₹ / month)" inputMode="numeric" placeholder="20000" value={fields.payMin} error={errorOf("payMin", numberError("payMin"))} aria-invalid={errorOf("payMin", numberError("payMin")) ? true : undefined} onChange={(e) => set("payMin", e.target.value)} onBlur={() => reveal("pay")} />
            <Input id="payMax" label="Pay band — max (₹ / month)" inputMode="numeric" placeholder="35000" value={fields.payMax} error={errorOf("payMax", numberError("payMax"))} aria-invalid={errorOf("payMax", numberError("payMax")) ? true : undefined} onChange={(e) => set("payMax", e.target.value)} onBlur={() => reveal("pay")} />
          </div>

          <Select id="payType" label="Pay type" value={fields.payType} error={errorOf("payType")} aria-invalid={errorOf("payType") ? true : undefined} onChange={(e) => set("payType", e.target.value)}>
            <option value="">— pick the pay type —</option>
            {PAY_TYPES.map((p) => (
              <option key={p} value={p}>
                {payTypeLabel(p)}
              </option>
            ))}
          </Select>

          <div className="agency-job-form__pair">
            <Input id="minExperienceYears" label="Experience — min (years)" inputMode="numeric" placeholder="1" value={fields.minExperienceYears} error={errorOf("minExperienceYears", numberError("minExperienceYears"))} aria-invalid={errorOf("minExperienceYears", numberError("minExperienceYears")) ? true : undefined} onChange={(e) => set("minExperienceYears", e.target.value)} onBlur={() => reveal("experience")} />
            <Input id="maxExperienceYears" label="Experience — max (years)" inputMode="numeric" placeholder="5" value={fields.maxExperienceYears} error={errorOf("maxExperienceYears", numberError("maxExperienceYears"))} aria-invalid={errorOf("maxExperienceYears", numberError("maxExperienceYears")) ? true : undefined} onChange={(e) => set("maxExperienceYears", e.target.value)} onBlur={() => reveal("experience")} />
          </div>

          <div className="agency-job-form__pair">
            <Select id="shift" label="Shift" value={fields.shift} error={errorOf("shift")} aria-invalid={errorOf("shift") ? true : undefined} onChange={(e) => set("shift", e.target.value)}>
              <option value="">— pick the shift —</option>
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  {shiftLabel(s)}
                </option>
              ))}
            </Select>
            <Select id="neededBy" label="Needed by" value={fields.neededBy} error={errorOf("neededBy")} aria-invalid={errorOf("neededBy") ? true : undefined} onChange={(e) => set("neededBy", e.target.value)}>
              <option value="">— pick joining time —</option>
              {NEEDED_BY.map((n) => (
                <option key={n} value={n}>
                  {neededByLabel(n)}
                </option>
              ))}
            </Select>
          </div>

          <Textarea id="description" label="Description" value={fields.description} rows={3} onFocus={revealWholeControl} error={errorOf("description")} aria-invalid={errorOf("description") ? true : undefined} hint="What the work is — workers read it when they open the job. Never a phone/email or a company name." onChange={(e) => set("description", e.target.value)} />

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

          <div className="posting-layout__end">
            <PostingActions>{buttons}</PostingActions>
          </div>
        </form>
      </div>

      <PostingPreviewRail
        fields={read.card}
        draft={read.draft}
        facts={agencyPostingFacts({
          roleKind: read.values.roleKind ?? null,
          tradeKey: fields.tradeKey,
          description: fields.description,
        })}
        actions={<PostingActions status={statusLine}>{buttons}</PostingActions>}
        primary={primary}
        status={statusLine}
      />
    </div>
  );
}

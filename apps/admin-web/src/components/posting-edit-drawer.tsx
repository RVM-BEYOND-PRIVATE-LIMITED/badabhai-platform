"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "./drawer";
import { ConfirmDialog, type ConfirmChange } from "./confirm-dialog";
import { FieldError } from "./form-feedback";
import { successToast, timelineLink } from "./admin-action-result-banner";
import { useToast } from "./toast";
import type { JobPostingDetail } from "../lib/entities";
import type { AdminActionOutcome } from "../lib/admin-action-result";
import {
  POSTING_REASON_CATEGORIES,
  POSTING_VACANCY_BANDS,
} from "../lib/company-vocabulary";
import { editPostingAction, readPostingDetailAction } from "../app/(portal)/companies/[id]/posting-actions";
import { readMatchVocabularyAction } from "../app/(portal)/jobs/agency/[jobId]/match-skills/actions";
import type { MatchSkillVocabulary } from "../lib/agency-jobs";

interface Draft {
  roleTitle: string;
  description: string;
  city: string;
  area: string;
  locationLabel: string;
  payMin: string;
  payMax: string;
  vacancyBand: string;
  requirements: string;
  benefits: string;
}

const listText = (values: string[] | null | undefined) => (values ?? []).join(", ");
const listOf = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const text = (value: string | null | undefined) => value ?? "";

function draftOf(posting: JobPostingDetail): Draft {
  return {
    roleTitle: posting.role_title,
    description: text(posting.description),
    city: text(posting.city),
    area: text(posting.area),
    locationLabel: text(posting.location_label),
    payMin: posting.pay_min === null ? "" : String(posting.pay_min),
    payMax: posting.pay_max === null ? "" : String(posting.pay_max),
    vacancyBand: posting.vacancy_band,
    requirements: listText(posting.requirements),
    benefits: listText(posting.benefits),
  };
}

const LABELS: Record<string, string> = {
  role_title: "Role title",
  title: "Role title",
  description: "Description",
  city: "City",
  area: "Area",
  location_label: "Location note",
  pay_min: "Pay minimum",
  pay_max: "Pay maximum",
  vacancy_band: "Openings",
  requirements: "Requirements",
  benefits: "Benefits",
  match_skill_ids: "Match skills",
};

/**
 * The Postings tab's edit drawer (A9, #2579; API #2566).
 *
 * The drawer loads the posting's full card and the match-skill vocabulary when it opens, sends
 * only changed fields, and asks for a T2 confirmation with a field-by-field diff and a reason.
 *
 * MATCH SKILLS: the admin read does not expose a company posting's current `match_skill_ids`
 * (only agency jobs serve them), so the picker starts empty and is sent ONLY when the operator
 * touches it. An untouched picker never clears an existing selection.
 */
export function PostingEditDrawer({
  postingId,
  open,
  onClose,
  timelineHref,
}: {
  postingId: string;
  open: boolean;
  onClose: () => void;
  timelineHref: string | null;
}) {
  const router = useRouter();
  const { show } = useToast();
  const [posting, setPosting] = useState<JobPostingDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [vocabulary, setVocabulary] = useState<MatchSkillVocabulary | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillsTouched, setSkillsTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const ids = useId();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setPosting(null);
    setDraft(null);
    setError(null);
    setOutcome(null);
    setSkillIds([]);
    setSkillsTouched(false);
    setReviewOpen(false);
    void readPostingDetailAction(postingId).then((result) => {
      if (!active) return;
      if (!result.ok || !result.posting) {
        setError(result.error ?? "The posting could not be loaded.");
        return;
      }
      setPosting(result.posting);
      setDraft(draftOf(result.posting));
    });
    void readMatchVocabularyAction().then((result) => {
      if (!active) return;
      setVocabulary(result.ok ? result.vocabulary : null);
    });
    return () => {
      active = false;
    };
  }, [open, postingId]);

  function close() {
    if (reviewOpen) return;
    onClose();
  }

  if (!open) return null;

  const isAgencyJob = posting?.payer_role === "agent";
  const changes =
    posting && draft ? changesOf(posting, draft, skillIds, skillsTouched, isAgencyJob === true) : {};
  const diff = posting ? diffOf(posting, changes, skillIds, skillsTouched) : [];
  const set = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  async function save(reason: { category: string; text: string }): Promise<AdminActionOutcome> {
    if (!posting) return { ok: false, error: "The posting is still loading." };
    const result = await editPostingAction(posting.id, changes, {
      reasonCode: reason.category,
      reasonText: reason.text,
    });
    setOutcome(result);
    if (result.ok) {
      show(successToast(result, timelineLink(timelineHref)));
      setReviewOpen(false);
      router.refresh();
      onClose();
    }
    return result;
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={close}
        title="Edit posting"
        description="Only the fields you change are sent, with the reason you confirm on the next step."
        footer={
          <>
            <button className="btn btn--ghost" type="button" onClick={close}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => setReviewOpen(true)}
              disabled={!posting || !draft || diff.length === 0}
            >
              Review and save
            </button>
          </>
        }
      >
        {error ? (
          <div className="state state--error">
            <h3 className="state__title">The posting could not be loaded</h3>
            <p className="state__body">{error}</p>
          </div>
        ) : !posting || !draft ? (
          <p className="state__body">Loading the posting…</p>
        ) : (
          <form className="form" onSubmit={(e) => e.preventDefault()} noValidate>
            <label className="field" htmlFor={`${ids}-title`}>
              <span className="field__label">
                Role title<span className="req">*</span>
              </span>
              <input
                id={`${ids}-title`}
                className="field__input"
                value={draft.roleTitle}
                onChange={(e) => set({ roleTitle: e.target.value })}
                required
                minLength={1}
              />
              <FieldError>
                {draft.roleTitle.trim() === "" ? "Enter the role title." : null}
              </FieldError>
            </label>

            <label className="field" htmlFor={`${ids}-description`}>
              <span className="field__label">Description</span>
              <textarea
                id={`${ids}-description`}
                className="field__input"
                rows={4}
                value={draft.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            </label>

            <div className="form-grid">
              <label className="field" htmlFor={`${ids}-city`}>
                <span className="field__label">City</span>
                <input
                  id={`${ids}-city`}
                  className="field__input"
                  value={draft.city}
                  onChange={(e) => set({ city: e.target.value })}
                  placeholder="e.g. Pune"
                />
              </label>
              <label className="field" htmlFor={`${ids}-area`}>
                <span className="field__label">Area</span>
                <input
                  id={`${ids}-area`}
                  className="field__input"
                  value={draft.area}
                  onChange={(e) => set({ area: e.target.value })}
                  placeholder="e.g. Chakan"
                />
              </label>
            </div>

            {isAgencyJob ? null : (
              <label className="field" htmlFor={`${ids}-location`}>
                <span className="field__label">Location note</span>
                <input
                  id={`${ids}-location`}
                  className="field__input"
                  value={draft.locationLabel}
                  onChange={(e) => set({ locationLabel: e.target.value })}
                />
              </label>
            )}

            <div className="form-grid">
              <label className="field" htmlFor={`${ids}-pay-min`}>
                <span className="field__label">Pay minimum (₹)</span>
                <input
                  id={`${ids}-pay-min`}
                  className="field__input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={draft.payMin}
                  onChange={(e) => set({ payMin: e.target.value })}
                />
              </label>
              <label className="field" htmlFor={`${ids}-pay-max`}>
                <span className="field__label">Pay maximum (₹)</span>
                <input
                  id={`${ids}-pay-max`}
                  className="field__input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={draft.payMax}
                  onChange={(e) => set({ payMax: e.target.value })}
                />
              </label>
            </div>

            {isAgencyJob ? null : (
              <label className="field" htmlFor={`${ids}-band`}>
                <span className="field__label">Openings</span>
                <select
                  id={`${ids}-band`}
                  className="field__input"
                  value={draft.vacancyBand}
                  onChange={(e) => set({ vacancyBand: e.target.value })}
                >
                  {POSTING_VACANCY_BANDS.map((band) => (
                    <option key={band} value={band}>
                      {band}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="field" htmlFor={`${ids}-requirements`}>
              <span className="field__label">Requirements</span>
              <input
                id={`${ids}-requirements`}
                className="field__input"
                value={draft.requirements}
                onChange={(e) => set({ requirements: e.target.value })}
                placeholder="e.g. ITI, 2 years on CNC"
              />
              <span className="field__help">Comma-separated.</span>
            </label>

            <label className="field" htmlFor={`${ids}-benefits`}>
              <span className="field__label">Benefits</span>
              <input
                id={`${ids}-benefits`}
                className="field__input"
                value={draft.benefits}
                onChange={(e) => set({ benefits: e.target.value })}
                placeholder="e.g. Canteen, transport"
              />
              <span className="field__help">Comma-separated.</span>
            </label>

            <fieldset className="checklist">
              <legend className="kv__k">
                Match skills
                {vocabulary ? ` (at most ${vocabulary.max_skills_per_posting ?? "server cap"})` : ""}
              </legend>
              {vocabulary ? (
                <>
                  <p className="field__help">
                    The current selection is not exposed by the admin posting API. Leave this
                    untouched to keep it; selecting skills here replaces it.
                  </p>
                  {vocabulary.skills.map((skill) => (
                    <label className="checklist__row" key={skill.skill_id}>
                      <input
                        type="checkbox"
                        checked={skillIds.includes(skill.skill_id)}
                        onChange={() => {
                          setSkillsTouched(true);
                          setSkillIds((current) =>
                            current.includes(skill.skill_id)
                              ? current.filter((id) => id !== skill.skill_id)
                              : [...current, skill.skill_id],
                          );
                        }}
                      />
                      <span>{skill.label}</span>
                    </label>
                  ))}
                </>
              ) : (
                <p className="field__help">
                  The match-skill vocabulary is unavailable for this admin role, so the selection
                  is left unchanged.
                </p>
              )}
            </fieldset>

            {diff.length === 0 ? (
              <p className="field__help">Change a field to review the edit.</p>
            ) : (
              <p className="field__help">
                {diff.length} field{diff.length === 1 ? "" : "s"} will change.
              </p>
            )}
            {outcome && !outcome.ok ? <p className="field__error">{outcome.error}</p> : null}
          </form>
        )}
      </Drawer>

      <ConfirmDialog
        open={open && reviewOpen}
        onClose={() => setReviewOpen(false)}
        tier="consequential"
        title="Save this posting?"
        description="The changed fields and the reason below are committed together, with one admin action on the posting's timeline."
        changes={diff}
        categories={POSTING_REASON_CATEGORIES}
        confirmLabel="Save posting"
        onConfirm={save}
      />
    </>
  );
}

function changesOf(
  posting: JobPostingDetail,
  draft: Draft,
  skillIds: string[],
  skillsTouched: boolean,
  isAgencyJob: boolean,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const clear: string[] = [];
  const setOrClear = (key: string, value: string | number) => {
    if (value === "") clear.push(key);
    else changes[key] = value;
  };
  // A twin of an agency job resolves to the SOURCE `jobs` row, whose DTO names the title
  // `title` (not `role_title`) and has no location note or vacancy band. The rest of the card
  // field names are shared.
  if (draft.roleTitle.trim() !== posting.role_title) {
    if (isAgencyJob) changes.title = draft.roleTitle.trim();
    else changes.role_title = draft.roleTitle.trim();
  }
  if (draft.description.trim() !== text(posting.description).trim())
    setOrClear("description", draft.description.trim());
  if (draft.city.trim() !== text(posting.city).trim())
    setOrClear("city", draft.city.trim());
  if (draft.area.trim() !== text(posting.area).trim())
    setOrClear("area", draft.area.trim());
  if (!isAgencyJob && draft.locationLabel.trim() !== text(posting.location_label).trim())
    setOrClear("location_label", draft.locationLabel.trim());
  const payValue = (value: string): string | number => {
    if (value.trim() === "") return "";
    const n = Number(value);
    return Number.isFinite(n) ? n : "";
  };
  if (draft.payMin.trim() !== (posting.pay_min === null ? "" : String(posting.pay_min)))
    setOrClear("pay_min", payValue(draft.payMin));
  if (draft.payMax.trim() !== (posting.pay_max === null ? "" : String(posting.pay_max)))
    setOrClear("pay_max", payValue(draft.payMax));
  if (!isAgencyJob && draft.vacancyBand !== posting.vacancy_band)
    changes.vacancy_band = draft.vacancyBand;
  if (draft.requirements.trim() !== listText(posting.requirements).trim())
    changes.requirements = listOf(draft.requirements);
  if (draft.benefits.trim() !== listText(posting.benefits).trim())
    changes.benefits = listOf(draft.benefits);
  if (skillsTouched) changes.match_skill_ids = skillIds;
  if (clear.length > 0) changes.clear = clear;
  return changes;
}

function diffOf(
  posting: JobPostingDetail,
  changes: Record<string, unknown>,
  skillIds: string[],
  skillsTouched: boolean,
): ConfirmChange[] {
  const current: Record<string, string> = {
    role_title: posting.role_title,
    title: posting.role_title,
    description: text(posting.description),
    city: text(posting.city),
    area: text(posting.area),
    location_label: text(posting.location_label),
    pay_min: posting.pay_min === null ? "" : String(posting.pay_min),
    pay_max: posting.pay_max === null ? "" : String(posting.pay_max),
    vacancy_band: posting.vacancy_band,
    requirements: listText(posting.requirements),
    benefits: listText(posting.benefits),
  };
  const shown = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
    return String(value);
  };
  const rows: ConfirmChange[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (key === "clear") {
      for (const field of value as string[]) {
        rows.push({ label: LABELS[field] ?? field, before: current[field] ?? "—", after: "—" });
      }
      continue;
    }
    if (key === "match_skill_ids") {
      rows.push({
        label: "Match skills",
        before: "Current selection (not exposed)",
        after: skillsTouched && skillIds.length > 0 ? skillIds.join(", ") : "Cleared",
      });
      continue;
    }
    rows.push({
      label: LABELS[key] ?? key,
      before: current[key] ?? "—",
      after: shown(value),
    });
  }
  return rows;
}

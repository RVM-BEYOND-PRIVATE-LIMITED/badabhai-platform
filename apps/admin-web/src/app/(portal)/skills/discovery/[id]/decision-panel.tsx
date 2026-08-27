"use client";

import { useMemo, useState, useTransition } from "react";
import type { SkillSearchOutcome } from "../../../../../lib/skill-discovery-vocabulary";
import { useRouter } from "next/navigation";
import {
  ADMIN_SKILL_REVIEW_DECISIONS,
  ADMIN_SKILL_REVIEW_DECISION_LABELS,
  ADMIN_SKILL_REVIEW_REASON_MIN,
  SKILL_DECISION_CONFLICT_LABELS,
  skillDecisionClientErrors,
  type AdminSkillReviewDecision,
  type SkillCandidateStatus,
  type SkillDecisionOutcome,
  type SkillDecisionRequest,
} from "../../../../../lib/skill-discovery-vocabulary";
import { searchCanonicalSkillsAction, submitSkillDecisionAction } from "./actions";

/**
 * The five-button decision form (#1260).
 *
 * ── THE SUGGESTED ACTION IS A SUGGESTION, STRUCTURALLY ─────────────────────────────────
 * Nothing here is pre-selected, and there is deliberately NO `<form onSubmit>` wrapping the
 * five buttons — the reason field is a `<textarea>` (Enter inserts a newline, it does not
 * submit) and every button is `type="button"` with its own `onClick`. Clicking one of the
 * five only SELECTS it, revealing its own sub-fields; a second, separate "Record decision"
 * button fires the actual write. There is no path from a keystroke to a recorded decision.
 *
 * ── EACH BUTTON BUILDS A STRUCTURALLY DIFFERENT REQUEST ─────────────────────────────────
 * `buildRequest` returns the discriminated `SkillDecisionRequest` for whichever decision is
 * selected — a `create` request cannot carry `resulting_skill_id` and an `alias`/`merge`
 * request cannot carry `proposed_skill_name`, because the TYPE has no field for it. That is
 * what makes "send the wrong shape for this button" a compile error here, matching the
 * server's `.strict()` discriminated union.
 */
export function SkillDecisionPanel({
  candidateId,
  expectedStatus,
  sourceJobDomainIds,
  proposedSkillNameFromRun,
}: {
  candidateId: string;
  expectedStatus: SkillCandidateStatus;
  /** The candidate's own source job domains — pre-ticked for a `create` decision. */
  sourceJobDomainIds: string[];
  proposedSkillNameFromRun: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<AdminSkillReviewDecision | null>(null);
  const [reason, setReason] = useState("");
  const [resultingSkillId, setResultingSkillId] = useState("");
  const [skillName, setSkillName] = useState(proposedSkillNameFromRun ?? "");
  const [description, setDescription] = useState("");
  const [requirement, setRequirement] = useState<"required" | "preferred">("preferred");
  const [domainIds, setDomainIds] = useState<Set<string>>(new Set(sourceJobDomainIds));
  const [newDomainId, setNewDomainId] = useState("");
  const [outcome, setOutcome] = useState<SkillDecisionOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const request = useMemo<SkillDecisionRequest | null>(() => {
    if (!selected) return null;
    const base = { expected_status: expectedStatus, review_reason: reason };
    switch (selected) {
      case "create":
        return {
          decision: "create",
          ...base,
          proposed_skill_name: skillName,
          proposed_description: description.trim() ? description : undefined,
          approved_job_domain_ids: [...domainIds],
          approved_requirement: requirement,
        };
      case "alias":
        return { decision: "alias", ...base, resulting_skill_id: resultingSkillId };
      case "merge":
        return { decision: "merge", ...base, resulting_skill_id: resultingSkillId };
      case "reject":
        return { decision: "reject", ...base };
      case "hold":
        return { decision: "hold", ...base };
    }
  }, [
    selected,
    expectedStatus,
    reason,
    skillName,
    description,
    domainIds,
    requirement,
    resultingSkillId,
  ]);

  const clientErrors = request ? skillDecisionClientErrors(request) : [];

  function toggleDomain(id: string) {
    setDomainIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addDomain() {
    const id = newDomainId.trim();
    if (!id) return;
    setDomainIds((prev) => new Set(prev).add(id));
    setNewDomainId("");
  }

  function submit() {
    if (!request || clientErrors.length > 0 || pending) return;
    startTransition(async () => {
      const result = await submitSkillDecisionAction(candidateId, request);
      setOutcome(result);
      if (result.kind === "success") router.refresh();
    });
  }

  return (
    <section className="panel" aria-labelledby="sd-decision">
      <div className="panel__head">
        <h2 className="panel__title" id="sd-decision">
          Decision
        </h2>
      </div>

      <div className="filters--inline" role="group" aria-label="Decision">
        {ADMIN_SKILL_REVIEW_DECISIONS.map((decision) => (
          <button
            key={decision}
            type="button"
            aria-pressed={selected === decision}
            className={`btn btn--sm ${selected === decision ? "btn--primary" : "btn--ghost"}`}
            onClick={() => setSelected(decision)}
            disabled={pending}
          >
            {ADMIN_SKILL_REVIEW_DECISION_LABELS[decision].toUpperCase()}
          </button>
        ))}
      </div>

      {selected === "create" && (
        <div className="cols">
          <label className="field">
            <span className="field__label">New skill name</span>
            <input
              className="field__input"
              type="text"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              maxLength={120}
            />
          </label>
          <label className="field">
            <span className="field__label">Description (optional)</span>
            <input
              className="field__input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </label>
          <label className="field">
            <span className="field__label">Requirement for the ticked trades</span>
            <select
              className="field__input"
              value={requirement}
              onChange={(e) => setRequirement(e.target.value as "required" | "preferred")}
            >
              <option value="preferred">Preferred</option>
              <option value="required">Required</option>
            </select>
          </label>
          <fieldset className="field">
            <legend className="field__label">
              Trades this skill belongs to — at least one, required
            </legend>
            {sourceJobDomainIds.length === 0 ? (
              <p className="field__help">
                This candidate has no source job domain recorded. Add one below by id.
              </p>
            ) : null}
            {sourceJobDomainIds.map((id) => (
              <label className="field field--check" key={id}>
                <input
                  type="checkbox"
                  checked={domainIds.has(id)}
                  onChange={() => toggleDomain(id)}
                />
                <span className="field__label mono">{id}</span>
              </label>
            ))}
            {[...domainIds]
              .filter((id) => !sourceJobDomainIds.includes(id))
              .map((id) => (
                <label className="field field--check" key={id}>
                  <input type="checkbox" checked onChange={() => toggleDomain(id)} />
                  <span className="field__label mono">{id} (added)</span>
                </label>
              ))}
            <div className="filters__actions">
              <input
                className="field__input mono"
                type="text"
                placeholder="jd_…"
                value={newDomainId}
                onChange={(e) => setNewDomainId(e.target.value)}
              />
              <button className="btn btn--ghost btn--sm" type="button" onClick={addDomain}>
                Add trade
              </button>
            </div>
          </fieldset>
        </div>
      )}

      {(selected === "alias" || selected === "merge") && (
        <SkillTargetPicker
          label={
            selected === "alias"
              ? "Existing skill this is another name for"
              : "Existing skill this merges into"
          }
          value={resultingSkillId}
          onPick={setResultingSkillId}
        />
      )}

      <label className="field">
        <span className="field__label">
          Reviewer reason (required, at least {ADMIN_SKILL_REVIEW_REASON_MIN} characters)
        </span>
        <textarea
          className="field__input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </label>

      {selected && clientErrors.length > 0 && (
        <div className="alert alert--danger" role="alert">
          <div className="alert__text">
            <p className="alert__title">Cannot submit yet</p>
            <ul>
              {clientErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {selected && (
        <div className="filters__actions">
          <button
            className="btn btn--primary"
            type="button"
            onClick={submit}
            disabled={pending || clientErrors.length > 0}
          >
            {pending ? "Recording…" : `Record: ${ADMIN_SKILL_REVIEW_DECISION_LABELS[selected]}`}
          </button>
        </div>
      )}

      {outcome && <DecisionOutcomeNotice outcome={outcome} />}
    </section>
  );
}

/**
 * The result of one submission — a presentational component taking `outcome` as a prop, the
 * same shape `AdminActionResultBanner` uses, so the 409/error/success states are each
 * directly renderable from a crafted prop without needing to drive a click through jsdom
 * (this app's vitest environment is `node`, no DOM — see `AdminActionButton`'s own test file).
 */
export function DecisionOutcomeNotice({ outcome }: { outcome: SkillDecisionOutcome }) {
  if (outcome.kind === "conflict") {
    return (
      <div className="alert alert--danger" role="alert">
        <div className="alert__text">
          <p className="alert__title">This candidate moved since you loaded it</p>
          <p className="alert__body">{SKILL_DECISION_CONFLICT_LABELS[outcome.info.conflict]}</p>
          <p className="alert__body">
            Current status: <strong>{outcome.info.current_status}</strong>. You were looking at{" "}
            <strong>{outcome.info.expected_status}</strong>.
          </p>
        </div>
        <div className="alert__actions">
          <button
            className="btn btn--ghost btn--sm"
            type="button"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (outcome.kind === "error") {
    return (
      <div className="alert alert--danger" role="alert">
        <div className="alert__text">
          <p className="alert__title">Action failed</p>
          <p className="alert__body">{outcome.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`alert ${outcome.changed ? "alert--success" : "alert--info"}`} role="status">
      <div className="alert__text">
        <p className="alert__title">{outcome.changed ? "Decision recorded" : "No change"}</p>
        <p className="alert__body">
          {outcome.changed
            ? `Recorded. The taxonomy itself has not changed — this queues for the offline corpus chain.`
            : outcome.already_decided
              ? "This candidate was already in that exact state; nothing was written."
              : "Nothing changed."}
        </p>
      </div>
    </div>
  );
}

/**
 * THE MAP/MERGE TARGET PICKER — search the canonical corpus instead of typing an id.
 *
 * ══ IT SEARCHES THROUGH A SERVER ACTION ════════════════════════════════════════════════
 * The lookup runs on the server (`searchCanonicalSkillsAction` → `GET /admin/skills?q=`), never
 * from the browser. This console has no browser-side admin fetch anywhere and this picker does
 * not become the first one: the admin session lives in an httpOnly cookie the client bundle never
 * sees. It is also the ADMIN-authed route rather than the service-to-service skills seam, which a
 * browser must never reach for — wrong guard, no admin identity, no trace under the operator's
 * session.
 *
 * ══ INELIGIBLE RESULTS ARE SHOWN, NOT HIDDEN ═══════════════════════════════════════════
 * The route says which results may actually be mapped onto and why not, for the ones that cannot.
 * Filtering those out would leave a reviewer who searched for a skill they remember unable to tell
 * "no such skill" from "deprecated" from "that is match vocabulary" — and those need three
 * different actions. So they render, unselectable, with the server's own reason beside them.
 *
 * ══ TYPING AN ID IS STILL ALLOWED ══════════════════════════════════════════════════════
 * The field stays free text. The picker is a convenience over it, not a gate in front of it: a
 * reviewer who knows the id should not be blocked because the search is down, and the decision
 * route validates whatever id it is handed regardless. That is what keeps this a lookup rather
 * than a second authority on what is mappable.
 */
function SkillTargetPicker({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string;
  onPick: (skillId: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<SkillSearchOutcome | null>(null);
  const [searching, startSearch] = useTransition();

  function runSearch() {
    startSearch(async () => {
      setResult(await searchCanonicalSkillsAction(term));
    });
  }

  return (
    <div className="field">
      <span className="field__label">{label}</span>

      <div className="filters--inline">
        <input
          aria-label="Search canonical skills"
          className="field__input"
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by name, e.g. weld"
          type="search"
          value={term}
        />
        <button
          className="btn btn--sm btn--ghost"
          disabled={searching}
          onClick={runSearch}
          type="button"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {result?.error ? (
        <p className="field__help" role="status">
          {result.error} You can still type the skill id below.
        </p>
      ) : null}

      {result && !result.error ? (
        result.skills.length === 0 ? (
          <p className="field__help" role="status">
            No canonical skill matches “{result.q}”. That is an answer, not a failure — it may
            genuinely be a new competency.
          </p>
        ) : (
          <>
            <ul className="chips">
              {result.skills.map((skill) => (
                <li key={skill.skill_id}>
                  <button
                    className={`btn btn--sm ${value === skill.skill_id ? "btn--primary" : "btn--ghost"}`}
                    disabled={!skill.mappable}
                    onClick={() => onPick(skill.skill_id)}
                    title={skill.not_mappable_reason ?? undefined}
                    type="button"
                  >
                    {skill.label_en}
                    {skill.mappable ? "" : " — cannot be mapped onto"}
                  </button>
                  {skill.not_mappable_reason ? (
                    <span className="field__help">{skill.not_mappable_reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {result.truncated ? (
              <p className="field__help">
                More skills match than are shown. Type a longer term to narrow it.
              </p>
            ) : null}
          </>
        )
      ) : null}

      <input
        aria-label="Skill id"
        className="field__input mono"
        onChange={(e) => onPick(e.target.value)}
        placeholder="skill_…"
        type="text"
        value={value}
      />
      <span className="field__help">
        Pick a result above or type the id. The decision route checks it either way and refuses an
        unknown, deprecated or match-vocabulary skill with its own reason.
      </span>
    </div>
  );
}

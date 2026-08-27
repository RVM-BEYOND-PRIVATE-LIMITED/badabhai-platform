"use client";

import { useMemo, useState, useTransition } from "react";
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
import { submitSkillDecisionAction } from "./actions";

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
  }, [selected, expectedStatus, reason, skillName, description, domainIds, requirement, resultingSkillId]);

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
        <label className="field">
          <span className="field__label">
            {selected === "alias" ? "Existing skill this is another name for" : "Existing skill this merges into"}
          </span>
          <input
            className="field__input mono"
            type="text"
            value={resultingSkillId}
            onChange={(e) => setResultingSkillId(e.target.value)}
            placeholder="skill_…"
          />
        </label>
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
          <button className="btn btn--ghost btn--sm" type="button" onClick={() => location.reload()}>
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

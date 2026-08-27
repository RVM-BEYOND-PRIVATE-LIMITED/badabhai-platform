"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ADMIN_SKILL_REVIEW_DECISIONS,
  ADMIN_SKILL_REVIEW_DECISION_LABELS,
  ADMIN_SKILL_REVIEW_REASON_MIN,
  ADMIN_SKILLS_QUERY_MIN,
  SKILL_DECISION_CONFLICT_LABELS,
  skillDecisionClientErrors,
  type AdminSkillReviewDecision,
  type CanonicalSkillOption,
  type SkillCandidateStatus,
  type SkillDecisionOutcome,
  type SkillDecisionRequest,
} from "../../../../../lib/skill-discovery-vocabulary";
import { searchCanonicalSkillsAction, submitSkillDecisionAction } from "./actions";

/** How long to wait after the last keystroke before searching — long enough that a fast typist
 * never fires one request per character, short enough to still feel live. */
const SEARCH_DEBOUNCE_MS = 250;

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
        <SkillPicker
          label={
            selected === "alias"
              ? "Existing skill this is another name for"
              : "Existing skill this merges into"
          }
          value={resultingSkillId}
          onChange={setResultingSkillId}
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
 * The MAP/MERGE target picker (#1280) — replaces free-typing a `skill_id` by hand with a search
 * over `GET /admin/skills?q=`.
 *
 * ── ELIGIBILITY IS SHOWN, NEVER FILTERED ────────────────────────────────────────────────
 * A deprecated skill and a `match_skill` both come back from the search, disabled, with their
 * `not_mappable_reason` rendered — a reviewer who searches for a skill they remember and gets
 * nothing back cannot tell "no such skill" from "deprecated" from "that's match vocabulary".
 * Filtering client-side would undo exactly what the API's response shape exists to preserve.
 *
 * ── STALE RESPONSES ARE DISCARDED BY THE ECHOED `q`, NOT BY REQUEST ORDER ──────────────────
 * `latestQueryRef` records the query a search was actually DISPATCHED for; a response is only
 * rendered when its echoed `q` still matches that ref at the moment it resolves. Debouncing
 * already prevents most races (a new keystroke cancels the pending timer), but it cannot order
 * two REQUESTS already in flight — a slow response to an earlier keystroke can still resolve
 * after a fast response to a later one. Comparing against the ref (updated the instant a search
 * is dispatched, not when it resolves) is what keeps a stale result from ever overwriting a
 * fresher one.
 *
 * ── THE SELECTED ID IS ALSO A FREE FIELD, NEVER HIDDEN ──────────────────────────────────
 * `value` renders in a small mono confirmation line once chosen, with its own "Clear" — a
 * reviewer must be able to see and undo exactly which id the decision will carry, the same
 * transparency `resulting_skill_id` had as a raw text field before this replaced it.
 */
function SkillPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (skillId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CanonicalSkillOption[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const latestQueryRef = useRef("");

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < ADMIN_SKILLS_QUERY_MIN) {
      latestQueryRef.current = trimmed;
      setResults(null);
      setTruncated(false);
      setSearchError(null);
      return;
    }
    const handle = setTimeout(() => {
      latestQueryRef.current = trimmed;
      startSearch(async () => {
        const outcome = await searchCanonicalSkillsAction(trimmed);
        // A response for a query that is no longer the latest one dispatched — discard it
        // rather than let a slow answer to an old keystroke overwrite a fresh one.
        if (outcome.kind === "success" && outcome.q !== latestQueryRef.current) return;
        if (outcome.kind === "error") {
          setSearchError(outcome.message);
          setResults(null);
          return;
        }
        setSearchError(null);
        setResults(outcome.skills);
        setTruncated(outcome.truncated);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      {value ? (
        <div className="filters__actions">
          <span className="chip mono">{value}</span>
          <button
            className="btn btn--ghost btn--sm"
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear selected skill"
          >
            Clear
          </button>
        </div>
      ) : (
        <>
          <input
            className="field__input"
            type="text"
            role="searchbox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the canonical skill catalogue…"
            aria-describedby="skill-picker-help"
          />
          <span className="field__help" id="skill-picker-help">
            {query.trim().length > 0 && query.trim().length < ADMIN_SKILLS_QUERY_MIN
              ? `Type at least ${ADMIN_SKILLS_QUERY_MIN} characters to search.`
              : "Case-insensitive, matches anywhere in the skill name."}
          </span>
          {searching && <p className="field__help">Searching…</p>}
          {searchError && (
            <p className="field__help" role="alert">
              {searchError}
            </p>
          )}
          {results && results.length === 0 && !searching && (
            <p className="field__help">No skill matches that search.</p>
          )}
          {results && results.length > 0 && (
            <ul className="chips" role="listbox" aria-label="Matching skills">
              {results.map((s) => (
                <li key={s.skill_id}>
                  <button
                    className="btn btn--ghost btn--sm"
                    type="button"
                    disabled={!s.mappable}
                    title={s.not_mappable_reason ?? undefined}
                    onClick={() => onChange(s.skill_id)}
                  >
                    <strong>{s.label_en}</strong> <span className="mono table__meta">{s.skill_id}</span>
                    {!s.mappable && s.not_mappable_reason ? ` — ${s.not_mappable_reason}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {truncated && (
            <p className="field__help">
              More than {results?.length ?? 0} matches — narrow the search to see the rest.
            </p>
          )}
        </>
      )}
    </div>
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

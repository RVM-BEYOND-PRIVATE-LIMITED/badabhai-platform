"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { AdminActionButton } from "../../../../components/admin-action-button";
import {
  AdminActionResultBanner,
} from "../../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";
import type { MatchSkillVocabulary } from "../../../../lib/agency-jobs";
import { setAgencyJobMatchSkillsAction } from "./actions";

/**
 * The match-skill picker for one agency posting. Checkbox multi-select over
 * the SERVER's vocabulary (`GET /admin/match/skills` via the detail page) —
 * ids are never typed, so an unknown id cannot reach the API from this UI
 * (the action re-checks the shape anyway: UI gates are UX, not enforcement).
 *
 * The runtime cap rides the same vocabulary read; when it is absent (older
 * backend) no client-side count check runs and the server's 400 renders
 * verbatim in the banner. Either way the API is the authority.
 */
export function MatchSkillForm({
  jobId,
  current,
  vocabulary,
}: {
  jobId: string;
  current: readonly string[];
  vocabulary: MatchSkillVocabulary;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<readonly string[]>([...current]);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const cap = vocabulary.max_skills_per_posting ?? null;
  const overCap = cap !== null && selected.length > cap;
  // The vocabulary is the closed set: anything selected that it does not
  // name is a stale id from before a rename — submittable (the server
  // decides), but never rendered as a checked row here.
  const known = new Set(vocabulary.skills.map((s) => s.skill_id));
  const stale = selected.filter((id) => !known.has(id));

  function toggle(skillId: string) {
    setOutcome(null);
    setSelected((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId],
    );
  }

  function unchanged(): boolean {
    if (selected.length !== current.length) return false;
    return selected.every((id) => current.includes(id));
  }

  return (
    <div>
      <fieldset className="checklist" disabled={pending}>
        <legend className="kv__k">
          Match skills{cap !== null ? ` (at most ${cap})` : ""} — {selected.length} selected
        </legend>
        {vocabulary.skills.map((skill) => (
          <label className="checklist__row" key={skill.skill_id}>
            <input
              type="checkbox"
              checked={selected.includes(skill.skill_id)}
              onChange={() => toggle(skill.skill_id)}
            />
            <span>
              {skill.label} <span className="mono table__meta">{skill.skill_id}</span>
            </span>
          </label>
        ))}
        {/* Saved ids the vocabulary no longer names (renamed upstream): shown
            raw and untickable, never silently kept and never silently dropped. */}
        {stale.map((id) => (
          <label className="checklist__row" key={id}>
            <input type="checkbox" checked={true} onChange={() => toggle(id)} />
            <span>
              <span className="mono">{id}</span>{" "}
              <span className="table__meta">(unrecognized — untick to drop)</span>
            </span>
          </label>
        ))}
      </fieldset>
      {overCap ? (
        <p className="alert__body" role="alert">
          A posting may name at most {cap} skills ({selected.length} selected).
        </p>
      ) : null}
      <div className="form__actions">
        <AdminActionButton
          label="Save match skills"
          confirmLabel={`Save ${selected.length} match skills?`}
          variant="primary"
          disabled={pending || overCap || unchanged()}
          action={() =>
            setAgencyJobMatchSkillsAction(jobId, {
              // Stale ids ride along untouched: clearing them silently would
              // delete data the operator never saw.
              match_skill_ids: [...selected],
            })
          }
          onSettled={(next) => {
            setOutcome(next);
            if (next.ok) {
              startTransition(() => {
                router.refresh();
              });
            }
          }}
        />
      </div>
      {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={null} /> : null}
    </div>
  );
}

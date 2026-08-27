"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  SKILL_CANDIDATE_ACTIONS,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_CONFIDENCE_BANDS,
  SKILL_CANDIDATE_SOURCE_TYPES,
  SKILL_CANDIDATE_SOURCE_TYPE_LABELS,
} from "../../../../lib/skill-discovery-vocabulary";
import type { AdminSkillDiscoverySort } from "../../../../lib/skill-discovery";

export interface SkillDiscoveryFilterValues {
  band: string;
  proposedAction: string;
  tradeFamily: string;
  sourceType: string;
  runId: string;
  clusterKey: string;
  phrase: string;
  createdFrom: string;
  createdTo: string;
  sort: AdminSkillDiscoverySort;
}

/**
 * Every filter field the query schema offers, minus `status` and `tier` — those get their own
 * dedicated, always-visible chips/tabs above this bar (issue requirement: tier sequencing must
 * be VISIBLE, not buried in an expandable form) and are carried through via hidden state so
 * submitting this form never drops them.
 *
 * A plain HTML `<form method="GET">` would submit every field verbatim, including the ones left
 * on their empty default — `?band=` reaches the server's `.strict()` enum as an unrecognised
 * empty string and 400s, exactly the trap `WorkerFilterBar`'s own comment names. So this stays
 * client-side and OMITS empty values before navigating, the same rule `qs()` and
 * `skillDiscoveryQs()` both apply server-side.
 */
export function SkillDiscoveryFilterBar({
  basePath,
  carry,
  initial,
}: {
  basePath: string;
  /** Everything this form must not drop: view, statusScope/status, tier, cursor is dropped. */
  carry: Record<string, string | undefined>;
  initial: SkillDiscoveryFilterValues;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);

  function set<K extends keyof SkillDiscoveryFilterValues>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(carry)) if (v) q.set(k, v);
    for (const [k, v] of Object.entries(values)) if (v) q.set(k, v);
    const qs = q.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  function clearAll() {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(carry)) if (v) q.set(k, v);
    const qs = q.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <form className="filters" onSubmit={submit} role="search" aria-label="Queue filters">
      <label className="field">
        <span className="field__label">Confidence band</span>
        <select
          className="field__input"
          value={values.band}
          onChange={(e) => set("band", e.target.value)}
        >
          <option value="">Any</option>
          {SKILL_CANDIDATE_CONFIDENCE_BANDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Suggested action</span>
        <select
          className="field__input"
          value={values.proposedAction}
          onChange={(e) => set("proposedAction", e.target.value)}
        >
          <option value="">Any</option>
          {SKILL_CANDIDATE_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {SKILL_CANDIDATE_ACTION_LABELS[a]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Source type</span>
        <select
          className="field__input"
          value={values.sourceType}
          onChange={(e) => set("sourceType", e.target.value)}
        >
          <option value="">Any</option>
          {SKILL_CANDIDATE_SOURCE_TYPES.map((s) => (
            <option key={s} value={s}>
              {SKILL_CANDIDATE_SOURCE_TYPE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Trade family</span>
        <input
          className="field__input"
          type="text"
          value={values.tradeFamily}
          onChange={(e) => set("tradeFamily", e.target.value)}
          placeholder="e.g. Plumbers and Pipe Fitters"
        />
      </label>

      <label className="field">
        <span className="field__label">Run id</span>
        <input
          className="field__input mono"
          type="text"
          value={values.runId}
          onChange={(e) => set("runId", e.target.value)}
          placeholder="sdr_…"
        />
      </label>

      <label className="field">
        <span className="field__label">Cluster key</span>
        <input
          className="field__input mono"
          type="text"
          value={values.clusterKey}
          onChange={(e) => set("clusterKey", e.target.value)}
          placeholder="only meaningful with a run id"
        />
      </label>

      <label className="field">
        <span className="field__label">Phrase starts with</span>
        <input
          className="field__input"
          type="text"
          value={values.phrase}
          onChange={(e) => set("phrase", e.target.value)}
          placeholder="e.g. arc weld"
        />
        <span className="field__help">
          An anchored prefix match on the normalized phrase — not a substring search.
        </span>
      </label>

      <label className="field">
        <span className="field__label">Created from</span>
        <input
          className="field__input"
          type="date"
          value={values.createdFrom}
          onChange={(e) => set("createdFrom", e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field__label">Created to</span>
        <input
          className="field__input"
          type="date"
          value={values.createdTo}
          onChange={(e) => set("createdTo", e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field__label">Sort</span>
        <select
          className="field__input"
          value={values.sort}
          onChange={(e) => set("sort", e.target.value as AdminSkillDiscoverySort)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first — the backlog's own risk order</option>
        </select>
      </label>

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          Apply
        </button>
        <button className="btn btn--ghost" type="button" onClick={clearAll}>
          Clear filters
        </button>
      </div>
    </form>
  );
}

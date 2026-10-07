"use client";

import { useUrlState } from "../../../../components/use-url-state";
import { SubmitPendingCue, usePendingPush } from "../../../../components/nav-pending";
import {
  SKILL_CANDIDATE_ACTIONS,
  SKILL_CANDIDATE_ACTION_LABELS,
  SKILL_CANDIDATE_CONFIDENCE_BANDS,
  SKILL_CANDIDATE_SOURCE_TYPES,
  SKILL_CANDIDATE_SOURCE_TYPE_LABELS,
} from "../../../../lib/skill-discovery-vocabulary";
import type { AdminSkillDiscoverySort } from "../../../../lib/skill-discovery";
import { ACTION_ICON, Icon } from "@badabhai/icons";

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

/** This bar's own fields, by URL key. A value here always comes from the form, never from carry. */
const BAR_FIELDS: readonly (keyof SkillDiscoveryFilterValues)[] = [
  "band",
  "proposedAction",
  "tradeFamily",
  "sourceType",
  "runId",
  "clusterKey",
  "phrase",
  "createdFrom",
  "createdTo",
  "sort",
];

/** The bar with none of its fields set — what a URL without them shows (Newest first). */
const CLEARED: SkillDiscoveryFilterValues = {
  band: "",
  proposedAction: "",
  tradeFamily: "",
  sourceType: "",
  runId: "",
  clusterKey: "",
  phrase: "",
  createdFrom: "",
  createdTo: "",
  sort: "newest",
};

/**
 * Where the bar navigates: `carry` (the controls above the bar) plus the bar's own non-empty
 * fields. Pass `values = null` to clear the bar's fields and keep everything else.
 *
 * A carried key that names one of the bar's OWN fields is ignored. The page used to pass its
 * whole current query as `carry`, bar fields included, and carry was written first while empty
 * values were skipped — so emptying a field and pressing Apply kept the old value from the URL,
 * and "Clear" re-applied every field it was meant to clear. The bar owns its fields outright.
 */
export function filterBarHref(
  basePath: string,
  carry: Record<string, string | undefined>,
  values: SkillDiscoveryFilterValues | null,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(carry)) {
    if (v && !(BAR_FIELDS as readonly string[]).includes(k)) q.set(k, v);
  }
  if (values) for (const k of BAR_FIELDS) if (values[k]) q.set(k, values[k]);
  const qs = q.toString();
  return qs ? `${basePath}?${qs}` : basePath;
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
  view,
  carry,
  initial,
}: {
  basePath: string;
  /**
   * The queue view this bar serves. The Sort field orders the FLAT view's keyset pages only;
   * grouped batches are ordered by the Batch order chips, so the grouped view does not show it
   * (final sweep AW-23). Its value is still the bar's own and still travels on Apply.
   */
  view: "grouped" | "flat";
  /**
   * The controls above this bar that it must not drop — view, statusScope/status, tier, batch
   * order. Never the bar's own fields (ignored if present); the cursor is never carried.
   */
  carry: Record<string, string | undefined>;
  initial: SkillDiscoveryFilterValues;
}) {
  // Navigates in a transition, so Apply can show that the new list is on its way — the same
  // signal a link gives, with no loading boundary (components/nav-pending.tsx).
  const [pending, push] = usePendingPush();
  const [values, setValues] = useUrlState(initial);

  function set<K extends keyof SkillDiscoveryFilterValues>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    push(filterBarHref(basePath, carry, values));
  }

  /**
   * Empties this bar's fields and keeps the status, tier and view chosen above it. It empties
   * them HERE as well as in the URL: when the URL carries none of them already, the navigation
   * goes to the same URL, the fields' sync key does not change, and typed-but-unapplied values
   * would stay on screen (review of #2046).
   */
  function clearFields() {
    setValues(CLEARED);
    push(filterBarHref(basePath, carry, null));
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

      {view === "flat" && (
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
      )}

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          <Icon name={ACTION_ICON.filter} />
          Apply
          <SubmitPendingCue pending={pending} message="Applying the filters…" />
        </button>
        {/* Not "Clear filters": that name goes to the bare route everywhere else in the
            portal, and this keeps the status, tier and view above. */}
        <button className="btn btn--ghost" type="button" onClick={clearFields}>
          <Icon name={ACTION_ICON.clearFilters} />
          Clear these fields
        </button>
      </div>
    </form>
  );
}

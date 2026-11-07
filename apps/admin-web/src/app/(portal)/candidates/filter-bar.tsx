"use client";

import { SubmitPendingCue, usePendingPush } from "../../../components/nav-pending";
import { useUrlState } from "../../../components/use-url-state";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  ADMIN_CANDIDATES_PAGE_SIZES,
  CANDIDATE_SEARCH_SORTS,
  type CandidateSearchParams,
} from "../../../lib/candidate-search";

/**
 * The Candidates data-bank filters (A7, #2577) — every `#2559` filter the search serves,
 * plus the list's sort, direction and page size.
 *
 * A plain form that writes the filters into the URL and lets the Server Component re-render,
 * so there is no second copy of the query logic (the events bar's contract). Submitting drops
 * the page number: page three of one query applied to another returns an arbitrary slice of
 * it, which looks like data rather than like an error.
 *
 * ── WHAT IS NOT HERE ──────────────────────────────────────────────────────────────
 * The universal search box. It POSTs its term to the same-origin search route (the term
 * travels in the body only — never a URL), so it is its own component (`candidate-search-box`).
 * This bar holds only the filters the address may carry.
 *
 * Multi-value filters are comma-separated in one field (`status=active,suspended`), matching
 * the address the sort links and the pager keep.
 */
const FLAG_OPTIONS = [
  { value: "", label: "Any" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

export function CandidateFilterBar({ params }: { params: CandidateSearchParams }) {
  // Navigates in a transition, so Apply can show that the new list is on its way — the same
  // signal a link gives, with no loading boundary (components/nav-pending.tsx).
  const [pending, push] = usePendingPush();
  const initial = {
    status: params.filters.status?.join(",") ?? "",
    trade_id: params.filters.trade_id?.join(",") ?? "",
    role_id: params.filters.role_id?.join(",") ?? "",
    state: params.filters.state?.join(",") ?? "",
    city: params.filters.city?.join(",") ?? "",
    language: params.filters.language?.join(",") ?? "",
    profile_status: params.filters.profile_status?.join(",") ?? "",
    form_level: params.filters.form_level?.join(",") ?? "",
    min_experience_years: params.filters.min_experience_years ?? "",
    max_experience_years: params.filters.max_experience_years ?? "",
    role_experience_months_min: params.filters.role_experience_months_min ?? "",
    role_experience_months_max: params.filters.role_experience_months_max ?? "",
    has_resume: params.filters.has_resume ?? "",
    last_active_from: params.filters.last_active_from ?? "",
    last_active_to: params.filters.last_active_to ?? "",
    registered_from: params.filters.registered_from ?? "",
    registered_to: params.filters.registered_to ?? "",
    deletion_scheduled: params.filters.deletion_scheduled ?? "",
    flagged: params.filters.flagged ?? "",
    is_test_account: params.filters.is_test_account ?? "",
    sort: params.sort,
    dir: params.dir,
    page_size: String(params.pageSize),
  };
  const [values, setValues] = useUrlState(initial);
  const set = (key: keyof typeof initial) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setValues((v) => ({ ...v, [key]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) {
      const t = v.trim();
      if (!t) continue;
      // Defaults ride bare: the address stays shareable and short.
      if (k === "sort" && t === "last_active_at") continue;
      if (k === "dir" && t === "desc") continue;
      if (k === "page_size" && t === "50") continue;
      q.set(k, t);
    }
    const qs = q.toString();
    push(qs ? `/candidates?${qs}` : "/candidates");
  }

  return (
    <form className="filters" onSubmit={submit} role="search">
      <label className="field">
        <span className="field__label">Status</span>
        <input
          className="field__input"
          value={values.status}
          onChange={set("status")}
          placeholder="e.g. active,suspended"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Trade</span>
        <input
          className="field__input"
          value={values.trade_id}
          onChange={set("trade_id")}
          placeholder="e.g. dom_welding"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Role</span>
        <input
          className="field__input"
          value={values.role_id}
          onChange={set("role_id")}
          placeholder="e.g. role_tig_welder"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">State</span>
        <input
          className="field__input"
          value={values.state}
          onChange={set("state")}
          placeholder="e.g. Maharashtra"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">City</span>
        <input
          className="field__input"
          value={values.city}
          onChange={set("city")}
          placeholder="e.g. Pune,Mumbai"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Language</span>
        <input
          className="field__input"
          value={values.language}
          onChange={set("language")}
          placeholder="e.g. hi,mr"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Profile</span>
        <input
          className="field__input"
          value={values.profile_status}
          onChange={set("profile_status")}
          placeholder="e.g. confirmed,extracting"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Form level</span>
        <select className="field__input" value={values.form_level} onChange={set("form_level")}>
          <option value="">Any</option>
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Min experience (years)</span>
        <input
          className="field__input"
          type="number"
          min={0}
          max={60}
          value={values.min_experience_years}
          onChange={set("min_experience_years")}
          placeholder="e.g. 2"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Max experience (years)</span>
        <input
          className="field__input"
          type="number"
          min={0}
          max={60}
          value={values.max_experience_years}
          onChange={set("max_experience_years")}
          placeholder="e.g. 10"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Min role experience (months)</span>
        <input
          className="field__input"
          type="number"
          min={0}
          max={1200}
          value={values.role_experience_months_min}
          onChange={set("role_experience_months_min")}
          placeholder="e.g. 12"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Max role experience (months)</span>
        <input
          className="field__input"
          type="number"
          min={0}
          max={1200}
          value={values.role_experience_months_max}
          onChange={set("role_experience_months_max")}
          placeholder="e.g. 120"
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">Has a Resume</span>
        <select className="field__input" value={values.has_resume} onChange={set("has_resume")}>
          {FLAG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Active from</span>
        <input
          className="field__input"
          type="date"
          value={values.last_active_from}
          onChange={set("last_active_from")}
        />
      </label>

      <label className="field">
        <span className="field__label">Active to</span>
        <input
          className="field__input"
          type="date"
          value={values.last_active_to}
          onChange={set("last_active_to")}
        />
      </label>

      <label className="field">
        <span className="field__label">Registered from</span>
        <input
          className="field__input"
          type="date"
          value={values.registered_from}
          onChange={set("registered_from")}
        />
      </label>

      <label className="field">
        <span className="field__label">Registered to</span>
        <input
          className="field__input"
          type="date"
          value={values.registered_to}
          onChange={set("registered_to")}
        />
      </label>

      <label className="field">
        <span className="field__label">Deletion scheduled</span>
        <select
          className="field__input"
          value={values.deletion_scheduled}
          onChange={set("deletion_scheduled")}
        >
          {FLAG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Flagged</span>
        <select className="field__input" value={values.flagged} onChange={set("flagged")}>
          {FLAG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Test account</span>
        <select
          className="field__input"
          value={values.is_test_account}
          onChange={set("is_test_account")}
        >
          {FLAG_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Sort by</span>
        <select className="field__input" value={values.sort} onChange={set("sort")}>
          {CANDIDATE_SEARCH_SORTS.map((s) => (
            <option key={s} value={s}>
              {sortLabel(s)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">Direction</span>
        <select className="field__input" value={values.dir} onChange={set("dir")}>
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">Per page</span>
        <select className="field__input" value={values.page_size} onChange={set("page_size")}>
          {ADMIN_CANDIDATES_PAGE_SIZES.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <div className="filters__actions">
        <button className="btn btn--primary" type="submit">
          <Icon name={ACTION_ICON.filter} />
          Apply
          <SubmitPendingCue pending={pending} message="Applying the filters…" />
        </button>
      </div>
    </form>
  );
}

/** A sort key in words — the closed list, de-snaked, never blanked. */
function sortLabel(sort: string): string {
  return sort
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

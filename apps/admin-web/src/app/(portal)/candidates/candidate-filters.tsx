"use client";

import { ACTION_ICON, Icon } from "@badabhai/icons";
import { FilterPanel } from "../../../components/filter-panel";
import { useUrlState } from "../../../components/use-url-state";
import {
  candidateFilterChips,
  candidateFiltersToForm,
  candidateFormToFilters,
  withoutFilterChip,
  type CandidateFilterChip,
  type CandidateFacet,
  type CandidateSearchFilters,
} from "../../../lib/candidate-search-model";

/**
 * The Candidates filter panel (A7, #2577): every filter `POST /admin/candidates/search` accepts,
 * in one disclosure that folds on a phone (`FilterPanel`). The common fields show; the rest sit
 * under "More filters" so the first row of results stays within reach (the A4/AW-08 rule).
 *
 * The form is a DRAFT: changing a field changes nothing until Apply, so a half-typed trade id
 * never spends a search cap. Apply commits the filters to the list (which resets to page 1).
 */
export function CandidateFilters({
  filters,
  counts,
  onApply,
}: {
  filters: CandidateSearchFilters;
  counts?: {
    by_status: CandidateFacet[];
    by_trade: CandidateFacet[];
    by_city: CandidateFacet[];
    by_profile_status: CandidateFacet[];
  };
  onApply: (filters: CandidateSearchFilters) => void;
}) {
  const [form, setForm] = useUrlState(candidateFiltersToForm(filters), JSON.stringify(filters));

  function set(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    onApply(candidateFormToFilters(form));
  }

  const field = (
    key: string,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        value={form[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
        autoComplete="off"
        {...props}
      />
    </label>
  );

  const tri = (key: string, label: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <select
        className="field__input"
        value={form[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
      >
        <option value="">Any</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </label>
  );

  return (
    <div className="bank-filters">
      <FilterPanel
        headingId="cf-heading"
        heading="Filter candidates"
        filters={candidateFiltersToForm(filters)}
      >
        <form className="filters" onSubmit={submit} role="search">
          <label className="field">
            <span className="field__label">Status</span>
            <select
              className="field__input"
              value={form.status ?? ""}
              onChange={(e) => set("status", e.target.value)}
            >
              <option value="">Any</option>
              {statusOptions(counts?.by_status).map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>

          {field("trade_id", "Trade id", { placeholder: "dom_welder", list: "cf-trades" })}
          <datalist id="cf-trades">
            {(counts?.by_trade ?? []).map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.count} candidates
              </option>
            ))}
          </datalist>

          {field("role_id", "Role id", { placeholder: "role_tig_welder" })}
          {field("min_experience_years", "Min experience (yrs)", {
            type: "number",
            min: 0,
            max: 60,
            step: 0.5,
          })}
          {field("max_experience_years", "Max experience (yrs)", {
            type: "number",
            min: 0,
            max: 60,
            step: 0.5,
          })}
          {field("state", "State", { placeholder: "Maharashtra" })}
          {field("city", "City", { placeholder: "Pune", list: "cf-cities" })}
          <datalist id="cf-cities">
            {(counts?.by_city ?? []).map((facet) => (
              <option key={facet.value} value={facet.value}>
                {facet.count} candidates
              </option>
            ))}
          </datalist>

          <label className="field">
            <span className="field__label">Profile</span>
            <select
              className="field__input"
              value={form.profile_status ?? ""}
              onChange={(e) => set("profile_status", e.target.value)}
            >
              <option value="">Any</option>
              {profileOptions(counts?.by_profile_status).map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>

          {tri("has_resume", "Has a resume")}

          <details className="bank-filters__more">
            <summary className="btn btn--ghost btn--sm">
              <Icon name={ACTION_ICON.disclosure} className="disclosure__caret" />
              More filters
            </summary>
            <div className="filters bank-filters__more-grid">
              {field("language", "Language", { placeholder: "hindi" })}
              {field("role_experience_months_min", "Role experience min (months)", {
                type: "number",
                min: 0,
                max: 1200,
                step: 1,
              })}
              {field("role_experience_months_max", "Role experience max (months)", {
                type: "number",
                min: 0,
                max: 1200,
                step: 1,
              })}
              <label className="field">
                <span className="field__label">Form level</span>
                <select
                  className="field__input"
                  value={form.form_level ?? ""}
                  onChange={(e) => set("form_level", e.target.value)}
                >
                  <option value="">Any</option>
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
              {field("last_active_from", "Active from", { type: "date" })}
              {field("last_active_to", "Active before", { type: "date" })}
              {field("registered_from", "Registered from", { type: "date" })}
              {field("registered_to", "Registered before", { type: "date" })}
              {tri("deletion_scheduled", "Deletion scheduled")}
              {tri("flagged", "Flagged")}
              {tri("is_test_account", "Test account")}
            </div>
          </details>

          <div className="filters__actions">
            <button className="btn btn--primary" type="submit">
              <Icon name={ACTION_ICON.filter} />
              Apply filters
            </button>
          </div>
        </form>
      </FilterPanel>

      <CandidateFilterChips
        chips={candidateFilterChips(filters)}
        onRemove={(chip) => {
          const next = withoutFilterChip(filters, chip);
          setForm(candidateFiltersToForm(next));
          onApply(next);
        }}
      />
    </div>
  );
}

/** The status values the API knows, plus any facet value it returned this time. */
function statusOptions(facets: CandidateFacet[] | undefined): string[] {
  const fixed = ["pending", "active", "suspended"];
  const extra = (facets ?? []).map((f) => f.value).filter((v) => !fixed.includes(v));
  return [...fixed, ...extra];
}

/** The profile states known to the drawer, plus any facet value returned. */
function profileOptions(facets: CandidateFacet[] | undefined): string[] {
  const fixed = ["draft", "in_progress", "confirmed", "complete"];
  const extra = (facets ?? []).map((f) => f.value).filter((v) => !fixed.includes(v));
  return [...fixed, ...extra];
}

/** The active filters as removable chips, with the #2577 add/remove motion. */
export function CandidateFilterChips({
  chips,
  onRemove,
}: {
  chips: readonly CandidateFilterChip[];
  onRemove: (chip: CandidateFilterChip) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <ul className="chiprow bank-chips" aria-label="Active filters">
      {chips.map((chip) => (
        <li key={`${chip.key}:${chip.value ?? ""}`}>
          <button
            type="button"
            className="chip chip--action bank-chip"
            onClick={() => onRemove(chip)}
            aria-label={`Remove filter ${chip.label}`}
          >
            {chip.label}
            <span aria-hidden="true" className="bank-chip__x">
              ×
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

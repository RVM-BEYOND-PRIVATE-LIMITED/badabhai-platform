import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Button, Checkbox, Select } from "../../../components/ds";
import { PortalLink } from "../../../components/portal-link";
import type { CandidateFilters } from "../../../lib/contracts";
import {
  CANDIDATE_SEARCH_PATH,
  SEARCH_PARAM,
  STRICT_ON,
  type CandidateSearchQuery,
} from "../../../lib/candidate-search";

/**
 * The ALL CANDIDATES filter — the page head's toolbar row, under the view switch.
 *
 * A PLAIN `GET` form, server-rendered, with no client code: "Show" submits `?role=&exp=&industry=
 * &indexp=&city=` (and `&strict=1` when "Only show matches" is ticked) to `/candidates` — the
 * browser's own navigation, so it works before hydration and never waits on a router transition.
 * The form carries no cursor, so a new filter starts at the first page (a cursor is a position in
 * the order the filters minted, never a filter). Each select's "Any …" submits an empty value,
 * which the page reads as no filter. Choosing an option is never a navigation (WCAG 3.2.2).
 *
 * FILTERS REORDER, they do not remove (ADR-0040 Decision 1): matches lead, everyone else follows.
 * "Only show matches" is the explicit opt-in that drops the rest (Decision 2) — unticked on every
 * page that did not ask for it, never remembered.
 *
 * THE OPTIONS ARE THE SERVER'S (`GET /payer/candidates/filters`): roles, industries, the experience
 * buckets and the cities the pool records — no copy is kept here. `options` null = that read
 * failed: every control offers only "Any …", and one calm line says why (the page then sends no
 * filter, so the controls tell the truth about the list). `ignored` counts params in the address no
 * control offers (a stale or hand-edited link): they were not sent, and one calm line says so.
 * "Clear filters" shows whenever the address holds something to clear.
 */
export const SEARCH_FILTER_IDS = {
  role: "candidate-search-role",
  experience: "candidate-search-exp",
  industry: "candidate-search-industry",
  industryExperience: "candidate-search-indexp",
  city: "candidate-search-city",
} as const;
const UNAVAILABLE_NOTE_ID = "candidate-search-options-note";

export function CandidateSearchFilter({
  options,
  selected,
  ignored,
  clearable,
}: {
  /** The filter options, or null when the options read failed. */
  options: CandidateFilters | null;
  /** The filters the list below was read with (only offered values). */
  selected: CandidateSearchQuery;
  /** How many params in the address were ignored (not offered, or malformed). */
  ignored: number;
  /** The address holds a filter (or an ignored param) to clear. */
  clearable: boolean;
}) {
  const unavailable = options === null;
  const describedBy = unavailable ? UNAVAILABLE_NOTE_ID : undefined;
  const buckets = options?.experienceBuckets ?? [];
  return (
    <div className="candidates-filter">
      <form
        className="candidates-filter__form"
        method="get"
        action={CANDIDATE_SEARCH_PATH}
        role="search"
        aria-label="Filter all candidates"
      >
        <Select
          id={SEARCH_FILTER_IDS.role}
          name={SEARCH_PARAM.role}
          label="Role"
          defaultValue={selected.role ?? ""}
          aria-describedby={describedBy}
        >
          <option value="">Any role</option>
          {(options?.roles ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          id={SEARCH_FILTER_IDS.experience}
          name={SEARCH_PARAM.experience}
          label="Years in role"
          defaultValue={selected.experience ?? ""}
          aria-describedby={describedBy}
        >
          <option value="">Any years</option>
          {buckets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </Select>
        <Select
          id={SEARCH_FILTER_IDS.industry}
          name={SEARCH_PARAM.industry}
          label="Industry"
          defaultValue={selected.industry ?? ""}
          aria-describedby={describedBy}
        >
          <option value="">Any industry</option>
          {(options?.industries ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </Select>
        <Select
          id={SEARCH_FILTER_IDS.industryExperience}
          name={SEARCH_PARAM.industryExperience}
          label="Years in industry"
          defaultValue={selected.industryExperience ?? ""}
          aria-describedby={describedBy}
        >
          <option value="">Any years</option>
          {buckets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </Select>
        <Select
          id={SEARCH_FILTER_IDS.city}
          name={SEARCH_PARAM.city}
          label="City"
          defaultValue={selected.city ?? ""}
          aria-describedby={describedBy}
        >
          <option value="">Any city</option>
          {(options?.cities ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Checkbox
          name={SEARCH_PARAM.strict}
          value={STRICT_ON}
          defaultChecked={selected.strict}
          label="Only show matches"
        />
        <div className="candidates-filter__actions">
          <Button type="submit" variant="secondary" iconLeft={ACTION_ICON.filter}>
            Show
          </Button>
          {clearable ? (
            <PortalLink
              className="bb-btn bb-btn--ghost"
              href={CANDIDATE_SEARCH_PATH}
              pendingLabel="All candidates"
            >
              <Icon name={ACTION_ICON.clearFilters} />
              <span>Clear filters</span>
            </PortalLink>
          ) : null}
        </div>
      </form>
      {unavailable ? (
        <p className="candidates-filter__note" id={UNAVAILABLE_NOTE_ID}>
          The filter options didn&rsquo;t load, so only &ldquo;Any&rdquo; is offered and the list
          isn&rsquo;t filtered — reload the page to try again.
        </p>
      ) : null}
      {ignored > 0 ? (
        <p className="candidates-filter__note">
          {ignored === 1
            ? "A filter in this link isn’t available, so it was ignored."
            : "Some filters in this link aren’t available, so they were ignored."}
        </p>
      ) : null}
    </div>
  );
}

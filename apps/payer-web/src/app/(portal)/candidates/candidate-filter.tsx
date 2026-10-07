import { ACTION_ICON } from "@badabhai/icons";
import { Button, Select } from "../../../components/ds";
import {
  CANDIDATES_PATH,
  POSTING_FILTER_PARAM,
  type PostingOption,
} from "../../../lib/candidate-inbox";

/**
 * The Candidates posting filter — the page head's toolbar row.
 *
 * A PLAIN `GET` form, server-rendered, with no client code: "Show" submits `?postingId=` to
 * `/candidates` (the browser's own navigation, so it works before hydration and never waits on a
 * router transition). The submitted form drops `cursor`, so a new filter starts at the newest page.
 * "All postings" submits an empty value, which the page reads as no filter.
 *
 * A select changes nothing until "Show" is pressed — choosing an option is never a navigation
 * (WCAG 3.2.2). The options are the payer's OWN postings, from the list read the page already
 * makes; `unavailable` says that read failed, so "All postings" is the only real choice.
 */
export const CANDIDATE_FILTER_SELECT_ID = "candidates-posting";
const UNAVAILABLE_NOTE_ID = "candidates-posting-note";

export function CandidateFilter({
  options,
  selected,
  unavailable,
}: {
  options: readonly PostingOption[];
  /** The selected posting id, or null for all postings. */
  selected: string | null;
  /** True when the payer's postings list could not be read. */
  unavailable: boolean;
}) {
  return (
    <div className="candidates-filter">
      <form
        className="candidates-filter__form"
        method="get"
        action={CANDIDATES_PATH}
        role="search"
        aria-label="Filter candidates by posting"
      >
        <Select
          id={CANDIDATE_FILTER_SELECT_ID}
          name={POSTING_FILTER_PARAM}
          label="Posting"
          defaultValue={selected ?? ""}
          aria-describedby={unavailable ? UNAVAILABLE_NOTE_ID : undefined}
        >
          <option value="">All postings</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" iconLeft={ACTION_ICON.filter}>
          Show
        </Button>
      </form>
      {unavailable ? (
        <p className="candidates-filter__note" id={UNAVAILABLE_NOTE_ID}>
          Your postings list didn&rsquo;t load, so only All postings is offered — reload the
          page to pick one.
        </p>
      ) : null}
    </div>
  );
}

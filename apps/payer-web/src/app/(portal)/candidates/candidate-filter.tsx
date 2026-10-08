import { ACTION_ICON } from "@badabhai/icons";
import { Button, Select } from "../../../components/ds";
import {
  CANDIDATES_PATH,
  POSTING_FILTER_PARAM,
  STAGE_FILTER_PARAM,
  STAGE_OPTIONS,
  type PostingOption,
} from "../../../lib/candidate-inbox";
import type { ApplicantStage } from "../../../lib/applicant-stages";

/**
 * The Candidates filter — the page head's toolbar row.
 *
 * A PLAIN `GET` form, server-rendered, with no client code: "Show" submits `?postingId=` (and,
 * when offered, `&stage=`) to `/candidates` (the browser's own navigation, so it works before
 * hydration and never waits on a router transition). The submitted form drops `cursor`, so a new
 * filter starts at the newest page — a cursor is a position, never a filter. "All postings" / "All
 * stages" submit an empty value, which the page reads as no filter.
 *
 * A select changes nothing until "Show" is pressed — choosing an option is never a navigation
 * (WCAG 3.2.2). The posting options are the payer's OWN postings, from the list read the page
 * already makes; `unavailable` says that read failed, so "All postings" is the only real choice.
 *
 * STAGE (owner ruling 2026-10-07): `stage` is null unless the page's read showed the server SAVES
 * stages (`stagesOffered`) — then a second select offers the saved board's stages. With it null no
 * stage control is drawn at all: the API refuses `?stage=` while it does not save stages, and a
 * filter that does nothing is never offered.
 */
export const CANDIDATE_FILTER_SELECT_ID = "candidates-posting";
export const CANDIDATE_STAGE_SELECT_ID = "candidates-stage";
const UNAVAILABLE_NOTE_ID = "candidates-posting-note";
const STAGE_REFUSED_NOTE_ID = "candidates-stage-note";

export function CandidateFilter({
  options,
  selected,
  unavailable,
  stage = null,
  stageRefused = false,
}: {
  options: readonly PostingOption[];
  /** The selected posting id, or null for all postings. */
  selected: string | null;
  /** True when the payer's postings list could not be read. */
  unavailable: boolean;
  /**
   * The stage filter, when the server saves stages: the selected stage (null = all stages).
   * Null/omitted = no stage filter on this page.
   */
  stage?: { selected: ApplicantStage | null } | null;
  /**
   * The address asked for a stage and the server refused it (it does not save stages right now),
   * so the list below is every stage. Said once, calmly — it is not an outage, and nothing about
   * any applicant.
   */
  stageRefused?: boolean;
}) {
  return (
    <div className="candidates-filter">
      <form
        className="candidates-filter__form"
        method="get"
        action={CANDIDATES_PATH}
        role="search"
        aria-label={stage ? "Filter candidates" : "Filter candidates by posting"}
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
        {stage ? (
          <Select
            id={CANDIDATE_STAGE_SELECT_ID}
            name={STAGE_FILTER_PARAM}
            label="Stage"
            defaultValue={stage.selected ?? ""}
          >
            <option value="">All stages</option>
            {STAGE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : null}
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
      {stageRefused ? (
        <p className="candidates-filter__note" id={STAGE_REFUSED_NOTE_ID}>
          The stage filter isn&rsquo;t available right now, so every stage is shown.
        </p>
      ) : null}
    </div>
  );
}

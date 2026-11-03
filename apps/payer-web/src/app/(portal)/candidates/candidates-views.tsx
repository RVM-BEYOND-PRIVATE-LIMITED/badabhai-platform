import { CANDIDATES_PATH } from "../../../lib/candidate-inbox";
import { CANDIDATE_SEARCH_PATH } from "../../../lib/candidate-search";
import { PortalLink } from "../../../components/portal-link";

/**
 * The Candidates tab's TWO VIEWS (owner rulings 2026-11-03): "All candidates" (`/candidates`,
 * everyone in the pool the API lets this payer search) and "Applied" (`/candidates/applied`,
 * everyone who applied to the payer's own postings). Both personas, both pages, in the head's
 * toolbar row above the page's own filter.
 *
 * Two plain LINKS — a navigation between pages, so no client code and no tab widget: each works
 * before hydration, is a tab stop of its own and opens with Enter (a WAI-ARIA tablist would
 * promise arrow-key panels that are not here). The current view is `aria-current="page"` and
 * wears the DS underline tab's active look. Each is a `PortalLink`, so a click on a slow backend
 * still answers with the navigation pending cue (no loading boundary — #2115). A view link drops
 * the other view's filters: each list has its own.
 */
export type CandidatesView = "all" | "applied";

const VIEWS: ReadonlyArray<{ id: CandidatesView; href: string; label: string; pending: string }> = [
  { id: "all", href: CANDIDATE_SEARCH_PATH, label: "All candidates", pending: "All candidates" },
  { id: "applied", href: CANDIDATES_PATH, label: "Applied", pending: "Applied candidates" },
];

export function CandidatesViews({ current }: { current: CandidatesView }) {
  return (
    <nav className="bb-tabs bb-tabs--underline candidates-views" aria-label="Candidate lists">
      {VIEWS.map((v) => (
        <PortalLink
          key={v.id}
          className={v.id === current ? "bb-tab bb-tab--active" : "bb-tab"}
          href={v.href}
          aria-current={v.id === current ? "page" : undefined}
          pendingLabel={v.pending}
        >
          {v.label}
        </PortalLink>
      ))}
    </nav>
  );
}

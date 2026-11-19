import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  WORKER_VISIBILITY_FILTERS,
  listCampusPostings,
  type WorkerVisibilityFilter,
} from "../../../../lib/campus-visibility";
import { PageHeader } from "../../../../components/page-header";
import { CampusVisibilityTable } from "../../../../components/campus-visibility-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campus jobs" };

const TAB_LABELS: Record<WorkerVisibilityFilter, string> = {
  waiting: "Waiting",
  off: "Hidden from workers",
  on: "Shown to workers",
};

function parseFilter(value: string | undefined): WorkerVisibilityFilter {
  return value === "off" || value === "on" ? value : "waiting";
}

/**
 * #2891 — Campus jobs and their BadaBhai worker visibility. Gated on `manage_postings`.
 *
 * The default tab is "Waiting": no admin has decided yet. A job with no trade cannot be shown
 * until its trade is set.
 */
export default async function CampusJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_postings");
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const filter = parseFilter(one(sp.filter));
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listCampusPostings>>;
  try {
    page = await listCampusPostings(filter, cursor);
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            back={{ href: "/jobs", label: "Postings" }}
            title="Campus jobs"
            description="Jobs created on Campus and whether BadaBhai workers can see them."
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Campus jobs are not available yet</h2>
              <p className="state__body">The Campus job import is not switched on.</p>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  const href = (next: WorkerVisibilityFilter, nextCursor?: string | null) => {
    const q = new URLSearchParams();
    if (next !== "waiting") q.set("filter", next);
    if (nextCursor) q.set("cursor", nextCursor);
    const qs = q.toString();
    return `/jobs/campus${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="page page--reading">
      <PageHeader
        back={{ href: "/jobs", label: "Postings" }}
        title="Campus jobs"
        description="Jobs created on Campus and whether BadaBhai workers can see them."
      />

      <nav className="filter-chips" aria-label="Worker visibility">
        {WORKER_VISIBILITY_FILTERS.map((tab) => (
          <Link
            key={tab}
            className={`btn btn--sm${tab === filter ? " btn--selected" : ""}`}
            href={href(tab)}
            aria-current={tab === filter ? "true" : undefined}
          >
            {TAB_LABELS[tab]}
          </Link>
        ))}
      </nav>

      {page.postings.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">No jobs here</h2>
            <p className="state__body">No Campus job matches this tab.</p>
          </div>
        </section>
      ) : (
        <section className="panel">
          <CampusVisibilityTable postings={page.postings} />
          {page.next_cursor ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={href(filter, page.next_cursor)}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

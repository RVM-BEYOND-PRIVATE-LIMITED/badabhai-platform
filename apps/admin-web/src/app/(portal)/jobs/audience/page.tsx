import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { getAudienceList } from "../../../../lib/job-audience";
import {
  AUDIENCE_FILTERS,
  AUDIENCE_FILTER_LABELS,
  isAudienceFilter,
  type AudienceFilter,
} from "../../../../lib/job-audience-vocabulary";
import { PageHeader } from "../../../../components/page-header";
import { FilterChip } from "../../../../components/filter-chip-link";
import { AudienceTable } from "./audience-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Where jobs show" };

const DESCRIPTION =
  "Decide where each job shows: Campus only for a few openings in a trade RVM trains, Campus and BadaBhai for many, BadaBhai only for any other trade.";

/**
 * #2958 — WHERE JOBS SHOW (owner direction of 19 Nov 2026, #2959; API #2956). The tabs are the
 * API's filters: to decide (the default), Campus only, Campus and BadaBhai, BadaBhai only, and
 * jobs the company changed since an admin decided. A 404 means `ADMIN_JOB_AUDIENCE_ENABLED` is off.
 */
export default async function JobAudiencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_postings");
  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  const rawFilter = one(sp.filter);
  const filter: AudienceFilter = isAudienceFilter(rawFilter) ? rawFilter : AUDIENCE_FILTERS[0];
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof getAudienceList>>;
  try {
    page = await getAudienceList({ filter, ...(cursor ? { cursor } : {}), limit: 50 });
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Where jobs show"
            description={DESCRIPTION}
            back={{ href: "/jobs", label: "Postings" }}
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Not switched on yet</h2>
              <p className="state__body">
                The owner turns this on with ADMIN_JOB_AUDIENCE_ENABLED. Until then, every job keeps
                where it shows today.
              </p>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  const href = (next: { filter?: AudienceFilter; cursor?: string | null }) => {
    const qs = new URLSearchParams();
    qs.set("filter", next.filter ?? filter);
    if (next.cursor) qs.set("cursor", next.cursor);
    return `/jobs/audience?${qs.toString()}`;
  };

  return (
    <div className="page">
      <PageHeader
        title="Where jobs show"
        description={DESCRIPTION}
        back={{ href: "/jobs", label: "Postings" }}
        secondaryActions={
          <Link className="btn btn--ghost" href="/jobs/audience/trades">
            Trades RVM trains
          </Link>
        }
      />
      <nav className="state__actions" aria-label="Which jobs">
        {AUDIENCE_FILTERS.map((f) => (
          <FilterChip key={f} selected={f === filter} href={href({ filter: f })} cursor={cursor} size="md">
            {AUDIENCE_FILTER_LABELS[f]}
          </FilterChip>
        ))}
      </nav>

      {page.postings.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">No jobs here</h2>
            <p className="state__body">
              {filter === "to_decide"
                ? "Every live job in a trade RVM trains has a decision."
                : "No live job matches this tab."}
            </p>
          </div>
        </section>
      ) : (
        <>
          <AudienceTable rows={page.postings} />
          {page.next_cursor ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={href({ cursor: page.next_cursor })}>
                Next page
              </Link>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listPayers } from "../../../lib/entities";
import { PayerList } from "../../../components/payer-list";
import { Pager } from "../../../components/pager";
import { PayerFilterBar } from "../../../components/payer-filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Companies" };

/**
 * Companies — payer accounts with `role = employer`.
 *
 * Companies and Agencies are the same table split by role, which is why they share a list
 * component and a detail view. They are separate NAV sections because they are separate
 * operational populations: an employer hires, an agency supplies, and the questions an
 * operator asks about each are different.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const status = one(sp.status);
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listPayers>> | null = null;
  let failed = false;
  try {
    page = await listPayers({ role: "employer", status, cursor });
  } catch {
    failed = true;
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Companies</h1>
          <p className="page__sub">
            Employer accounts. Contact details are encrypted at rest and are not shown —
            find an account through its job postings.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="cf-heading">
        <h2 className="sr-only" id="cf-heading">
          Filter companies
        </h2>
        <PayerFilterBar basePath="/companies" status={status ?? ""} />
      </section>

      <section className="panel" aria-labelledby="cr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="cr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter was rejected."
                : `${page?.items.length ?? 0} compan${page?.items.length === 1 ? "y" : "ies"} on this page.`}
            </p>
          </div>
          {status && (
            <Link className="btn btn--ghost" href="/companies">
              Clear filter
            </Link>
          )}
        </div>

        {failed ? (
          <p className="empty">The server rejected that filter. Check the value and retry.</p>
        ) : (
          <PayerList
            payers={page?.items ?? []}
            basePath="/companies"
            emptyMessage={
              status ? "No companies match this filter." : "No company accounts registered yet."
            }
          />
        )}

        <Pager basePath="/companies" params={{ status }} nextCursor={page?.nextCursor} />
      </section>
    </div>
  );
}

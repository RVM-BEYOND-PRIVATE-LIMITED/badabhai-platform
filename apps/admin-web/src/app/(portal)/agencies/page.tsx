import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listPayers } from "../../../lib/entities";
import { PayerList } from "../../../components/payer-list";
import { Pager } from "../../../components/pager";
import { PayerFilterBar } from "../../../components/payer-filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agencies" };

/**
 * Agencies — payer accounts with `role = agent`.
 *
 * The same table and the same projection as Companies; the split is `role`, decided by the
 * server. Agency-specific surfaces (KYC state, the payout ledger) are NOT here: that loop
 * is launch-gated OFF behind `AGENCY_PAYOUTS_ENABLED`, and rendering a KYC panel that can
 * never be true would misrepresent what the platform currently does.
 */
export default async function AgenciesPage({
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
    page = await listPayers({ role: "agent", status, cursor });
  } catch {
    failed = true;
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Agencies</h1>
          <p className="page__sub">
            Supply-side partner accounts. Contact details are encrypted at rest and are not
            shown.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="af-heading">
        <h2 className="sr-only" id="af-heading">
          Filter agencies
        </h2>
        <PayerFilterBar basePath="/agencies" status={status ?? ""} />
      </section>

      <section className="panel" aria-labelledby="ar-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="ar-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter was rejected."
                : `${page?.items.length ?? 0} agenc${page?.items.length === 1 ? "y" : "ies"} on this page.`}
            </p>
          </div>
          {status && (
            <Link className="btn btn--ghost" href="/agencies">
              Clear filter
            </Link>
          )}
        </div>

        {failed ? (
          <p className="empty">The server rejected that filter. Check the value and retry.</p>
        ) : (
          <PayerList
            payers={page?.items ?? []}
            basePath="/agencies"
            emptyMessage={
              status ? "No agencies match this filter." : "No agency accounts registered yet."
            }
          />
        )}

        <Pager basePath="/agencies" params={{ status }} nextCursor={page?.nextCursor} />
      </section>
    </div>
  );
}

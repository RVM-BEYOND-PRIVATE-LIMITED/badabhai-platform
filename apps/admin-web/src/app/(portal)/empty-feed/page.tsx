import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { getEmptyFeed, describeEmptyFeedWorker } from "../../../lib/empty-feed";
import { PageHeader } from "../../../components/page-header";
import { Stat } from "../../../components/stat";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { NumberedPager } from "../../../components/pager";
import { SegmentedControl } from "../../../components/segmented-control";
import type { AdminEmptyFeedWorker } from "../../../lib/empty-feed";
import { formatCount } from "../../../lib/format";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Empty feed" };

/**
 * Workers with nothing to apply to (A10, #2580) — which trades and cities need more
 * postings or better matching (#2569), before those workers churn.
 *
 * READ-ONLY on `read_entities` (the API's own guard). Faceless rows: worker id, trade,
 * city, profile status and age in days — no name, phone, email or ciphertext. Test
 * accounts are excluded by default. The feed mode on screen is the ECHOED one, so an
 * operator can tell why the list changed after a flag flip.
 */

const columns: GridColumn<AdminEmptyFeedWorker>[] = [
  {
    id: "worker",
    header: "Worker",
    cell: (w) => <span className="mono">{w.worker_id.slice(0, 8)}</span>,
    title: (w) => w.worker_id,
  },
  {
    id: "trade",
    header: "Trade",
    cell: (w) => w.trade_name ?? "Not stated",
    title: (w) => w.trade_id ?? undefined,
  },
  {
    id: "city",
    header: "City",
    cell: (w) => w.city ?? "Not stated",
  },
  {
    id: "profile",
    header: "Profile",
    cell: (w) => w.profile_status ?? "Not profiled",
  },
  {
    id: "age",
    header: "Signed up",
    cell: (w) =>
      w.days_since_signup === 0
        ? "Today"
        : w.days_since_signup === 1
          ? "1 day ago"
          : `${w.days_since_signup} days ago`,
  },
];

export default async function EmptyFeedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");
  void can(session.capabilities, "read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const page = Math.max(1, Number(one(sp.page) ?? "1") || 1);
  const includeTests = one(sp.includeTestAccounts) === "true";

  let data: Awaited<ReturnType<typeof getEmptyFeed>> | null = null;
  let failed = false;
  try {
    data = await getEmptyFeed({
      page,
      includeTestAccounts: includeTests || undefined,
    });
  } catch {
    failed = true;
  }

  const baseParams = includeTests ? { includeTestAccounts: "true" } : {};

  return (
    <div className="page">
      <PageHeader
        title="Empty feed"
        description="Workers with nothing to apply to — where postings or matching run short."
        secondaryActions={
          <>
            <Link className="btn btn--ghost btn--sm" href="/funnel">
              <Icon name="funnel" />
              Onboarding funnel
            </Link>
            <Link className="btn btn--ghost btn--sm" href="/alerts">
              <Icon name="warning-octagon" />
              AI alerts
            </Link>
          </>
        }
        info={
          <>
            <p>
              One read of <code className="code">GET /admin/workers/empty-feed</code> per page,
              using the same feed rules the worker app uses — no second implementation. Counts below
              are for the whole filtered set, not this page.
            </p>
            <p>
              Rows are faceless by design: trade, city, profile status and age. A null trade or city
              is unstated data, never a zero.
            </p>
          </>
        }
        filters={
          <SegmentedControl
            label="Test accounts"
            selectedIndex={includeTests ? 1 : 0}
            options={[
              { label: "Exclude tests", href: "/empty-feed" },
              { label: "Include", href: "/empty-feed?includeTestAccounts=true" },
            ]}
          />
        }
      />

      {failed || !data ? (
        <section className="panel">
          <div className="state state--error">
            <h3 className="state__title" id="empty-feed-error-heading">
              The list could not be loaded
            </h3>
            <p className="state__body">
              The empty-feed read failed, so this screen is MISSING rather than empty — do not read
              its absence as every worker having work.
            </p>
            <div className="state__actions">
              <Link
                className="btn btn--ghost"
                href={includeTests ? "/empty-feed?includeTestAccounts=true" : "/empty-feed"}
              >
                <Icon name={ACTION_ICON.retry} />
                Retry
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section aria-labelledby="empty-feed-stats-heading">
            <h2 className="sr-only" id="empty-feed-stats-heading">
              Key figures
            </h2>
            <div className="stats">
              <Stat
                label="Workers with no work"
                value={formatCount(data.total)}
                tone={data.total > 0 ? "warn" : undefined}
                countUp={{ to: data.total, kind: "count" }}
              />
              <Stat
                label="Feed mode"
                value={data.feed_mode}
                valueTitle="The exact feed rules this answer reflects"
              />
              <Stat
                label="Trades affected"
                value={formatCount(data.counts.by_trade.length)}
                countUp={{ to: data.counts.by_trade.length, kind: "count" }}
              />
            </div>
            <p className="field__help">
              Feed mode <strong>{data.feed_mode}</strong> — the rules this answer reflects.
            </p>
          </section>

          <div className="cols">
            <section className="panel" aria-labelledby="by-trade-heading">
              <div className="panel__head">
                <h2 className="panel__title" id="by-trade-heading">
                  By trade
                </h2>
              </div>
              {data.counts.by_trade.length > 0 ? (
                <ul className="funnel">
                  {data.counts.by_trade.map((b) => (
                    <li className="funnel__row" key={b.trade_id ?? "null"}>
                      <span className="funnel__label">{b.trade_name ?? "Not stated"}</span>
                      <span className="funnel__nums">
                        <span className="funnel__distinct">{formatCount(b.count)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No trade breakdown for these filters.</p>
              )}
            </section>

            <section className="panel" aria-labelledby="by-city-heading">
              <div className="panel__head">
                <h2 className="panel__title" id="by-city-heading">
                  By city
                </h2>
              </div>
              {data.counts.by_city.length > 0 ? (
                <ul className="funnel">
                  {data.counts.by_city.map((b) => (
                    <li className="funnel__row" key={b.city ?? "null"}>
                      <span className="funnel__label">{b.city ?? "Not stated"}</span>
                      <span className="funnel__nums">
                        <span className="funnel__distinct">{formatCount(b.count)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">No city breakdown for these filters.</p>
              )}
            </section>
          </div>

          <section className="panel" aria-labelledby="workers-heading">
            <div className="panel__head panel__head--row">
              <div>
                <h2 className="panel__title" id="workers-heading">
                  Workers
                </h2>
                <p className="panel__sub">
                  Page {data.page} of {Math.max(1, data.total_pages)} · {formatCount(data.total)} in
                  all.
                </p>
              </div>
            </div>
            {data.workers.length > 0 ? (
              <DataGrid
                id="empty-feed"
                columns={columns}
                rows={data.workers}
                rowKey={(w) => w.worker_id}
                caption={data.workers
                  .map((w) => describeEmptyFeedWorker(w, data!.feed_mode))
                  .join(" ")}
                pager={
                  <NumberedPager
                    basePath="/empty-feed"
                    params={baseParams}
                    page={data.page}
                    pageSize={data.page_size}
                    total={data.total}
                  />
                }
              />
            ) : (
              <p className="empty">
                No workers have an empty feed under these filters — work for everyone, or nobody is
                looking.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

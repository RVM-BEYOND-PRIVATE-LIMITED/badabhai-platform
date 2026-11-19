import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import {
  ADMIN_ORDER_STATUSES,
  listAdminManagedOrders,
  managedOrderStatusLabel,
  type AdminOrderStatus,
} from "../../../lib/managed-hiring";
import { PageHeader } from "../../../components/page-header";
import { StatusPill } from "../../../components/status-pill";
import { formatTimestamp, shortId } from "../../../lib/format";
import { customerHref } from "../../../lib/customer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Managed Hiring" };

function parseStatus(v: string | undefined): AdminOrderStatus {
  return v === "ended" || v === "all" ? v : "open";
}

/** #2751 — every company's paid Managed Hiring orders, gated on work_managed_hiring. */
export default async function ManagedHiringPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("work_managed_hiring");
  const sp = await searchParams;
  const status = parseStatus(Array.isArray(sp.status) ? sp.status[0] : sp.status);
  const cursor = Array.isArray(sp.cursor) ? sp.cursor[0] : sp.cursor;

  let page: Awaited<ReturnType<typeof listAdminManagedOrders>>;
  try {
    page = await listAdminManagedOrders(status, cursor);
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Managed Hiring"
            description="BadaBhai's desk-finds-workers service, order by order."
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Managed Hiring is not switched on</h2>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  const href = (next: AdminOrderStatus, nextCursor?: string | null) => {
    const q = new URLSearchParams();
    if (next !== "open") q.set("status", next);
    if (nextCursor) q.set("cursor", nextCursor);
    const qs = q.toString();
    return `/managed-hiring${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="page page--reading">
      <PageHeader
        title="Managed Hiring"
        description="BadaBhai's desk-finds-workers service, order by order."
      />
      <nav className="filter-chips" aria-label="Order status">
        {ADMIN_ORDER_STATUSES.map((tab) => (
          <Link
            key={tab}
            className={`btn btn--sm${tab === status ? " btn--selected" : ""}`}
            href={href(tab)}
            aria-current={tab === status ? "true" : undefined}
          >
            {tab === "open" ? "Open" : tab === "ended" ? "Ended" : "All"}
          </Link>
        ))}
        <Link className="btn btn--sm" href="/managed-hiring/callbacks">
          Callback requests
        </Link>
      </nav>

      {page.orders.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">No orders here</h2>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Managed Hiring orders</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Company</th>
                  <th scope="col">Job</th>
                  <th scope="col">Status</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">Due</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {page.orders.map((o) => (
                  <tr key={o.order_id}>
                    <td>
                      <Link href={`/managed-hiring/${o.order_id}`}>{shortId(o.order_id)}</Link>
                    </td>
                    <td>
                      <Link href={customerHref(o.payer_id)}>{shortId(o.payer_id)}</Link>
                    </td>
                    <td>
                      <Link href={`/jobs/${o.job_posting_id}`}>{shortId(o.job_posting_id)}</Link>
                    </td>
                    <td>
                      <StatusPill value={o.status} label={managedOrderStatusLabel(o.status)} />
                    </td>
                    <td className="ui-num">
                      {o.confirmed_count} / {o.target_count}
                    </td>
                    <td>{o.due_at ? formatTimestamp(o.due_at) : "—"}</td>
                    <td>{formatTimestamp(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.next_cursor ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={href(status, page.next_cursor)}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

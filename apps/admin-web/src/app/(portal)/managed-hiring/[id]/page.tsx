import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { getAdminManagedOrder, managedOrderStatusLabel } from "../../../../lib/managed-hiring";
import { PageHeader } from "../../../../components/page-header";
import { StatusPill } from "../../../../components/status-pill";
import { ManagedOrderTracker } from "../../../../components/managed-order-tracker";
import { formatTimestamp, shortId } from "../../../../lib/format";
import { customerHref } from "../../../../lib/customer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Managed Hiring order" };

/** #2751 — one order's tracker and notes. Gated on work_managed_hiring. */
export default async function ManagedOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability("work_managed_hiring");
  const { id } = await params;
  let order: Awaited<ReturnType<typeof getAdminManagedOrder>>;
  try {
    order = await getAdminManagedOrder(id);
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  return (
    <div className="page page--reading">
      <PageHeader
        back={{ href: "/managed-hiring", label: "Managed Hiring" }}
        title={`Order ${shortId(order.order_id)}`}
        description="The tracker, the deadline and the desk's notes."
      />
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Order</h2>
          <StatusPill value={order.status} label={managedOrderStatusLabel(order.status)} />
        </div>
        <dl className="stats stats--compact">
          <div>
            <dt>Confirmed</dt>
            <dd>
              {order.confirmed_count} of {order.target_count}
            </dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{order.due_at ? formatTimestamp(order.due_at) : "—"}</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>₹{order.price_inr.toLocaleString("en-IN")}</dd>
          </div>
        </dl>
        <p className="panel__sub">
          <Link href={customerHref(order.payer_id)}>Company</Link>
          {" · "}
          <Link href={`/jobs/${order.job_posting_id}`}>Job</Link>
        </p>
        <ManagedOrderTracker order={order} />
      </section>
    </div>
  );
}

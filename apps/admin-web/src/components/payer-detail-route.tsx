import { notFound } from "next/navigation";
import { requireCapability } from "../lib/auth";
import { getPayer, listJobPostings } from "../lib/entities";
import { isAdminRequestError } from "../lib/admin-http";
import { PayerDetailView } from "./payer-detail";
import { CUSTOMER_KIND_LABELS, CUSTOMERS_HREF } from "../lib/customer";

/**
 * The customer detail route body (`/companies/[id]`).
 *
 * ONE ROUTE FOR BOTH KINDS (A6, #2576). Companies and Agencies were two sections, and an id under
 * the wrong one was redirected to the other. They are one section now: the page reads the
 * account's own `role` and names it — Company or Agency — from that, so there is no wrong
 * section left to redirect from. `/agencies/:id` redirects here (next.config.mjs).
 */
export async function PayerDetailRoute({ id }: { id: string }) {
  const session = await requireCapability("read_entities");

  let payer: Awaited<ReturnType<typeof getPayer>>;
  try {
    payer = await getPayer(id);
  } catch (err) {
    // 404 (unknown) and 400 (not a uuid) are both "no such account" to an operator.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  // Their postings — both the identifying labels and the recent-activity table. Non-fatal:
  // a failure here must not blank the account record beside it.
  const postings = await listJobPostings({ payerId: id, limit: 10 })
    .then((p) => p.items)
    .catch(() => null);

  return (
    <PayerDetailView
      payer={payer}
      postings={postings}
      kind={CUSTOMER_KIND_LABELS[payer.role]}
      backHref={CUSTOMERS_HREF}
      capabilities={session.capabilities}
    />
  );
}

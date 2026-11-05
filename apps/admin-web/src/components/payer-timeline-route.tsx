import { notFound } from "next/navigation";
import { requireCapabilities } from "../lib/auth";
import { getPayer } from "../lib/entities";
import { isAdminRequestError } from "../lib/admin-http";
import { CUSTOMER_KIND_LABELS, customerHref } from "../lib/customer";
import { EntityTimeline } from "./entity-timeline";
import { shortId } from "../lib/format";

/**
 * The customer timeline route body (`/companies/[id]/timeline`) — the timeline sibling of
 * `PayerDetailRoute`, for a Company and an Agency alike since A6 (#2576): the back link names the
 * kind the account's own `role` says it is.
 */
export async function PayerTimelineRoute({ id, cursor }: { id: string; cursor?: string }) {
  // BOTH reads' gates, not just the timeline's. The page reads the account first (to 404 an
  // unknown id and to name its kind) on `read_entities`, then the timeline on `read_events`;
  // gated on `read_events` alone, a role holding only that would get a page whose header read
  // 403s into the error boundary instead of a clean refusal. `app/page-gates.test.ts` pins this.
  await requireCapabilities(["read_events", "read_entities"]);

  let payer: Awaited<ReturnType<typeof getPayer>>;
  try {
    // FACELESS: this page reads `role` and `id` and renders no name (the back link is the kind
    // and the short id, "Company 1a2b3c4d…"). Asking for the name would charge the egress budget
    // and write an audit row on every page-turn for a disclosure that never reaches a screen.
    payer = await getPayer(id, { faceless: true });
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  const kind = CUSTOMER_KIND_LABELS[payer.role];
  const customerPath = customerHref(payer.id);
  return (
    <EntityTimeline
      type="payer"
      id={payer.id}
      cursor={cursor}
      basePath={`${customerPath}/timeline`}
      back={{ href: customerPath, label: `${kind} ${shortId(payer.id)}` }}
      subjectLabel={kind.toLowerCase()}
    />
  );
}

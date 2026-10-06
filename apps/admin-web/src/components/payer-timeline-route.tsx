import { notFound, redirect } from "next/navigation";
import { requireCapabilities } from "../lib/auth";
import { getPayer } from "../lib/entities";
import { isAdminRequestError } from "../lib/admin-http";
import { EntityTimeline } from "./entity-timeline";
import { shortId } from "../lib/format";

/**
 * The shared Companies/Agencies timeline route body — the timeline sibling of
 * `PayerDetailRoute`, extracted the same way (one shared component, two thin route files).
 *
 * ROLE MISMATCH REDIRECTS rather than 404s, for the same reason `PayerDetailRoute` does: an
 * employer id under `/agencies/:id/timeline` is a real account, not a missing one, so it is
 * sent to the section that matches its actual role rather than told it does not exist.
 */
export async function PayerTimelineRoute({
  id,
  kind,
  cursor,
}: {
  id: string;
  kind: "Company" | "Agency";
  cursor?: string;
}) {
  // BOTH reads' gates, not just the timeline's. The page reads the account first (to learn its
  // role, for the redirect below) on `read_entities`, then the timeline on `read_events`; gated
  // on `read_events` alone, a role holding only that would get a page whose header read 403s
  // into the error boundary instead of a clean refusal. `app/page-gates.test.ts` pins this.
  await requireCapabilities(["read_events", "read_entities"]);

  const expectedRole = kind === "Company" ? "employer" : "agent";
  const basePath = kind === "Company" ? "/companies" : "/agencies";

  let payer: Awaited<ReturnType<typeof getPayer>>;
  try {
    // FACELESS: this page reads `role` and `id` and renders no name (the back link is `kind`
    // and the short id, "Company 1a2b3c4d…"). Asking for the name would charge the egress budget
    // and write an audit row on every page-turn for a disclosure that never reaches a screen.
    payer = await getPayer(id, { faceless: true });
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  if (payer.role !== expectedRole) {
    redirect(`${payer.role === "agent" ? "/agencies" : "/companies"}/${payer.id}/timeline`);
  }

  return (
    <EntityTimeline
      type="payer"
      id={payer.id}
      cursor={cursor}
      basePath={`${basePath}/${payer.id}/timeline`}
      back={{ href: `${basePath}/${payer.id}`, label: `${kind} ${shortId(payer.id)}` }}
      subjectLabel={kind.toLowerCase()}
    />
  );
}

import { notFound, redirect } from "next/navigation";
import { requireCapability } from "../lib/auth";
import { getPayer } from "../lib/entities";
import { isAdminRequestError } from "../lib/admin-http";
import { EntityTimeline } from "./entity-timeline";

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
  await requireCapability("read_events");

  const expectedRole = kind === "Company" ? "employer" : "agent";
  const basePath = kind === "Company" ? "/companies" : "/agencies";

  let payer: Awaited<ReturnType<typeof getPayer>>;
  try {
    payer = await getPayer(id);
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
      backHref={`${basePath}/${payer.id}`}
      backLabel={kind}
    />
  );
}

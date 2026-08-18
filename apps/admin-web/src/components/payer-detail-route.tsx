import { notFound, redirect } from "next/navigation";
import { requireCapability } from "../lib/auth";
import { getPayer, listJobPostings } from "../lib/entities";
import { isAdminRequestError } from "../lib/admin-http";
import { PayerDetailView } from "./payer-detail";

/**
 * The shared Companies/Agencies detail route body — extracted on its second use, per the
 * repo's extract-on-second-use policy.
 *
 * ROLE MISMATCH REDIRECTS rather than 404s. An employer id under `/agencies/:id` is a real
 * account someone reached by editing a URL or following a stale link; showing "not found"
 * would say the account does not exist, which is false. Sending them to the right section
 * keeps the breadcrumb honest and the URL meaningful.
 */
export async function PayerDetailRoute({
  id,
  kind,
}: {
  id: string;
  kind: "Company" | "Agency";
}) {
  const session = await requireCapability("read_entities");

  const expectedRole = kind === "Company" ? "employer" : "agent";
  const basePath = kind === "Company" ? "/companies" : "/agencies";

  let payer: Awaited<ReturnType<typeof getPayer>>;
  try {
    payer = await getPayer(id);
  } catch (err) {
    // 404 (unknown) and 400 (not a uuid) are both "no such account" to an operator.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  if (payer.role !== expectedRole) {
    redirect(`${payer.role === "agent" ? "/agencies" : "/companies"}/${payer.id}`);
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
      kind={kind}
      backHref={basePath}
      capabilities={session.capabilities}
    />
  );
}

import Link from "next/link";
import { postingIsFreeThroughLaunch, postingPaidTiers } from "../../../../lib/pricing-config";
import { getCapacity } from "../../../../lib/payer-api";
import { formatInr } from "../../../../lib/format";
import { Badge, Card } from "../../../../components/ds";
import { PostingForm } from "./posting-form";

export const dynamic = "force-dynamic";

/**
 * Post a job (ADR-0019 Phase 1). Free-through-launch: the "free" label is sourced
 * from a CONFIG FLAG, never a hardcoded ₹0 — the catalog cannot model a ₹0 price
 * (priceInr min(1)), which is the open ADR-0013 escalation. Post-launch paid tiers
 * are shown for transparency, read straight from `DEFAULT_CATALOG`.
 *
 * QUOTA-PAUSE A4 (faithful slice): a NON-BLOCKING at-capacity warning is shown when the
 * payer is at/over their concurrent-vacancy allowance. The signal derives from the REAL
 * enforcement-engine count via `getCapacity()` (activeVacancies >= allowance) on the
 * server; it is informational and does NOT disable submit. A capacity read failure is
 * swallowed (the warning simply doesn't show) — it must never block posting.
 */
export default async function NewPostingPage() {
  const free = postingIsFreeThroughLaunch();
  const paidTiers = postingPaidTiers();

  let atCapacity = false;
  try {
    const capacity = await getCapacity();
    atCapacity = capacity.activeVacancies >= capacity.activeVacancyAllowance;
  } catch {
    // Capacity read failed — do NOT block posting; just omit the informational warning.
    atCapacity = false;
  }

  return (
    <>
      <p className="page-back">
        <Link href="/postings">← Manage postings</Link>
      </p>
      <h1 className="dash-title">Post a job</h1>
      <p className="dash-sub">Describe the role. Applicants appear faceless until you unlock them.</p>

      {atCapacity ? (
        <Card variant="outline" className="posting-note">
          <Badge tone="warning" upper>
            At capacity
          </Badge>
          <p className="posting-note__msg">
            You are at capacity; this posting may be paused until you{" "}
            <Link href="/capacity">add capacity</Link>.
          </p>
        </Card>
      ) : null}

      {free ? (
        <Card variant="outline" className="posting-note">
          <Badge tone="success" upper>
            Free through launch
          </Badge>
          <p className="posting-note__msg">
            Posting a job is free during the launch phase. (We show this from a launch-phase config
            flag — the pricing catalog cannot represent a ₹0 price, so &ldquo;free&rdquo; is not a
            catalog amount.)
          </p>
        </Card>
      ) : (
        <Card variant="outline" className="posting-note">
          <Badge tone="warning" upper>
            Paid plans
          </Badge>
          <p className="posting-note__msg">
            Paid posting plans (config-driven):{" "}
            {paidTiers.length === 0
              ? "unavailable"
              : paidTiers
                  .map((t) => `${t.code} ${formatInr(t.priceInr)} / ${t.validityDays}d`)
                  .join(" · ")}
            .
          </p>
        </Card>
      )}

      <PostingForm />
    </>
  );
}

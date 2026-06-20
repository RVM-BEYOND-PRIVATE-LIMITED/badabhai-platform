import { postingIsFreeThroughLaunch, postingPaidTiers } from "../../../../lib/pricing-config";
import { PostingForm } from "./posting-form";

export const dynamic = "force-dynamic";

/**
 * Post a job (ADR-0019 Phase 1). Free-through-launch: the "free" label is sourced
 * from a CONFIG FLAG, never a hardcoded ₹0 — the catalog cannot model a ₹0 price
 * (priceInr min(1)), which is the open ADR-0013 escalation. Post-launch paid tiers
 * are shown for transparency, read straight from `DEFAULT_CATALOG`.
 */
export default function NewPostingPage() {
  const free = postingIsFreeThroughLaunch();
  const paidTiers = postingPaidTiers();

  return (
    <>
      <h1 className="page-title">Post a job</h1>
      <p className="page-sub">Describe the role. Applicants appear faceless until you unlock them.</p>

      {free ? (
        <div className="note">
          <strong>Free through launch.</strong> Posting a job is free during the launch phase. (We
          show this from a launch-phase config flag — the pricing catalog cannot represent a ₹0
          price, so &ldquo;free&rdquo; is not a catalog amount.)
        </div>
      ) : (
        <div className="note warn">
          Paid posting plans (config-driven):{" "}
          {paidTiers.length === 0
            ? "unavailable"
            : paidTiers
                .map((t) => `${t.code} ₹${t.priceInr} / ${t.validityDays}d`)
                .join(" · ")}
          .
        </div>
      )}

      <PostingForm />
    </>
  );
}

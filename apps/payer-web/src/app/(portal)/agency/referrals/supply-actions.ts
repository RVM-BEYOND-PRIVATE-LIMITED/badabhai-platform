"use server";

import { revalidatePath } from "next/cache";
import { agencyKycInputSchema, type AgencyKyc } from "../../../../lib/contracts";
import { requestAgencyPayout, submitAgencyKyc } from "../../../../lib/payer-api";
import { requireAgent } from "../../../../lib/auth/roles";

/**
 * Agency SUPPLY-money Server Actions (ADR-0022 Amendment 2, LIVE) — KYC submit + payout
 * request. MOCK money (no real disbursement).
 *
 * VERTICAL AUTHZ (XB-A / XT3): a Server Action is an independently-invocable POST
 * endpoint, so EACH action enforces the agent role gate ITSELF — `requireAgent()` is the
 * FIRST statement (an employer hits the SAME neutral notFound() the page does; no oracle).
 * TENANCY is the SESSION (the payer JWT) inside the seam — the client NEVER sends a
 * payer_id.
 *
 * GATE: while supply payouts are OFF the seam returns `null` (the gated-route 404) — the
 * action maps that to a friendly `{ ok:false, disabled:true }` "coming soon", never a raw
 * error. Any other transient failure is a neutral retryable message.
 */

const PAYOUTS_DISABLED = "Supply payouts aren't enabled yet. This will open soon.";

/* ── KYC submit ─────────────────────────────────────────────────────────────── */

export type SubmitKycResult =
  | { ok: true; kyc: AgencyKyc }
  | { ok: false; disabled: true; error: string }
  | { ok: false; error: string };

/**
 * Submit the agency's OWN KYC. The raw PAN / bank / IFSC / holder name are validated here
 * (mirroring the backend DTO) and ride the seam BODY only (write-only) — the response is
 * the MASKED status. `input` is `unknown` so the action is callable with raw client input;
 * it is Zod-parsed (PAN/IFSC uppercased) before it reaches the seam.
 */
export async function submitKycAction(input: unknown): Promise<SubmitKycResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().
  const parsed = agencyKycInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    const kyc = await submitAgencyKyc(parsed.data);
    if (kyc === null) return { ok: false, disabled: true, error: PAYOUTS_DISABLED };
    revalidatePath("/agency/referrals");
    return { ok: true, kyc };
  } catch {
    return { ok: false, error: "Could not submit your details right now. Please retry." };
  }
}

/* ── Payout request ─────────────────────────────────────────────────────────── */

export type RequestPayoutResult =
  | { ok: true; requestId: string; amountInr: number; accrualCount: number }
  /** The backend refused (KYC not verified / below threshold / disabled). */
  | { ok: false; blocked: true; reason: string }
  /** The route is not enabled yet (gated 404). */
  | { ok: false; disabled: true }
  /** A transient failure — retryable. */
  | { ok: false; error: string };

/**
 * Request a payout of the requestable balance. No input — the server computes the amount
 * from the session's own accruals and re-checks the gate (the client can never send an
 * amount). A blocked result is passed through (the panel maps the reason to friendly copy);
 * a gated 404 → `{ disabled:true }`; any other failure → a neutral retryable message.
 */
export async function requestPayoutAction(): Promise<RequestPayoutResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().
  try {
    const res = await requestAgencyPayout();
    if (res === null) return { ok: false, disabled: true }; // gated route (404) — not enabled.
    if (res.ok) {
      revalidatePath("/agency/referrals");
      return {
        ok: true,
        requestId: res.requestId,
        amountInr: res.amountInr,
        accrualCount: res.accrualCount,
      };
    }
    // Backend refused — surface the reason (the panel maps it to friendly copy).
    return { ok: false, blocked: true, reason: res.reason };
  } catch {
    return { ok: false, error: "Could not request a payout right now. Please retry." };
  }
}

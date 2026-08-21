import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AuthModule } from "./auth.module";
import { AuthService } from "./auth.service";

/**
 * #994 — CONTAINMENT GUARD for the unauthenticated session mint.
 *
 * `AuthService.mintSessionForWorker` is public and it VERIFIES NOTHING: hand it a worker row
 * and it mints a real, live session with a real refresh token. That is correct — it is the
 * shared tail every login path drives — but it means its only precondition ("the caller has
 * already proven the right to a session, on this request") is held by convention.
 *
 * Two things enforce it. The first is per-caller review: today's three call sites each sit
 * behind `OtpService.verify` (`verifyOtp`, `PinService.resetConfirm`) or `TestLoginGuard` plus
 * the synthetic-phone chokepoint (`testLogin`). The second is THIS: `AuthService` is not in
 * `AuthModule`'s `exports`, so no module outside AuthModule can inject it at all, and the set
 * of possible callers stays small enough to review by hand.
 *
 * The second one is a single missing line away from evaporating. A future PR wanting
 * `requestOtp` or `issueAndSendWithSignals` from another module would add `AuthService` to
 * `exports` — a one-word diff that reads as routine plumbing and silently promotes an
 * unauthenticated session mint to repo-wide injectability. Nothing else in the codebase would
 * object, because the only thing that ever said no is a JSDoc paragraph.
 *
 * So the boundary is asserted. If you genuinely need AuthService elsewhere, the fix is not to
 * delete this test: extract the narrow method you want (the OTP-send seam) into its own
 * exported provider, and leave the mint where it cannot be reached.
 */
describe("#994 — the session mint stays inside AuthModule", () => {
  it("AuthModule does NOT export AuthService", () => {
    const exports = (Reflect.getMetadata("exports", AuthModule) as unknown[] | undefined) ?? [];
    expect(
      exports,
      "AuthService was added to AuthModule.exports. That makes mintSessionForWorker — which " +
        "mints a live session and verifies NOTHING — injectable anywhere in the app. Export a " +
        "narrow seam for what you actually need instead; see the doc on mintSessionForWorker.",
    ).not.toContain(AuthService);
  });

  it("AuthService is still provided (the module owns it), just not exported", () => {
    // Guards against the test passing for the wrong reason — e.g. AuthService renamed away
    // and the export assertion above becoming trivially true.
    const providers = (Reflect.getMetadata("providers", AuthModule) as unknown[] | undefined) ?? [];
    expect(providers).toContain(AuthService);
  });
});

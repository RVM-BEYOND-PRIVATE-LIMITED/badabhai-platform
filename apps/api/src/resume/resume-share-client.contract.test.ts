import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ShareResumeSchema } from "./resume.dto";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE SHARE METRIC HAS NEVER BEEN ABLE TO FIRE (R16 §5.1).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * §12.2 calls WhatsApp share "the number that matters" and §12.4 sets a ninety-day kill
 * criterion against exactly it. The worker app shares — `Share.shareXFiles` — and the server has
 * always had a route that emits `resume.shared`. They have never been connected, and until R16
 * §5.1 they could not have been: the route required an internal-service secret the app does not
 * hold and cannot be given.
 *
 * BOTH HALVES ARE DONE NOW. The route is worker-authed, consent-gated, ownership-checked and
 * rate-limited (R16 §5.1), and #1317 landed the client call the same day. This file stopped being
 * a pin and became the regression test for the loop being closed.
 *
 * IT READS DART, and the precedent is `apps/api/src/actions/worker-app-action-contract.test.ts`:
 * "a client that never calls the endpoint" and "a client that calls it with the wrong shape" both
 * pass every test written on either side alone, so something has to look across.
 *
 * ── THE PIN THAT WENT STALE IN AN HOUR, AND IT IS R16 §0's OWN FAILURE MODE ───────────────
 *
 * This carried an `it.fails` asserting the client had NO share call, and it asserted that by
 * looking for a method named `recordResumeShare` — a name I invented for the issue. #1317 shipped
 * the call as `shareResume`. So the gap closed and the pin went on passing, because an `it.fails`
 * looking for the wrong name fails for the right reason and reports nothing.
 *
 * That is exactly the shape R16 §0 was written about one commit earlier: a suppression that
 * outlives the thing it suppressed, still green, still reassuring. A pin keyed on a name the
 * other side never agreed to is a claim about my guess, not about the code — so this asserts the
 * ROUTE, which is the contract both sides actually share, and names the method only as evidence.
 */

const CLIENT = join(__dirname, "../../../worker-app/lib/core/api/api_client.dart");
const PREVIEW = join(
  __dirname,
  "../../../worker-app/lib/features/resume/presentation/resume_preview_screen.dart",
);

describe("R16 §5.1 — the client half of resume.shared", () => {
  it("the Dart sources this reads are actually there", () => {
    // Vacuity: a moved file must fail loudly, not turn every assertion below into a silent pass.
    // The sibling contract test's header says the same thing — "if this breaks because the Dart
    // moved, do not delete it".
    expect(existsSync(CLIENT), `missing ${CLIENT}`).toBe(true);
    expect(existsSync(PREVIEW), `missing ${PREVIEW}`).toBe(true);
    expect(readFileSync(PREVIEW, "utf8")).toContain("Share.shareXFiles");
  });

  it("the channel vocabulary the client must use is a CLOSED set", () => {
    // Whatever Rishi sends has to be one of these, and the enum is the contract. Pinned from the
    // server side so the two cannot drift — the lesson from `source_surface: 'voice_form'`,
    // which shipped green on both sides while every real request 400'd.
    const parsed = ShareResumeSchema.safeParse({ channel: "link" });
    expect(parsed.success).toBe(true);
    expect(ShareResumeSchema.safeParse({ channel: "carrier_pigeon" }).success).toBe(false);
  });

  it("the worker app POSTs to /resume/:id/share (#1317 — LANDED)", () => {
    // WAS AN `it.fails`. `resume.shared` was structurally zero — not low, not "not yet
    // meaningful", but incapable of being written by anybody, because the route required an
    // internal-service secret the app cannot hold. Both halves exist now.
    //
    // ANCHORED ON THE ROUTE, NOT ON A METHOD NAME. The pin looked for `recordResumeShare`, a
    // name I made up when filing the issue; the call shipped as `shareResume`. The route path is
    // the thing the two sides actually agree on, so it is what this asserts. The method name
    // below is evidence, checked second — if it is renamed, this test should still hold.
    const client = readFileSync(CLIENT, "utf8");
    expect(client, "no client method posts to the share route").toContain("/share'");
    expect(client).toContain("shareResume");
  });

  it("the client reports ONLY a completed share, and never guesses the channel", () => {
    // THE CONCERN THE PIN CARRIED, and #1317 answered it better than the pin proposed. I had
    // written "do not send `whatsapp`" on the belief that the OS cannot report the picked target
    // — which was wrong: `share_plus` returns a `ShareResult`, and the blocker was this app's own
    // `Future<void>` typedef discarding it. #1317 widened the typedef, so the channel is now
    // OBSERVED rather than assumed, and nothing is posted when the sheet is dismissed.
    //
    // Both properties matter to the audit spine: a guessed channel is a fabricated fact, and
    // counting a cancelled share inflates the one number §12.4 kills the feature against.
    const preview = readFileSync(PREVIEW, "utf8");
    expect(preview, "a dismissed share must post nothing").toContain("ShareResultStatus.success");
    expect(preview, "the channel must come from the observed result").toContain("result.raw");
  });
});

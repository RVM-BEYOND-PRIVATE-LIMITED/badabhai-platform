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
 * THE SERVER HALF IS DONE. The route is worker-authed, consent-gated, ownership-checked and
 * rate-limited, and it is asserted in `resume-consent.authz.test.ts` and `resume.service.test.ts`.
 * What remains is one call from `apps/worker-app`, which is Rishi's tree (issue #1317).
 *
 * WHY THE `it.fails` LIVES HERE AND READS DART. This repo has a working precedent —
 * `apps/api/src/actions/worker-app-action-contract.test.ts` reads constants straight out of the
 * Dart source, because "a client that never calls the endpoint" and "a client that calls it with
 * the wrong shape" both pass every test written on either side alone. The `it.fails` pattern has
 * paid four times in this workstream: it tells the person doing the work exactly when they are
 * finished, and it turns the suite red the day the work lands so nobody has to remember to come
 * back and delete a note.
 *
 * IT IS A GREP, AND THAT IS DELIBERATE. Asserting a Dart call site from TypeScript cannot be
 * precise, and a precise-looking assertion here would be worse: it would fail on a refactor that
 * is fine. This asserts the one thing that matters — that SOMETHING in the client posts to the
 * share route — and leaves the shape to the client's own tests.
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

  it.fails("the worker app POSTs to /resume/:id/share (REPORTED — issue #1317)", () => {
    // FLIPS THE DAY THE CALL LANDS. The server side is finished; this is the one line that
    // closes the loop, and until it exists `resume.shared` is structurally zero — not "low",
    // not "not yet meaningful", but incapable of being written by anybody.
    //
    // NOTE FOR WHOEVER WIRES IT: do NOT send `whatsapp`. The OS share sheet does return a
    // target, but this app's own `ResumeShareFn` typedef returns `Future<void>` and discards it,
    // and `analytics.dart` records a standing decision not to collect the picked app. Sending a
    // guessed channel would put a fabricated fact into the audit spine. `link` is the honest
    // value until the client actually observes the target.
    const client = readFileSync(CLIENT, "utf8");
    expect(client).toMatch(/\/resume\/.*\/share/);
  });
});

import { describe, expect, it } from "vitest";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * #813/#814 — a payer login OTP returned `code_sent` (2xx) on the deployed box while
 * ZeptoMail delivered nothing. The #815 fix closed the SANDBOX_MODE half of that (a
 * leftover `ZEPTOMAIL_SANDBOX_MODE=true` no longer suppresses delivery outside dev/test),
 * but a live re-test after that fix deployed still showed no delivery: `ZEPTOMAIL_API_URL`
 * was declared NOWHERE — not in this compose file's `environment:` block, not in the CI
 * deploy step's secrets bridge (`.github/workflows/ci.yml`) — so it never reached the
 * container regardless of what was exported on the box or set as a GitHub secret.
 * `EmailNotificationService.sendViaZeptoMail` requires it
 * (`if (!apiUrl || ...) throw new EmailRejectedError(...)`), so every real send failed
 * closed on that guard, was caught, and `payer-otp.service`'s anti-enumeration
 * neutralization turned the failure into a generic `code_sent` success — the exact
 * "the 200 lies" trap this whole incident is about, from a second, independent cause.
 *
 * Same failure class, same fix shape as `voice-storage-compose.guard.test.ts`
 * (`VOICE_NOTES_BUCKET`) and `resume-render-compose.guard.test.ts`
 * (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`): compose forwards ONLY the names a
 * service's `environment:` block declares, so a name missing here is invisible to every
 * other test in the repo — the value sits in the box's shell or the GitHub secret store,
 * the process never sees it, and the feature is silently broken with nothing naming the
 * cause. This guard exists so the next ZeptoMail field added to `sendViaZeptoMail`'s
 * required set cannot ship the same way.
 */
const ZEPTOMAIL_VARS = [
  "ZEPTOMAIL_API_URL",
  "ZEPTOMAIL_API_TOKEN",
  "ZEPTOMAIL_MAIL_AGENT",
  "EMAIL_FROM_ADDRESS",
] as const;

describe("docker-compose.staging.yml — every ZeptoMail field sendViaZeptoMail requires is wired", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");

  it("parses the api service environment (guards the parser itself, not the rule)", () => {
    // If the parser silently found nothing, every assertion below would pass vacuously.
    // AI_SERVICE_URL is a stable literal unrelated to email, fixed since CD-1.
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
  });

  it.each(ZEPTOMAIL_VARS)("%s is declared on the api service", (name) => {
    expect(api.has(name), `${name} missing from the api service — #813 class`).toBe(true);
  });

  it.each(ZEPTOMAIL_VARS)("%s is a fail-closed `:-` pass-through, never required", (name) => {
    // `${VAR:?}` would fail the deploy when unset, which is not the posture here: a box
    // that hasn't been given real ZeptoMail creds yet must stay bootable (EMAIL_PROVIDER
    // defaults to zeptomail, and assertPayerAuthConfig is the credential-completeness
    // gate, not this file — see the comment directly above these lines in the compose
    // file itself).
    expect(api.get(name), `${name} on api`).toBe(`\${${name}:-}`);
  });
});

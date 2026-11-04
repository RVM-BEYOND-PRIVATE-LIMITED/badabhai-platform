import { describe, it, expect, afterEach } from "vitest";
import { inviteLandingUrl, isWellFormedInviteCode, playStoreUrl, workerAppId } from "./invite-landing";

const CODE = "abcdef012345";

describe("inviteLandingUrl — the shareable link the bridge QR encodes (#607)", () => {
  // Cleanup belongs in afterEach, NOT at the end of the test that sets it. A `delete` on the
  // last line never runs when the assertion above it throws, so a single failure silently
  // leaked the override into the following cases and reported them as origin failures rather
  // than as the path failure they actually were. Observed while mutation-testing this block.
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SHORT_LINK_BASE;
  });

  it("points at `/i/`, NEVER `/r/` — this origin serves payer-web, which has no `/r` route", () => {
    // THE REGRESSION THIS PINS. `/r/<code>` is served by apps/api (`@Controller("r")`), but
    // the short-link origin names THIS app, which declares no `/r` route and no rewrite. The
    // desktop bridge QR encoded that URL, so every scan hit a 404 and the referral died with
    // no `referral_clicks` row. Attribution survives on `/i/` because that page pings the
    // public click endpoint itself — which is where the resolver's own 302 landed anyway.
    const url = inviteLandingUrl(CODE);
    expect(url).toBe(`https://payer.43-204-36-199.sslip.io/i/${CODE}`);
    expect(url).not.toContain("/r/");
  });

  it("honours NEXT_PUBLIC_SHORT_LINK_BASE and strips its trailing slashes", () => {
    process.env.NEXT_PUBLIC_SHORT_LINK_BASE = "https://bb.example.test//";
    expect(inviteLandingUrl(CODE)).toBe(`https://bb.example.test/i/${CODE}`);
  });

  it("URL-encodes the code, so a hostile path segment cannot escape the `/i/` space", () => {
    expect(inviteLandingUrl("../../evil")).toBe(
      "https://payer.43-204-36-199.sslip.io/i/..%2F..%2Fevil",
    );
  });
});

describe("playStoreUrl — the Play Install Referrer payload (blocker B4)", () => {
  it("attaches the referral code as a URL-ENCODED referrer (how a fresh install is attributed)", () => {
    const url = playStoreUrl(CODE);
    // Firebase Dynamic Links is gone; `referrer` is the ONLY channel that survives the
    // Play Store round-trip for a device that does not have the app yet.
    expect(url).toContain(`referrer=${encodeURIComponent(`bb_code=${CODE}`)}`);
    expect(url).toContain("bb_code%3D"); // the `=` MUST be encoded, or Play truncates it
    expect(url.startsWith("https://play.google.com/store/apps/details?id=")).toBe(true);
  });

  it("reads the app id from config, not a literal (test track vs production differ)", () => {
    process.env.NEXT_PUBLIC_WORKER_APP_ID = "com.badabhai.workerapp.staging";
    expect(workerAppId()).toBe("com.badabhai.workerapp.staging");
    expect(playStoreUrl(CODE)).toContain("id=com.badabhai.workerapp.staging");
    delete process.env.NEXT_PUBLIC_WORKER_APP_ID;
    expect(workerAppId()).toBe("com.badabhai.workerapp");
  });

  it("treats a BLANK env value as unset rather than building an id-less store URL", () => {
    process.env.NEXT_PUBLIC_WORKER_APP_ID = "   ";
    expect(workerAppId()).toBe("com.badabhai.workerapp");
    delete process.env.NEXT_PUBLIC_WORKER_APP_ID;
  });
});

describe("isWellFormedInviteCode — shape only, never an existence check", () => {
  it("accepts the 12-lowercase-hex shape both funnels mint", () => {
    expect(isWellFormedInviteCode(CODE)).toBe(true);
    expect(isWellFormedInviteCode("000000000000")).toBe(true);
  });

  it("rejects wrong length, uppercase, and anything path-ish", () => {
    for (const bad of ["abc", "ABCDEF012345", "abcdef0123456", "../../etc/passwd", ""]) {
      expect(isWellFormedInviteCode(bad)).toBe(false);
    }
  });
});

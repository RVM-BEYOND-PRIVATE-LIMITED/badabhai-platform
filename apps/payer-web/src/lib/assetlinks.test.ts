import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workerAppId } from "./invite-landing";

/**
 * `public/.well-known/assetlinks.json` — the Digital Asset Links statement that makes
 * `https://app.badabhai.in/i/<code>` a VERIFIED Android App Link, so an installed worker app
 * intercepts a shared referral link instead of the browser (blocker B4; Firebase Dynamic
 * Links shut down 2025-08-25).
 *
 * The SHA-256 fingerprint is an OWNER-supplied value and was deliberately NOT invented — a
 * plausible-but-wrong fingerprint fails verification SILENTLY and would only surface as
 * mysteriously low referral numbers. These tests therefore pin the STRUCTURE (which must be
 * exactly right) and accept EITHER the loud placeholder OR a well-formed real fingerprint,
 * so filling it in needs no test edit but a malformed value is caught.
 *
 * See `public/.well-known/README.md` for how to obtain and verify it.
 */

const PLACEHOLDER =
  "REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT_RELEASE_IS_BLOCKED_UNTIL_THIS_IS_SET";
/** Colon-separated uppercase hex, 32 bytes — the format Android requires. */
const FINGERPRINT_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

interface AssetLinkStatement {
  relation: string[];
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
}

const filePath = join(process.cwd(), "public", ".well-known", "assetlinks.json");
const raw = readFileSync(filePath, "utf8");
const statements = JSON.parse(raw) as AssetLinkStatement[];

describe("assetlinks.json — Digital Asset Links statement", () => {
  it("is a JSON ARRAY of statements (Android rejects a bare object)", () => {
    expect(Array.isArray(statements)).toBe(true);
    expect(statements.length).toBeGreaterThan(0);
  });

  it("delegates handle_all_urls to an android_app target", () => {
    const [statement] = statements;
    expect(statement?.relation).toContain("delegate_permission/common.handle_all_urls");
    expect(statement?.target.namespace).toBe("android_app");
  });

  it("names the SAME package the landing page's Play Store link uses", () => {
    // A mismatch is the silent-failure mode: the link opens the Play Store listing for one
    // app while the App Link verification is claimed for another.
    expect(statements[0]?.target.package_name).toBe(workerAppId());
  });

  it("carries either the LOUD placeholder or a WELL-FORMED fingerprint — never junk", () => {
    const prints = statements[0]?.target.sha256_cert_fingerprints ?? [];
    expect(prints.length).toBeGreaterThan(0);
    for (const print of prints) {
      const ok = print === PLACEHOLDER || FINGERPRINT_RE.test(print);
      expect(ok, `fingerprint must be the placeholder or 32 colon-separated hex bytes: ${print}`).toBe(
        true,
      );
    }
  });

  it("RELEASE GATE: flags that the placeholder is still in place", () => {
    const prints = statements[0]?.target.sha256_cert_fingerprints ?? [];
    const stillPlaceholder = prints.includes(PLACEHOLDER);
    // Intentionally NOT a failure — the placeholder is the committed, documented state until
    // the owner supplies the real value. This test exists so the fact is visible in the suite
    // and so the well-formedness check above starts applying the moment it is replaced.
    if (stillPlaceholder) {
      expect(prints).toHaveLength(1);
    } else {
      for (const print of prints) expect(print).toMatch(FINGERPRINT_RE);
    }
  });
});

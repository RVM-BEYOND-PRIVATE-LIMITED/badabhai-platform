import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #609 — the Digital Asset Links statement is INVISIBLE-until-it-fails in
 * production: a drifted `package_name` or a malformed file silently drops every
 * "already installed" deep link to the browser, and "everything looks correctly
 * wired". These structural guards make those silent failure modes loud in CI.
 *
 * The FINGERPRINT itself is an owner-supplied secret (Play App Signing key — see
 * the README) and is deliberately NOT asserted here: the placeholder is expected
 * until the owner fills it in. The RELEASE gate that hard-blocks on the
 * placeholder is `scripts/verify-assetlinks-release.mjs`, run in the deploy
 * pipeline.
 */
describe("assetlinks.json (#609)", () => {
  const raw = readFileSync(
    join(process.cwd(), "public/.well-known/assetlinks.json"),
    "utf8",
  );
  const statements = JSON.parse(raw) as Array<{
    relation: string[];
    target: {
      namespace: string;
      package_name: string;
      sha256_cert_fingerprints: unknown;
    };
  }>;

  it("is a single delegate_permission statement for an android_app", () => {
    expect(Array.isArray(statements)).toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0].relation).toContain(
      "delegate_permission/common.handle_all_urls",
    );
    expect(statements[0].target.namespace).toBe("android_app");
  });

  it("package_name stays in sync with NEXT_PUBLIC_WORKER_APP_ID", () => {
    // A mismatch fails App Link verification just as silently as a bad
    // fingerprint (the issue calls this out explicitly).
    const expected =
      process.env.NEXT_PUBLIC_WORKER_APP_ID ?? "com.badabhai.workerapp";
    expect(statements[0].target.package_name).toBe(expected);
  });

  it("declares a non-empty sha256_cert_fingerprints array", () => {
    const fps = statements[0].target.sha256_cert_fingerprints;
    expect(Array.isArray(fps)).toBe(true);
    expect((fps as unknown[]).length).toBeGreaterThan(0);
  });
});

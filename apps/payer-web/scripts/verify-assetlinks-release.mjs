#!/usr/bin/env node
/**
 * #609 — RELEASE GATE for the App Links launch gate.
 *
 * App Link verification is SILENT when it fails: with the placeholder
 * fingerprint in place, Android just falls back to the browser and nobody
 * notices until referral numbers come in low. So the placeholder must HARD-BLOCK
 * a release rather than ship a broken "already installed" deep link.
 *
 * Run this in the DEPLOY pipeline for payer-web (e.g. a step before publish:
 * `node scripts/verify-assetlinks-release.mjs`). It is deliberately NOT part of
 * the dev test run — the placeholder is expected until the owner fills in the
 * real value from Play Console → App integrity → App signing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "..", "public", ".well-known", "assetlinks.json");

/** A real Play SHA-256: 32 colon-separated hex byte pairs (e.g. AB:CD:...:12). */
const SHA256 = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/;

let statements;
try {
  statements = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`\n✗ assetlinks.json is missing or not valid JSON (#609): ${err.message}\n`);
  process.exit(1);
}

const fps = statements?.[0]?.target?.sha256_cert_fingerprints ?? [];
const bad = fps.filter((f) => typeof f !== "string" || !SHA256.test(f));

if (fps.length === 0 || bad.length > 0) {
  console.error(
    "\n✗ assetlinks.json is NOT release-ready (#609).\n" +
      "  sha256_cert_fingerprints must be colon-separated uppercase SHA-256 hex\n" +
      "  from Play Console → App integrity → App signing (the APP SIGNING key,\n" +
      "  NOT the upload key). Every shared invite link opens the browser until\n" +
      "  this is set.\n" +
      `  Found: ${JSON.stringify(fps)}\n` +
      "  See apps/payer-web/public/.well-known/README.md\n",
  );
  process.exit(1);
}

console.log("✓ assetlinks.json fingerprints look release-ready.");

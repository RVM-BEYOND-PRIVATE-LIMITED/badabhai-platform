// scripts/check-secret-parity.test.mjs
// Self-test for scripts/check-secret-parity.mjs — node:test, zero deps, no network,
// no real files. Every case runs against small synthetic fixtures (never the live
// docker-compose.staging.yml / ci.yml / staging-cd.yml) so this stays stable
// regardless of any real secret-bridge drift in the repo.
//
// The mutation-testing pair at the bottom is the vacuousness proof this repo's
// mutation bar requires (CLAUDE.md §14 / "a passing check is only evidence once
// you've seen it capable of failing"): the same fixture pair, once with a required
// secret bridged and once with it removed — proving the gate actually trips.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIndentedBlocks,
  extractComposeRequiredVars,
  extractSecretRefs,
  parseComposeRequiredVars,
  parseWorkflowJobSecrets,
  findMissing,
} from "./check-secret-parity.mjs";

// A minimal compose fixture mirroring docker-compose.staging.yml's shape: two
// services, each with a required (":?") image pin, one required (":?") secret, and
// one optional (":-") pass-through that must NOT be treated as required.
const FIXTURE_COMPOSE = `services:
  api:
    image: \${API_IMAGE:?required — set the immutable tag}
    environment:
      JWT_SECRET: \${JWT_SECRET:?required in staging}
      PIN_PEPPER: \${PIN_PEPPER:?required in staging}
      EMAIL_PROVIDER: \${EMAIL_PROVIDER:-zeptomail}
  ai-service:
    image: \${AI_SERVICE_IMAGE:?required — set the immutable tag}
`;

// A minimal two-job workflow fixture. `includePinPepper` toggles the mutation under
// test: whether the deploy-lightsail job bridges secrets.PIN_PEPPER.
function ciWorkflowFixture({ includePinPepper }) {
  const pinPepperLine = includePinPepper ? "          PIN_PEPPER: ${{ secrets.PIN_PEPPER }}\n" : "";
  return `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@sha
        env:
          FOO_ONLY_IN_BUILD: \${{ secrets.FOO_ONLY_IN_BUILD }}
  deploy-lightsail:
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@sha
        env:
          JWT_SECRET: \${{ secrets.JWT_SECRET }}
          API_IMAGE: \${{ secrets.API_IMAGE }}
${pinPepperLine}          NOT_A_SECRET: some-computed-value
`;
}

test("extractIndentedBlocks splits into blocks by the 2-space header, scoped after the root key", () => {
  const blocks = extractIndentedBlocks(FIXTURE_COMPOSE, "services");
  assert.deepEqual([...blocks.keys()], ["api", "ai-service"]);
  assert.match(blocks.get("api"), /JWT_SECRET/);
  assert.doesNotMatch(blocks.get("ai-service"), /JWT_SECRET/);
});

test("extractIndentedBlocks throws a clear error when the root key is absent", () => {
  assert.throws(() => extractIndentedBlocks("foo: bar\n", "services"), /could not find/);
});

test("extractComposeRequiredVars finds only the :? (required) form, never :- (default/optional)", () => {
  const vars = extractComposeRequiredVars(FIXTURE_COMPOSE);
  assert.ok(vars.has("API_IMAGE"));
  assert.ok(vars.has("JWT_SECRET"));
  assert.ok(vars.has("PIN_PEPPER"));
  assert.ok(vars.has("AI_SERVICE_IMAGE"));
  assert.equal(vars.has("EMAIL_PROVIDER"), false, "the :- optional form must not count as required");
});

test("extractSecretRefs finds every ${{ secrets.NAME }} occurrence, deduped", () => {
  const text = "a: ${{ secrets.FOO }}\nb: ${{ secrets.FOO }}\nc: ${{ secrets.BAR }}\n";
  assert.deepEqual([...extractSecretRefs(text)].sort(), ["BAR", "FOO"]);
});

test("parseComposeRequiredVars returns one required-var Set per service", () => {
  const byService = parseComposeRequiredVars(FIXTURE_COMPOSE);
  assert.deepEqual([...byService.get("api")].sort(), ["API_IMAGE", "JWT_SECRET", "PIN_PEPPER"]);
  assert.deepEqual([...byService.get("ai-service")], ["AI_SERVICE_IMAGE"]);
});

test("parseWorkflowJobSecrets scopes to the named job only — a sibling job cannot leak in", () => {
  const secrets = parseWorkflowJobSecrets(ciWorkflowFixture({ includePinPepper: true }), "deploy-lightsail");
  assert.ok(secrets.has("JWT_SECRET"));
  assert.ok(secrets.has("PIN_PEPPER"));
  // "FOO_ONLY_IN_BUILD" is bridged by the sibling "build" job, not deploy-lightsail
  // — must not leak across the job boundary.
  assert.equal(secrets.has("FOO_ONLY_IN_BUILD"), false);
});

test("parseWorkflowJobSecrets throws a clear error when the named job does not exist", () => {
  assert.throws(
    () => parseWorkflowJobSecrets(ciWorkflowFixture({ includePinPepper: true }), "does-not-exist"),
    /not found/,
  );
});

// ---- the mutation-testing proof: the gate must be CAPABLE of failing ----

test("findMissing reports the api service clean when every required secret is bridged", () => {
  const required = parseComposeRequiredVars(FIXTURE_COMPOSE);
  const secrets = parseWorkflowJobSecrets(ciWorkflowFixture({ includePinPepper: true }), "deploy-lightsail");
  const missing = findMissing(required, secrets);
  assert.equal(missing.get("api"), undefined, "api must report nothing missing once PIN_PEPPER is bridged");
});

test("findMissing reports PIN_PEPPER missing the instant its secrets.NAME reference is removed (mutation)", () => {
  const required = parseComposeRequiredVars(FIXTURE_COMPOSE);
  // MUTATION: drop the PIN_PEPPER bridge from the workflow fixture — this is
  // structurally the exact real gap this checker exists to catch (staging-cd.yml is
  // currently missing secrets.PIN_PEPPER and secrets.ADMIN_JWT_SECRET relative to
  // docker-compose.staging.yml's required set).
  const secrets = parseWorkflowJobSecrets(ciWorkflowFixture({ includePinPepper: false }), "deploy-lightsail");
  const missing = findMissing(required, secrets);
  assert.deepEqual(missing.get("api"), ["PIN_PEPPER"]);
});

test("findMissing is empty (Map size 0) only when every service is fully covered", () => {
  const required = new Map([
    ["svc-a", new Set(["FOO"])],
    ["svc-b", new Set(["BAR"])],
  ]);
  assert.equal(findMissing(required, new Set(["FOO", "BAR"])).size, 0);
  assert.equal(findMissing(required, new Set(["FOO"])).size, 1);
});

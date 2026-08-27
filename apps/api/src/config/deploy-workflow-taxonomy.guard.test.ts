/**
 * The production deploy job ships CODE. It must never ship a SCHEMA CHANGE, a TAXONOMY SEED, or
 * a flipped feature flag as a side effect.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. `ci.yml` is 1,800 lines and was rewritten by 596
 * insertions in #996 alone. Nothing in review reliably catches a `db:seed:domains --apply` that
 * drifts from the ephemeral-postgres `e2e` job into the `deploy-lightsail` job — the two look
 * identical at a glance, and only one of them has production's DATABASE_URL in scope. The
 * Phase-9 posture (both taxonomy gates OFF, no seed, no migration from CD) is currently held by
 * comments and by whoever last read them.
 *
 * The four flags below are the owner's standing configuration, recorded so a change to any of
 * them has to be deliberate:
 *
 *   DOMAIN_MATCH_ENABLED       false   Path A's ANN fallback stays dark
 *   SKILL_CANONICALIZE_ENABLED false   /skills/canonicalize stays dark
 *   AI_ENABLE_REAL_CALLS       true    deliberate — profiling chat runs against a real provider
 *   AI_REAL_CALL_TASKS         profiling_chat_turn (compose default; NOT bridged from GitHub)
 *
 * The last one is the subtle one and the reason this file asserts an ABSENCE. Arming
 * `AI_ENABLE_REAL_CALLS` does not arm embeddings: `skill_embedding` has to be in
 * `AI_REAL_CALL_TASKS` as well, and that variable is deliberately not in the deploy job's
 * `envs:` bridge, so the box always takes docker-compose.staging.yml's default. Adding it to
 * the bridge would silently make a GitHub secret able to widen the real-call surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const STAGING_COMPOSE = readFileSync(join(ROOT, "docker-compose.staging.yml"), "utf8");

/**
 * The text of one top-level job, from its `  name:` line to the next one.
 *
 * Slicing by job matters: `db:seed:domains --apply` is CORRECT in `e2e` (ephemeral postgres
 * service) and catastrophic in `deploy-lightsail` (production DATABASE_URL). A whole-file grep
 * cannot tell those apart, so it would have to be either permanently red or permanently
 * useless.
 */
export function jobBlock(yaml: string, job: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`job '${job}' not found in ci.yml — it was renamed or removed`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * The same text with `#` comment lines dropped.
 *
 * This workflow carries more explanation than configuration, and several variables are
 * discussed in comments precisely BECAUSE they must not be set. An assertion that cannot tell
 * a comment from a bridge would forbid documenting the invariant it protects.
 */
export function uncommented(block: string): string {
  return block
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/**
 * THE DEPLOY IS NOW TWO FILES, AND THIS GUARD MUST SEE BOTH (#994).
 *
 * The job block no longer contains the deploy's commands: they live in
 * scripts/deploy/staging-deploy.sh, because the inline `script:` had reached ~97% of GitHub's
 * ~21 KB step-input ceiling — past which the whole workflow silently stops parsing and every
 * PR touching ci.yml is blocked with no stated reason.
 *
 * Concatenating is not a convenience here, it is the correctness fix. The four `not.toMatch`
 * assertions below — never migrate, never seed, never embed, never promote — would ALL have
 * started passing vacuously the moment the commands moved out of the job block, and this guard
 * would have gone quietly decorative while still reporting green. A guard that stops covering
 * the thing it names is worse than no guard.
 *
 * The `envs:`/`env:` bridge assertions still resolve against the YAML half, and the command
 * assertions against the script half; searching the concatenation satisfies both without
 * caring which file a given line ended up in.
 */
const DEPLOY = [
  jobBlock(CI, "deploy-lightsail"),
  readFileSync(join(ROOT, "scripts", "deploy", "staging-deploy.sh"), "utf8"),
].join("\n");

describe("deploy-lightsail — what it is allowed to do to production", () => {
  it("runs in the production GitHub Environment", () => {
    // Not cosmetic: the environment scope is what selects production's secrets AND what
    // interposes the required-reviewer approval before anything touches the box.
    expect(DEPLOY).toMatch(/^\s*environment:\s*production\s*$/m);
  });

  it.each([
    ["a migration", /db:migrate|drizzle-kit\s+migrate/],
    ["a seed", /db:seed[:\w-]*/],
    ["an embedding run", /db:embed[:\w-]*/],
    ["a taxonomy promotion", /db:promote|db:retag|db:normalize/],
  ])("never runs %s", (_what, pattern) => {
    // Schema and taxonomy changes are deliberate, reviewed, human-run operations. A deploy
    // that also migrates turns every merge into a production data change.
    //
    // Comments stripped for the same reason as the AI_REAL_CALL_TASKS absence below: a note
    // explaining that CD deliberately does not seed must not be what turns this red.
    expect(uncommented(DEPLOY)).not.toMatch(pattern);
  });

  it("the e2e job DOES seed — proving the assertions above discriminate by job", () => {
    // Without this, the four `not.toMatch` above would still pass if `jobBlock` silently
    // returned an empty string, and the guard would be decorative.
    const e2e = jobBlock(CI, "e2e");
    expect(e2e).toMatch(/db:seed:domains --apply/);
    expect(e2e).toMatch(/db:migrate/);
  });
});

describe("the four Phase-9 flags, as they reach the box", () => {
  // Regexes are literals rather than built from the flag name. Partly because semgrep's
  // detect-non-literal-regexp rule is right in general, and partly because a table of three
  // hardcoded patterns is easier to check by eye than one template that has to be mentally
  // expanded three times.
  it.each([
    ["DOMAIN_MATCH_ENABLED", /DOMAIN_MATCH_ENABLED:\s*\$\{\{\s*secrets\.DOMAIN_MATCH_ENABLED\s*\}\}/, /envs:[^\n]*\bDOMAIN_MATCH_ENABLED\b/],
    ["SKILL_CANONICALIZE_ENABLED", /SKILL_CANONICALIZE_ENABLED:\s*\$\{\{\s*secrets\.SKILL_CANONICALIZE_ENABLED\s*\}\}/, /envs:[^\n]*\bSKILL_CANONICALIZE_ENABLED\b/],
    ["AI_ENABLE_REAL_CALLS", /AI_ENABLE_REAL_CALLS:\s*\$\{\{\s*secrets\.AI_ENABLE_REAL_CALLS\s*\}\}/, /envs:[^\n]*\bAI_ENABLE_REAL_CALLS\b/],
  ])("%s is bridged from the environment's secrets", (_name, fromSecrets, inEnvs) => {
    expect(DEPLOY).toMatch(fromSecrets);
    // …and reaches the container: drone-ssh only exports what `envs:` lists, so a job-level
    // `env:` entry alone is invisible on the box. This is the exact defect #798 was.
    expect(DEPLOY).toMatch(inEnvs);
  });

  it("AI_REAL_CALL_TASKS is NOT bridged — the box always takes the compose default", () => {
    // The load-bearing absence. `AI_ENABLE_REAL_CALLS=true` arms only the tasks named in this
    // list; bridging it would let a GitHub secret add `skill_embedding` with no code review.
    //
    // Asserted against the two BRIDGE mechanisms rather than the bare name, because the job's
    // own comments discuss this variable at length — and a guard that forbids mentioning the
    // thing it protects would be deleted the first time someone documented it properly.
    const bridged = uncommented(DEPLOY);
    expect(bridged).not.toMatch(/AI_REAL_CALL_TASKS:\s*\$\{\{/);
    expect(bridged).not.toMatch(/envs:[^\n]*\bAI_REAL_CALL_TASKS\b/);
  });

  it.each([
    ["DOMAIN_MATCH_ENABLED", "false"],
    ["SKILL_CANONICALIZE_ENABLED", "false"],
    ["AI_REAL_CALL_TASKS", "profiling_chat_turn"],
  ])("docker-compose.staging.yml defaults %s to %s when the secret is absent or empty", (name, fallback) => {
    // `${VAR:-default}` (colon-dash) falls back on empty AS WELL AS unset. `${VAR-default}`
    // would let a secret that exists but is blank through as an empty string — which for a
    // boolean flag is a different value than "false" in some parsers, and is exactly the kind
    // of difference nobody notices until a gate is open in production.
    expect(STAGING_COMPOSE).toContain(`${name}: \${${name}:-${fallback}}`);
  });
});

describe("the FORK-B-1 skill seam — an absence that is deliberate and tracked", () => {
  // AUDITED 2026-08-27, read-only. `GET /internal/observability/canonicalization` reports
  // `storeConfigured: false`, and this is why: neither half of the seam is bridged to the
  // container. Canonicalization is a CHAIN — flag AND store — so with these absent, flipping
  // SKILL_CANONICALIZE_ENABLED arms a route that resolves NOTHING (`get_skill_store` returns
  // `NullSkillStore`, whose `nearest_aliases` returns []) while still paying for one embed
  // per phrase.
  //
  // THE ABSENCE IS NOT AN OVERSIGHT. docker-compose.staging.yml names SKILLS_INTERNAL_TOKEN in
  // a list of 14 string secrets deliberately left unbridged: each is a bare `.optional()` in
  // the zod schema rather than the `optionalSecret()` helper, so a `${VAR:-}` pass-through
  // would set it to a DECLARED EMPTY STRING — which `.optional()` REJECTS, crashing every boot
  // on the box. Wiring them needs the schema field converted first, per issue #858.
  //
  // These assertions pin a KNOWN, REASONED state, so that wiring the seam is a deliberate edit
  // that updates this test rather than a silent one that makes canonicalization write for real
  // without anyone re-reading the chain.
  //
  // Literal regexes, not `new RegExp(...)`, for the reason stated at the top of this file:
  // semgrep's detect-non-literal-regexp rule, and a short table being easier to check by eye.
  it.each([
    ["BACKEND_API_URL", /BACKEND_API_URL:\s*\$\{\{/, /envs:[^\n]*\bBACKEND_API_URL\b/],
    ["SKILLS_INTERNAL_TOKEN", /SKILLS_INTERNAL_TOKEN:\s*\$\{\{/, /envs:[^\n]*\bSKILLS_INTERNAL_TOKEN\b/],
  ])("%s is NOT bridged from the deploy job", (_name, fromSecrets, inEnvs) => {
    // Asserted on the UNCOMMENTED text for the same reason AI_REAL_CALL_TASKS is: a guard that
    // forbade MENTIONING the variable would be deleted the first time someone documented it.
    const bridged = uncommented(DEPLOY);
    expect(bridged).not.toMatch(fromSecrets);
    expect(bridged).not.toMatch(inEnvs);
  });

  /** The staging ai-service `environment:` keys, bounded to that service and comment-free. */
  const aiServiceEnvKeys = (): string[] => {
    const start = STAGING_COMPOSE.indexOf("\n  ai-service:");
    // Bounded to the NEXT top-level service. An unbounded slice runs to end-of-file and
    // silently collects every LATER service's keys — which is exactly how the first draft of
    // this test came to assert a five-key block that does not exist.
    const rest = STAGING_COMPOSE.slice(start + 3);
    const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
    const block = next === -1 ? rest : rest.slice(0, next);
    return [...uncommented(block).matchAll(/^ {6}([A-Z_]+):/gm)].map((m) => m[1]!);
  };

  it.each([["BACKEND_API_URL"], ["SKILLS_INTERNAL_TOKEN"]])(
    "%s has no pass-through in the staging ai-service block either",
    (name) => {
      // The second hop, and #813 proved it is independently load-bearing: a value exported on
      // the box reaches the container ONLY if compose declares a pass-through. ZeptoMail failed
      // closed for months on exactly this gap.
      expect(aiServiceEnvKeys()).not.toContain(name);
    },
  );

  it("the ai-service DOES receive the flag, which is what makes the missing store the binding gap", () => {
    // The positive half, and the asymmetry is the finding: the flag is wired end-to-end while
    // neither half of the store is. Enabling canonicalization today would therefore arm a route
    // that cannot resolve anything — not a partial success, a complete no-op that still spends.
    const keys = aiServiceEnvKeys();
    expect(keys).toContain("SKILL_CANONICALIZE_ENABLED");
    expect(keys.length).toBeGreaterThan(5);
  });

  it("records WHY, so the next reader does not mistake the absence for a bug", () => {
    // If this reasoning disappears, the assertions above become unexplained prohibitions.
    expect(STAGING_COMPOSE).toContain("SKILLS_INTERNAL_TOKEN");
    expect(STAGING_COMPOSE).toContain("#858");
    expect(STAGING_COMPOSE).toContain("optionalSecret()");
  });

  it("the api-side guard fails CLOSED when the token is unset, so an unbridged seam cannot half-open", () => {
    const guard = readFileSync(
      join(ROOT, "apps", "api", "src", "skills", "skills-internal.guard.ts"),
      "utf8",
    );
    // No fallback to INTERNAL_SERVICE_TOKEN and no "allow when unconfigured" branch: absent
    // configuration must DENY, never degrade to open.
    expect(guard).toMatch(/if \(!expected\) \{/);
    expect(guard).toMatch(/throw new UnauthorizedException\("skills internal auth is not configured"\)/);
    expect(guard).not.toMatch(/config\.INTERNAL_SERVICE_TOKEN/);
  });
});

describe("R38 — why the compose loopback fix cannot reach the running containers", () => {
  it("the deploy starts the api with --no-deps, so adminer/postgres never start from CD", () => {
    // This is the whole reason R38 has a residual. CD runs `up ... --no-deps api`, so the
    // compose-internal postgres and adminer are never created BY A DEPLOY — which also means
    // a deploy will never RE-create them with the corrected loopback binds. The containers
    // running on the box came from a bare `up -d` and will keep their 0.0.0.0 binds until
    // someone removes them by hand. The base-file fix is a guard against the next bare `up`,
    // not a remedy for the current exposure.
    expect(DEPLOY).toMatch(/--no-deps\s+api/);
  });

  it("the compose overlay still records that a bare `up -d` would start them", () => {
    expect(STAGING_COMPOSE).toMatch(/NEVER run this overlay with a bare `up -d`/);
  });
});

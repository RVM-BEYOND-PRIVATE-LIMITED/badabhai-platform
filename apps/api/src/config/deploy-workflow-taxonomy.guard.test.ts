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
    [
      "DOMAIN_MATCH_ENABLED",
      /DOMAIN_MATCH_ENABLED:\s*\$\{\{\s*secrets\.DOMAIN_MATCH_ENABLED\s*\}\}/,
      /envs:[^\n]*\bDOMAIN_MATCH_ENABLED\b/,
    ],
    [
      "SKILL_CANONICALIZE_ENABLED",
      /SKILL_CANONICALIZE_ENABLED:\s*\$\{\{\s*secrets\.SKILL_CANONICALIZE_ENABLED\s*\}\}/,
      /envs:[^\n]*\bSKILL_CANONICALIZE_ENABLED\b/,
    ],
    [
      "AI_ENABLE_REAL_CALLS",
      /AI_ENABLE_REAL_CALLS:\s*\$\{\{\s*secrets\.AI_ENABLE_REAL_CALLS\s*\}\}/,
      /envs:[^\n]*\bAI_ENABLE_REAL_CALLS\b/,
    ],
    // #1350 — the section-8 override switch. Bridged like the three above because it is a
    // plain boolean feature flag; contrast AI_REAL_CALL_TASKS below, which is a SCOPE
    // decision and is deliberately not bridged at all.
    [
      "WORK_HISTORY_POLISH_ENABLED",
      /WORK_HISTORY_POLISH_ENABLED:\s*\$\{\{\s*secrets\.WORK_HISTORY_POLISH_ENABLED\s*\}\}/,
      /envs:[^\n]*\bWORK_HISTORY_POLISH_ENABLED\b/,
    ],
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
    ["WORK_HISTORY_POLISH_ENABLED", "false"],
  ])(
    "docker-compose.staging.yml defaults %s to %s when the secret is absent or empty",
    (name, fallback) => {
      // `${VAR:-default}` (colon-dash) falls back on empty AS WELL AS unset. `${VAR-default}`
      // would let a secret that exists but is blank through as an empty string — which for a
      // boolean flag is a different value than "false" in some parsers, and is exactly the kind
      // of difference nobody notices until a gate is open in production.
      expect(STAGING_COMPOSE).toContain(`${name}: \${${name}:-${fallback}}`);
    },
  );
});

/**
 * The `environment:` keys one compose service declares, comment-free.
 *
 * Bounded to the NEXT top-level service on purpose: an unbounded slice runs to end-of-file and
 * silently collects every LATER service's keys, which is how the first draft of this file came
 * to assert a five-key ai-service block that does not exist.
 */
function envKeysOf(service: string): string[] {
  const start = STAGING_COMPOSE.indexOf(`\n  ${service}:`);
  const rest = STAGING_COMPOSE.slice(start + 3);
  const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
  const block = next === -1 ? rest : rest.slice(0, next);
  return [...uncommented(block).matchAll(/^ {6}([A-Z_]+):/gm)].map((m) => m[1]!);
}

describe("the FORK-B-1 skill seam — bridged, and inert until a secret exists", () => {
  // INVERTED 2026-08-27, and the inversion is the point. Yesterday this block asserted these
  // two were NOT bridged, and recorded WHY: SKILLS_INTERNAL_TOKEN was one of 14 string secrets
  // that could not be bridged because a `${VAR:-}` pass-through sets the variable to the EMPTY
  // STRING, and a bare `.optional()` REJECTS "" — crashing every api boot on the box.
  //
  // #858 removed the blocker rather than routing around it: both tokens are `optionalSecret()`
  // in packages/config/src/server.ts, and the ai-service applies the same rule in
  // `_empty_secret_means_unset`. So "" now reads as UNSET on both sides and the bridge is safe.
  //
  // WHAT THIS DOES NOT DO. Bridging the seam does not enable canonicalization. That is
  // SKILL_CANONICALIZE_ENABLED, asserted false-by-default above and unchanged here. Wiring the
  // store makes canonicalization POSSIBLE, not ACTIVE — and the two must stay independent,
  // which is exactly what the ai-service's own matrix test pins.
  const aiServiceEnvKeys = (): string[] => envKeysOf("ai-service");
  const apiEnvKeys = (): string[] => envKeysOf("api");

  it.each([
    [
      "SKILLS_INTERNAL_TOKEN",
      /SKILLS_INTERNAL_TOKEN:\s*\$\{\{\s*secrets\.SKILLS_INTERNAL_TOKEN\s*\}\}/,
      /envs:[^\n]*\bSKILLS_INTERNAL_TOKEN\b/,
    ],
    [
      "AI_INTERNAL_TOKEN",
      /AI_INTERNAL_TOKEN:\s*\$\{\{\s*secrets\.AI_INTERNAL_TOKEN\s*\}\}/,
      /envs:[^\n]*\bAI_INTERNAL_TOKEN\b/,
    ],
  ])("%s is bridged through BOTH hops", (_name, fromSecrets, inEnvs) => {
    // Both, because either alone is inert: a job-level `env:` entry that drone-ssh does not
    // export is invisible on the box. That is precisely what #798 was.
    expect(DEPLOY).toMatch(fromSecrets);
    expect(DEPLOY).toMatch(inEnvs);
  });

  it("BACKEND_API_URL is NOT bridged from a secret — it is topology, not a credential", () => {
    // The compose default names the api over the compose network. Bridging it from a GitHub
    // secret would let one repository setting silently re-point the seam at an arbitrary host,
    // which is a bigger permission than the value deserves.
    const bridged = uncommented(DEPLOY);
    expect(bridged).not.toMatch(/BACKEND_API_URL:\s*\$\{\{/);
    expect(bridged).not.toMatch(/envs:[^\n]*\bBACKEND_API_URL\b/);
  });

  it("the ai-service receives all three, so the store can be configured at all", () => {
    const keys = aiServiceEnvKeys();
    expect(keys).toContain("BACKEND_API_URL");
    expect(keys).toContain("SKILLS_INTERNAL_TOKEN");
    expect(keys).toContain("AI_INTERNAL_TOKEN");
  });

  it("the api receives BOTH ends of the two service-to-service tokens", () => {
    // The seam has two directions and they are different secrets:
    //   api  --x-skills-internal-token-->  api's own SkillsInternalGuard  (ai-service calls in)
    //   api  --x-ai-internal-token------>  ai-service's TD67 middleware   (api calls out)
    // Wiring one without the other yields a half-open topology where one direction 401s.
    const keys = apiEnvKeys();
    expect(keys).toContain("SKILLS_INTERNAL_TOKEN");
    expect(keys).toContain("AI_INTERNAL_TOKEN");
  });

  it.each([["SKILLS_INTERNAL_TOKEN"], ["AI_INTERNAL_TOKEN"], ["BACKEND_API_URL"]])(
    "%s uses the empty-tolerant `${VAR:-...}` form, never `${VAR:?}`",
    (name) => {
      // `:-` substitutes on empty AS WELL AS unset, which is the whole reason an absent secret
      // is survivable. `:?` would make an unset secret a hard compose failure and turn "the seam
      // is not armed yet" into "the box will not start".
      const pattern = `\${${name}:-`;
      expect(STAGING_COMPOSE).toContain(pattern);
      expect(STAGING_COMPOSE).not.toContain(`\${${name}:?`);
    },
  );

  it("an ABSENT secret must not become a REQUIRED empty string — the #858 property itself", () => {
    // The assertion that would have caught the original blocker. A `${VAR:-}` pass-through
    // hands the schema "", so every bridged secret here has to be empty-tolerant. A bare
    // `.optional()` is not: it accepts `undefined` and rejects "".
    const SERVER = readFileSync(join(ROOT, "packages", "config", "src", "server.ts"), "utf8");
    expect(SERVER).toMatch(/SKILLS_INTERNAL_TOKEN:\s*optionalSecret\(/);
    expect(SERVER).toMatch(/AI_INTERNAL_TOKEN:\s*optionalSecret\(/);
    // ...and the helper still only reclassifies the empty string, so a malformed non-empty
    // value is rejected exactly as before.
    expect(SERVER).toContain('z.preprocess((v) => (v === "" ? undefined : v), schema.optional())');
  });

  it("the flag is STILL present and STILL false-by-default — wiring the store armed nothing", () => {
    expect(aiServiceEnvKeys()).toContain("SKILL_CANONICALIZE_ENABLED");
    expect(STAGING_COMPOSE).toContain(
      "SKILL_CANONICALIZE_ENABLED: ${SKILL_CANONICALIZE_ENABLED:-false}",
    );
  });

  it("the api-side guard still fails CLOSED when the token is unset", () => {
    const guard = readFileSync(
      join(ROOT, "apps", "api", "src", "skills", "skills-internal.guard.ts"),
      "utf8",
    );
    // No fallback to INTERNAL_SERVICE_TOKEN and no "allow when unconfigured" branch: absent
    // configuration must DENY, never degrade to open. Bridging the variable did not touch this.
    expect(guard).toMatch(/if \(!expected\) \{/);
    expect(guard).toMatch(
      /throw new UnauthorizedException\("skills internal auth is not configured"\)/,
    );
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

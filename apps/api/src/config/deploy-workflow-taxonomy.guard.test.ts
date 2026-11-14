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
 * `envs:` bridge, so no GitHub secret can reach it: the container gets
 * docker-compose.staging.yml's default unless the box's own environment sets the variable
 * (the production box does — #1843). Adding it to the bridge would silently make a GitHub
 * secret able to widen the real-call surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serverEnvSchema } from "@badabhai/config";
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
    // RI-autofill kill switch (owner override B, 2026-09-20, of ruling D2). Bridged like
    // the plain boolean flags above because that is what it is: the D2-override write
    // half. Contrast AI_REAL_CALL_TASKS below, which stays a box-side scope decision.
    [
      "RESUME_AUTOFILL_ENABLED",
      /RESUME_AUTOFILL_ENABLED:\s*\$\{\{\s*secrets\.RESUME_AUTOFILL_ENABLED\s*\}\}/,
      /envs:[^\n]*\bRESUME_AUTOFILL_ENABLED\b/,
    ],
    // Token-audit fix Q10 — a typed tenure answer resolves the form's experience gates. A plain
    // boolean; the environment secret is its one arming path, and absent it is today's form.
    [
      "FORM_TYPED_TENURE_DERIVE_ENABLED",
      /FORM_TYPED_TENURE_DERIVE_ENABLED:\s*\$\{\{\s*secrets\.FORM_TYPED_TENURE_DERIVE_ENABLED\s*\}\}/,
      /envs:[^\n]*\bFORM_TYPED_TENURE_DERIVE_ENABLED\b/,
    ],
    // Audit fix F4 — a plain boolean that stops a model call whose output nothing uses. The
    // environment secret is its one arming path; absent, today's behaviour holds.
    [
      "RESUME_OPTION_MAP_REQUIRES_AUTOFILL",
      /RESUME_OPTION_MAP_REQUIRES_AUTOFILL:\s*\$\{\{\s*secrets\.RESUME_OPTION_MAP_REQUIRES_AUTOFILL\s*\}\}/,
      /envs:[^\n]*\bRESUME_OPTION_MAP_REQUIRES_AUTOFILL\b/,
    ],
    // ADR-0045 — the general road. A plain boolean flag, and the ONLY way it turns on in
    // production is the environment secret, so the bridge is the switch.
    [
      "CHAT_GENERAL_ROAD_ENABLED",
      /CHAT_GENERAL_ROAD_ENABLED:\s*\$\{\{\s*secrets\.CHAT_GENERAL_ROAD_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_GENERAL_ROAD_ENABLED\b/,
    ],
    // Token-audit fix Q2 — off-topic chat kept out of the extraction, and no city from it. Plain
    // booleans; the environment secrets are their one arming path, and absent they are today.
    [
      "PROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED",
      /PROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED:\s*\$\{\{\s*secrets\.PROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED\s*\}\}/,
      /envs:[^\n]*\bPROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED\b/,
    ],
    [
      "CHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED",
      /CHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED:\s*\$\{\{\s*secrets\.CHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED\b/,
    ],
    // ADR-0057 (#2311) — the profiling turn, understood. A plain boolean flag, turned on in
    // production ONLY by the environment secret, after the eval PASS and the box arming.
    [
      "CHAT_TURN_UNDERSTANDING_ENABLED",
      /CHAT_TURN_UNDERSTANDING_ENABLED:\s*\$\{\{\s*secrets\.CHAT_TURN_UNDERSTANDING_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_TURN_UNDERSTANDING_ENABLED\b/,
    ],
    // Token-audit fix F3 — the form offer before the model on a tapped Haan. A plain boolean;
    // the environment secret is its one arming path, and absent it is today's interview.
    [
      "CHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED",
      /CHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED:\s*\$\{\{\s*secrets\.CHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED\b/,
    ],
    // ADR-0048 (#1858) — the identity intake. A plain boolean flag, turned on in production ONLY
    // by the environment secret, in the same release that unroutes the app's /name screen.
    [
      "CHAT_IDENTITY_INTAKE_ENABLED",
      /CHAT_IDENTITY_INTAKE_ENABLED:\s*\$\{\{\s*secrets\.CHAT_IDENTITY_INTAKE_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_IDENTITY_INTAKE_ENABLED\b/,
    ],
    // ADR-0051 (#2027) — the free chat's KILL SWITCH. The feature is live on merge; the
    // environment secret is the ONLY way to turn it off in production, so the bridge is the lever.
    [
      "CHAT_FREE_CHAT_DISABLED",
      /CHAT_FREE_CHAT_DISABLED:\s*\$\{\{\s*secrets\.CHAT_FREE_CHAT_DISABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_FREE_CHAT_DISABLED\b/,
    ],
    // #1801 — résumé skins. A plain boolean flag, turned on in production ONLY by the
    // environment secret, after migration 0128 is applied — so the bridge is the switch.
    [
      "RESUME_SKINS_ENABLED",
      /RESUME_SKINS_ENABLED:\s*\$\{\{\s*secrets\.RESUME_SKINS_ENABLED\s*\}\}/,
      /envs:[^\n]*\bRESUME_SKINS_ENABLED\b/,
    ],
    // #1800 — the résumé QR scan. A plain boolean flag, turned on in production ONLY by the
    // environment secret, after migration 0129 and the badabhai.ai /r/* redirect.
    [
      "RESUME_QR_SCAN_ENABLED",
      /RESUME_QR_SCAN_ENABLED:\s*\$\{\{\s*secrets\.RESUME_QR_SCAN_ENABLED\s*\}\}/,
      /envs:[^\n]*\bRESUME_QR_SCAN_ENABLED\b/,
    ],
    // ADR-0046 — the companion v2 phase gates. Plain boolean flags; production ON additionally
    // requires the ADR's signature with companion v1 live, and real calls need the box to widen
    // the ai-service's AI_REAL_CALL_TASKS allowlist (an env action, not this bridge).
    [
      "CHAT_COMPANION_V2_ENABLED",
      /CHAT_COMPANION_V2_ENABLED:\s*\$\{\{\s*secrets\.CHAT_COMPANION_V2_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_COMPANION_V2_ENABLED\b/,
    ],
    [
      "CHAT_COMPANION_V2_EDIT_ENABLED",
      /CHAT_COMPANION_V2_EDIT_ENABLED:\s*\$\{\{\s*secrets\.CHAT_COMPANION_V2_EDIT_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_COMPANION_V2_EDIT_ENABLED\b/,
    ],
    [
      "CHAT_COMPANION_V2_NEW_RESUME_ENABLED",
      /CHAT_COMPANION_V2_NEW_RESUME_ENABLED:\s*\$\{\{\s*secrets\.CHAT_COMPANION_V2_NEW_RESUME_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_COMPANION_V2_NEW_RESUME_ENABLED\b/,
    ],
    [
      "CHAT_COMPANION_V2_FALTU_ENABLED",
      /CHAT_COMPANION_V2_FALTU_ENABLED:\s*\$\{\{\s*secrets\.CHAT_COMPANION_V2_FALTU_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_COMPANION_V2_FALTU_ENABLED\b/,
    ],
    [
      "CHAT_COMPANION_V2_CAREER_ENABLED",
      /CHAT_COMPANION_V2_CAREER_ENABLED:\s*\$\{\{\s*secrets\.CHAT_COMPANION_V2_CAREER_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_COMPANION_V2_CAREER_ENABLED\b/,
    ],
    // TD146 (WP6) — route precedence. A plain boolean flag; default false, so the bridge
    // holds it off until the environment secret exists and the owner turns it on.
    [
      "CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED",
      /CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED:\s*\$\{\{\s*secrets\.CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED\s*\}\}/,
      /envs:[^\n]*\bCHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED\b/,
    ],
    // ADR-0047 (owner decision 2026-09-30) — raw text to the model. A plain boolean read by
    // BOTH services, and the owner chose the environment secret as its one arming path, so the
    // bridge is the switch: `gh secret set AI_RAW_PII_ENABLED --env production` plus a redeploy.
    [
      "AI_RAW_PII_ENABLED",
      /AI_RAW_PII_ENABLED:\s*\$\{\{\s*secrets\.AI_RAW_PII_ENABLED\s*\}\}/,
      /envs:[^\n]*\bAI_RAW_PII_ENABLED\b/,
    ],
    // ADR-0036 §8 (#1904) — the Matching V1 cutover gate. A plain boolean on the api only, and
    // the environment secret is its one arming path. No secret exists, so the bridge holds it off.
    [
      "MATCH_V1_ENABLED",
      /MATCH_V1_ENABLED:\s*\$\{\{\s*secrets\.MATCH_V1_ENABLED\s*\}\}/,
      /envs:[^\n]*\bMATCH_V1_ENABLED\b/,
    ],
    // #1823 / ADR-0049 — company postings on the legacy feed (the interim union). A plain
    // boolean, armed in production ONLY by the environment secret plus a redeploy, after the
    // ADR-0049 pre-arm checklist — so the bridge is the switch.
    [
      "FEED_POSTINGS_UNION_ENABLED",
      /FEED_POSTINGS_UNION_ENABLED:\s*\$\{\{\s*secrets\.FEED_POSTINGS_UNION_ENABLED\s*\}\}/,
      /envs:[^\n]*\bFEED_POSTINGS_UNION_ENABLED\b/,
    ],
    // ADR-0050 (#1957) — the agency twin sync's kill switch. A plain boolean on the api only;
    // the environment secret is its one arming path, so absent it holds the sync disarmed.
    [
      "AGENCY_TWIN_SYNC_ENABLED",
      /AGENCY_TWIN_SYNC_ENABLED:\s*\$\{\{\s*secrets\.AGENCY_TWIN_SYNC_ENABLED\s*\}\}/,
      /envs:[^\n]*\bAGENCY_TWIN_SYNC_ENABLED\b/,
    ],
    // Owner ruling 2026-10-07 — the payer applicant pipeline board. A plain boolean on the api
    // only, turned on in production ONLY by the environment secret, after migration 0134.
    [
      "PAYER_APPLICANT_STAGES_ENABLED",
      /PAYER_APPLICANT_STAGES_ENABLED:\s*\$\{\{\s*secrets\.PAYER_APPLICANT_STAGES_ENABLED\s*\}\}/,
      /envs:[^\n]*\bPAYER_APPLICANT_STAGES_ENABLED\b/,
    ],
    // Engine v1.1 (ADR-0061, #2613) — the "Level needed" applicant sort. A plain boolean on the
    // api only, turned on in production ONLY by the environment secret.
    [
      "LEVEL_NEEDED_SORT_ENABLED",
      /LEVEL_NEEDED_SORT_ENABLED:\s*\$\{\{\s*secrets\.LEVEL_NEEDED_SORT_ENABLED\s*\}\}/,
      /envs:[^\n]*\bLEVEL_NEEDED_SORT_ENABLED\b/,
    ],
    // ADR-0053 (PAY-DB-01) — payer org tenancy (off | shadow | on), api only. The environment
    // secret is its one arming path (owner decision O-8); absent, the bridge holds it off.
    [
      "PAYER_ORG_TENANCY_MODE",
      /PAYER_ORG_TENANCY_MODE:\s*\$\{\{\s*secrets\.PAYER_ORG_TENANCY_MODE\s*\}\}/,
      /envs:[^\n]*\bPAYER_ORG_TENANCY_MODE\b/,
    ],
    // #2746 — the rollout switches (off | pilot | on), api only. The environment secret is each
    // one's arming path; absent, the bridge holds it off.
    [
      "JOB_AUDIENCE_ROLLOUT",
      /JOB_AUDIENCE_ROLLOUT:\s*\$\{\{\s*secrets\.JOB_AUDIENCE_ROLLOUT\s*\}\}/,
      /envs:[^\n]*\bJOB_AUDIENCE_ROLLOUT\b/,
    ],
    [
      "CAMPUS_DRIVE_REQUESTS_ROLLOUT",
      /CAMPUS_DRIVE_REQUESTS_ROLLOUT:\s*\$\{\{\s*secrets\.CAMPUS_DRIVE_REQUESTS_ROLLOUT\s*\}\}/,
      /envs:[^\n]*\bCAMPUS_DRIVE_REQUESTS_ROLLOUT\b/,
    ],
    // #2509 — the per-IP hourly cap on public payer auth. A plain tuning number, not a
    // secret in the confidentiality sense, but bridged through `secrets.*` like the other
    // numbers so a deploy does not depend on the box's shell state; absent, compose holds
    // it at the zod default (20) — byte-identical to today.
    [
      "PAYER_AUTH_MAX_PER_IP_PER_HOUR",
      /PAYER_AUTH_MAX_PER_IP_PER_HOUR:\s*\$\{\{\s*secrets\.PAYER_AUTH_MAX_PER_IP_PER_HOUR\s*\}\}/,
      /envs:[^\n]*\bPAYER_AUTH_MAX_PER_IP_PER_HOUR\b/,
    ],
  ])("%s is bridged from the environment's secrets", (_name, fromSecrets, inEnvs) => {
    expect(DEPLOY).toMatch(fromSecrets);
    // …and reaches the container: drone-ssh only exports what `envs:` lists, so a job-level
    // `env:` entry alone is invisible on the box. This is the exact defect #798 was.
    expect(DEPLOY).toMatch(inEnvs);
  });

  it("REFERRAL_SHORT_LINK_BASE is NOT bridged — a redirect destination is topology, not a secret", () => {
    // #1800. The BACKEND_API_URL rule: bridging it would let one repository setting re-point every
    // `/r/` redirect at an arbitrary host. It changes in a reviewed diff to the compose file.
    const bridged = uncommented(DEPLOY);
    expect(bridged).not.toMatch(/REFERRAL_SHORT_LINK_BASE:\s*\$\{\{/);
    expect(bridged).not.toMatch(/envs:[^\n]*\bREFERRAL_SHORT_LINK_BASE\b/);
  });

  it("AI_REAL_CALL_TASKS is NOT bridged — no GitHub secret can widen the real-call surface", () => {
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

  it("AI_REAL_CALL_TASKS_DENY is NOT bridged either — real-call scope stays a box decision", () => {
    // Audit fix F1. The deny list can only narrow the surface, so bridging it would be less
    // dangerous than bridging the allowlist — but it is the same scope decision, and splitting
    // one decision across two arming paths is how a half-flip happens.
    const bridged = uncommented(DEPLOY);
    expect(bridged).not.toMatch(/AI_REAL_CALL_TASKS_DENY:\s*\$\{\{/);
    expect(bridged).not.toMatch(/envs:[^\n]*\bAI_REAL_CALL_TASKS_DENY\b/);
  });

  it.each([
    ["DOMAIN_MATCH_ENABLED", "false"],
    ["SKILL_CANONICALIZE_ENABLED", "false"],
    ["AI_REAL_CALL_TASKS", "profiling_chat_turn"],
    ["WORK_HISTORY_POLISH_ENABLED", "false"],
    ["RESUME_AUTOFILL_ENABLED", "false"],
    // Fix Q10 — false is today's form: a typed tenure resolves no experience gate.
    ["FORM_TYPED_TENURE_DERIVE_ENABLED", "false"],
    // Audit fix F4 — false is today's behaviour: the option-map call runs as before.
    ["RESUME_OPTION_MAP_REQUIRES_AUTOFILL", "false"],
    ["CHAT_GENERAL_ROAD_ENABLED", "false"],
    // Fix Q2 — false is today's interview and extraction: nothing flagged, skipped or guarded.
    ["PROFILE_EXTRACT_SKIP_CHAT_TURNS_ENABLED", "false"],
    ["CHAT_SIDE_MESSAGE_CITY_GUARD_ENABLED", "false"],
    ["CHAT_TURN_UNDERSTANDING_ENABLED", "false"],
    // Fix A-14 — box-side only (no bridge), like its deletion neighbours; false is today: delete,
    // then emit.
    ["ACCOUNT_DELETION_EVENT_IN_TX", "false"],
    // Fix F3 — false is today's interview: the Haan turn calls the model.
    ["CHAT_TRADE_OFFER_BEFORE_MODEL_ENABLED", "false"],
    ["CHAT_IDENTITY_INTAKE_ENABLED", "false"],
    // ADR-0051 — the kill switch's absent value is false, which keeps the free chat ON.
    ["CHAT_FREE_CHAT_DISABLED", "false"],
    ["RESUME_SKINS_ENABLED", "false"],
    ["RESUME_QR_SCAN_ENABLED", "false"],
    // ADR-0046 — the companion v2 phase gates, all five off by default; TD146 (WP6) adds the
    // route-precedence switch, also off by default (v1 byte-for-byte).
    ["CHAT_COMPANION_V2_ENABLED", "false"],
    ["CHAT_COMPANION_V2_EDIT_ENABLED", "false"],
    ["CHAT_COMPANION_V2_NEW_RESUME_ENABLED", "false"],
    ["CHAT_COMPANION_V2_FALTU_ENABLED", "false"],
    ["CHAT_COMPANION_V2_CAREER_ENABLED", "false"],
    ["CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED", "false"],
    // ADR-0047 — off is the masked prompt path exactly. Declared on BOTH services; the
    // per-service assertion is ai-raw-pii-flag-compose.guard.test.ts.
    ["AI_RAW_PII_ENABLED", "false"],
    // ADR-0036 §8 (#1904) — off is the legacy feed / apply / candidate source exactly.
    ["MATCH_V1_ENABLED", "false"],
    // #1823 / ADR-0049 — off is today's legacy feed and apply/skip, byte for byte.
    ["FEED_POSTINGS_UNION_ENABLED", "false"],
    // ADR-0050 — off is the kill switch (twins paused); none exist until it is armed.
    ["AGENCY_TWIN_SYNC_ENABLED", "false"],
    // Owner ruling 2026-10-07; ON by default since #2737 — the saved board writes and filters
    // without a client opt-in. The secret still kills it (`false`) with no code change.
    ["PAYER_APPLICANT_STAGES_ENABLED", "true"],
    // ADR-0061 — off is today's applicant list: the v1.0 ORDER BY, no level read, levelFit null.
    ["LEVEL_NEEDED_SORT_ENABLED", "false"],
    // #2752 — off is no Campus route at all: a neutral 404 before any token, address or audit.
    ["CAMPUS_LINK_ENABLED", "false"],
    // ADR-0053 — off keys every payer read to the login: the pre-ADR behaviour, byte for byte.
    ["PAYER_ORG_TENANCY_MODE", "off"],
    // #2746 — off accepts no new field and mounts no new route; stored audience and review state
    // are honoured whatever the switch says (a switch gates capabilities, never restrictions).
    ["JOB_AUDIENCE_ROLLOUT", "off"],
    ["CAMPUS_DRIVE_REQUESTS_ROLLOUT", "off"],
    // #2509 — the zod default: 20/hour/IP until the secret (or a box export) says otherwise.
    ["PAYER_AUTH_MAX_PER_IP_PER_HOUR", "20"],
    // #1800 — not a flag but the resolver's redirect destination: the origin serving payer-web's
    // `/i/<code>`. Undeclared, the stale config default (app.badabhai.in, no `/i/`) won.
    ["REFERRAL_SHORT_LINK_BASE", "https://payer.43-204-36-199.sslip.io"],
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

describe("#2542 / TD25 — TRUST_PROXY_HOP_COUNT reaches the api, dormant until the secret exists", () => {
  // The hop count keys EVERY per-IP cap: 0 is the socket peer (one shared bucket behind the host
  // nginx), 1 is the visitor nginx appended. It reaches the container only through all five links
  // the deploy step's own comment lists, and the preflight is the only thing that stops a value
  // the schema WOULD accept (2, 3, ...) from making a client-written X-Forwarded-For entry trusted.
  const BASE_COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const SCRIPT = uncommented(
    readFileSync(join(ROOT, "scripts", "deploy", "staging-deploy.sh"), "utf8"),
  );
  const PASS_THROUGH = "TRUST_PROXY_HOP_COUNT: ${TRUST_PROXY_HOP_COUNT:-0}";
  const field = serverEnvSchema.shape.TRUST_PROXY_HOP_COUNT;

  const preflight =
    /case "\$\{TRUST_PROXY_HOP_COUNT-\}" in\n\s*([^\n)]*)\)\s*;;\n\s*\*\)([\s\S]*?)\n\s*;;\nesac/.exec(
      SCRIPT,
    );

  it("is bridged through BOTH hops — the env: line and the envs: allowlist", () => {
    // Either alone is inert: an `env:` entry drone-ssh does not export never reaches the box.
    const bridged = uncommented(DEPLOY);
    expect(bridged).toMatch(
      /TRUST_PROXY_HOP_COUNT:\s*\$\{\{\s*secrets\.TRUST_PROXY_HOP_COUNT\s*\}\}/,
    );
    expect(bridged).toMatch(/envs:[^\n]*\bTRUST_PROXY_HOP_COUNT\b/);
  });

  it("the PRODUCTION overlay declares it on the api, defaulting to 0, never fail-loud", () => {
    // Declared in the overlay itself rather than inherited from the base file's dev
    // proxy-harness line, so tidying that line away cannot silently disarm production.
    expect(envKeysOf("api")).toContain("TRUST_PROXY_HOP_COUNT");
    expect(STAGING_COMPOSE).toContain(PASS_THROUGH);
    expect(STAGING_COMPOSE).not.toContain("${TRUST_PROXY_HOP_COUNT:?");
  });

  it("the overlay and the base file use the same expression, so the merge changes nothing", () => {
    expect(BASE_COMPOSE).toContain(PASS_THROUGH);
  });

  it("the deploy accepts exactly empty, 0 and 1 — and refuses with an exit", () => {
    expect(preflight, "the TRUST_PROXY_HOP_COUNT case block is missing or reshaped").not.toBeNull();
    const accepted = (preflight?.[1] ?? "")
      .split("|")
      .map((alternative) => alternative.trim().replace(/^"(.*)"$/, "$1"));
    expect([...accepted].sort()).toEqual(["", "0", "1"]);
    const refusal = preflight?.[2] ?? "";
    expect(refusal).toMatch(/echo "::error::TRUST_PROXY_HOP_COUNT must be exactly/);
    expect(refusal).toMatch(/\n\s*exit 1$/);
  });

  it("never echoes the value, only the name", () => {
    expect(preflight?.[2] ?? "").not.toMatch(/\$\{?TRUST_PROXY_HOP_COUNT/);
  });

  it("runs before the first prune, pull or recreate", () => {
    const at = SCRIPT.indexOf('case "${TRUST_PROXY_HOP_COUNT-}" in');
    expect(at).toBeGreaterThan(-1);
    for (const command of ["docker image prune", "$COMPOSE pull", "$COMPOSE up"]) {
      expect(SCRIPT.indexOf(command), `${command} runs before the preflight`).toBeGreaterThan(at);
    }
  });

  it("everything the preflight accepts, the api boots on — and unset is dormant", () => {
    expect(field.parse(undefined)).toBe(0);
    expect(field.parse("")).toBe(0);
    expect(field.parse("0")).toBe(0);
    expect(field.parse("1")).toBe(1);
  });

  it("the schema alone would accept a spoofable 2, which is why the preflight exists", () => {
    // A guard tested only for what it refuses can drift into refusing nothing. This pins the
    // gap the preflight closes: the api would boot on 2 and trust a client-written entry.
    expect(field.safeParse("2").success).toBe(true);
    expect(field.safeParse("abc").success).toBe(false);
  });
});

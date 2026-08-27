/**
 * THE CONSOLE'S MIRROR, CHECKED AGAINST THE SCHEMA THAT WILL JUDGE IT.
 *
 * `apps/admin-web` does not import this service's types — it cannot, there is no dependency — so
 * the Skill Discovery review UI (#1260) carries a HAND-WRITTEN MIRROR of this contract in
 * `lib/skill-discovery-vocabulary.ts` and `lib/skill-discovery.ts`. That was the instruction in
 * the frontend issue and it is the right shape for a Next app. It also means the two sides can
 * drift, and nothing until now could notice.
 *
 * ── WHY A MIRROR DRIFTS SILENTLY, AND WHY GREEN SUITES DO NOT HELP ──────────────────────
 * Both sides test against themselves. The console's tests post its own request type to a mocked
 * `fetch` that returns whatever the test hands it; this service's tests validate its own schema
 * against bodies this file's authors wrote. Neither has ever seen the other. A field renamed here
 * and not there produces a 400 for a reviewer mid-decision — on a surface whose entire purpose is
 * that a human resolves a candidate in seconds — with both suites green.
 *
 * The precedent is `worker-app-action-contract.test.ts`, which reads Dart from this same
 * directory for exactly this reason: *"a mock that accepts whatever it is handed cannot fail this
 * way, so the assertion has to cross the boundary."* That one caught a spine sink that never once
 * wrote to the spine. This is the same seam with a shorter reach — TypeScript to TypeScript, no
 * language boundary, just a package one.
 *
 * ── WHAT THIS FILE IS AND IS NOT ────────────────────────────────────────────────────────
 * It READS `apps/admin-web` as data. It does not import it, modify it, or assert anything about
 * how the console renders — `apps/admin-web` is Frontend Platform's (CLAUDE.md §5/§6) and its
 * own `page.render.test.tsx` owns the rendering. What is asserted here is strictly the BACKEND's
 * contract: the vocabulary, the bounds, the request union's shape per branch, and the two literal
 * markers a client must not paraphrase.
 *
 * If this breaks because the console moved, do not delete it and do not "fix" the console from
 * here. The contract really did change, and the whole point is that somebody finds out at this
 * commit rather than from a 400 in a review session.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_SKILL_PROPOSED_DESCRIPTION_MAX,
  ADMIN_SKILL_PROPOSED_LABEL_MAX,
  ADMIN_SKILL_REVIEW_DECISIONS,
  ADMIN_SKILL_REVIEW_REASON_MAX,
  ADMIN_SKILL_REVIEW_REASON_MIN,
  ADMIN_SKILL_DECISION_CONFLICTS,
  AdminSkillDecisionSchema,
  SKILL_CANDIDATE_STATUSES,
  SKILL_DECISION_EFFECT_RECORDED_ONLY,
  SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN,
} from "./admin-skill-discovery.dto";

const CONSOLE_DIR = join(__dirname, "..", "..", "..", "admin-web", "src", "lib");
const VOCAB_PATH = join(CONSOLE_DIR, "skill-discovery-vocabulary.ts");
const TYPES_PATH = join(CONSOLE_DIR, "skill-discovery.ts");

/**
 * The console's files, or `null` when they are not present.
 *
 * NULLABLE ON PURPOSE. This service must build and test in a checkout that does not contain
 * `apps/admin-web` — a partial clone, a container that copies one workspace. A hard failure there
 * would make an unrelated environment problem look like a contract break, so the suite SKIPS
 * instead, and a guard test asserts that the files exist in a full checkout so the skip cannot
 * become the permanent state.
 */
function readConsole(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const VOCAB = readConsole(VOCAB_PATH);
const TYPES = readConsole(TYPES_PATH);
const present = VOCAB !== null && TYPES !== null;

/**
 * THE THREE PARSERS BELOW USE LITERAL REGEXES THAT CAPTURE THE NAME, then match the name in JS.
 *
 * The obvious shape is ``source.match(new RegExp(`export const ${name} = …`))``, and that is a
 * ReDoS shape `semgrep detect-non-literal-regexp` blocks. This repository has now hit that rule
 * FOUR times — `migration-adoption.ts`, `audit-undeclared-routines.ts`,
 * `lifecycle-writer-scan.ts`, and this file — and the last two were both in this change, the
 * second written immediately after the first was fixed and documented. Knowing the rule is
 * evidently not the same as remembering it at the moment of writing a three-line helper.
 *
 * The inversion is the same one `tablesWrittenIn` uses: one literal matches EVERY declaration of
 * the shape and captures its name, and the caller picks the one it wants by string equality.
 * Beyond satisfying the gate it is more honest — `${name}` interpolated into a pattern would also
 * match a DIFFERENT constant whose name merely contains it, and equality cannot.
 *
 * ⚠ All three carry `g` and therefore a `lastIndex`. `matchAll` resets it; `.exec()` in a loop
 * would not.
 */
const TUPLE_DECL = /export const ([A-Z_0-9]+) = \[([\s\S]*?)\] as const;/g;
const NUMBER_DECL = /export const ([A-Z_0-9]+) = (\d+);/g;
const REQUEST_BRANCH = /\{\s*decision: "([a-z]+)";([\s\S]*?)\}/g;

/** A `as const` string-array literal, parsed back into its members. */
function tupleMembers(source: string, name: string): string[] {
  for (const m of source.matchAll(TUPLE_DECL)) {
    if (m[1] !== name) continue;
    return [...(m[2] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1] as string);
  }
  return [];
}

/** An `export const NAME = <number>;` declaration. */
function numberConst(source: string, name: string): number | null {
  for (const m of source.matchAll(NUMBER_DECL)) {
    if (m[1] === name) return Number(m[2]);
  }
  return null;
}

/** The body of one branch of the console's `SkillDecisionRequest` union. */
function requestBranch(source: string, decision: string): string {
  for (const m of source.matchAll(REQUEST_BRANCH)) {
    if (m[1] === decision) return m[2] ?? "";
  }
  return "";
}

describe("the mirror exists (the skip cannot become the permanent state)", () => {
  it("finds both console files in a full checkout", () => {
    // Without this, deleting the console's mirror would make every assertion below vanish rather
    // than fail — a suite that silently stops checking is the failure this whole file is about.
    expect(present, `expected ${VOCAB_PATH} and ${TYPES_PATH}`).toBe(true);
  });
});

describe.skipIf(!present)("the vocabularies are the same vocabularies", () => {
  it("the seven statuses, in the same order", () => {
    // Order matters here and not merely for tidiness: both sides index labels off this tuple, so a
    // reordering would relabel every status on screen without changing a single string.
    expect(tupleMembers(VOCAB as string, "SKILL_CANDIDATE_STATUSES")).toEqual([
      ...SKILL_CANDIDATE_STATUSES,
    ]);
  });

  it("the five reviewer decisions, in the same order", () => {
    expect(tupleMembers(VOCAB as string, "ADMIN_SKILL_REVIEW_DECISIONS")).toEqual([
      ...ADMIN_SKILL_REVIEW_DECISIONS,
    ]);
  });

  it("the three conflict codes", () => {
    expect(tupleMembers(VOCAB as string, "ADMIN_SKILL_DECISION_CONFLICTS")).toEqual([
      ...ADMIN_SKILL_DECISION_CONFLICTS,
    ]);
  });

  it("the two requirement values", () => {
    // `preferred` is the conservative default on both sides. A console that offered only
    // `required` would make every discovered skill a hard hiring claim on no evidence.
    expect(tupleMembers(VOCAB as string, "ADMIN_SKILL_REQUIREMENTS")).toEqual([
      "required",
      "preferred",
    ]);
  });
});

describe.skipIf(!present)("the bounds are the same bounds", () => {
  it("the reason floor and ceiling", () => {
    // The floor is the one a reviewer meets constantly. A console that enforced 10 while the
    // server enforced 12 would produce a 400 on a form that had just told them it was fine.
    expect(numberConst(VOCAB as string, "ADMIN_SKILL_REVIEW_REASON_MIN")).toBe(
      ADMIN_SKILL_REVIEW_REASON_MIN,
    );
    expect(numberConst(VOCAB as string, "ADMIN_SKILL_REVIEW_REASON_MAX")).toBe(
      ADMIN_SKILL_REVIEW_REASON_MAX,
    );
  });

  it("the label and description ceilings", () => {
    expect(numberConst(VOCAB as string, "ADMIN_SKILL_PROPOSED_LABEL_MAX")).toBe(
      ADMIN_SKILL_PROPOSED_LABEL_MAX,
    );
    expect(numberConst(VOCAB as string, "ADMIN_SKILL_PROPOSED_DESCRIPTION_MAX")).toBe(
      ADMIN_SKILL_PROPOSED_DESCRIPTION_MAX,
    );
  });
});

describe.skipIf(!present)("the request union agrees, branch by branch", () => {
  // The sharp half. The server's union is `.strict()`, so a field on the wrong branch is a 400 —
  // and the console builds its form against its own union, which is the only thing stopping it
  // from composing one.

  it("`create` carries the label AND the trades, and NEVER a resulting skill", () => {
    const branch = requestBranch(VOCAB as string, "create");
    for (const field of [
      "proposed_skill_name",
      "approved_job_domain_ids",
      "approved_requirement",
      "expected_status",
      "review_reason",
    ]) {
      expect(branch, `create.${field}`).toContain(field);
    }
    // Invariant 6: the id stays NULL until the offline chain mints the skill and the backfill
    // runner stamps it. A request field for it would be the exact shortcut this surface refuses.
    expect(branch).not.toContain("resulting_skill_id");
    // And the server agrees, which is what makes the mirror's omission meaningful rather than
    // merely tidy.
    expect(
      AdminSkillDecisionSchema.safeParse({
        decision: "create",
        expected_status: "needs_review",
        review_reason: "names a concrete competency, not an occupation",
        proposed_skill_name: "Shuttering Erection",
        approved_job_domain_ids: ["jd_carpenter"],
        resulting_skill_id: "skill_arc_welding",
      }).success,
    ).toBe(false);
  });

  it("`alias` and `merge` carry a resulting skill and NEVER a label or trades", () => {
    for (const decision of ["alias", "merge"] as const) {
      const branch = requestBranch(VOCAB as string, decision);
      expect(branch, `${decision}.resulting_skill_id`).toContain("resulting_skill_id");
      expect(branch, decision).not.toContain("proposed_skill_name");
      expect(branch, decision).not.toContain("approved_job_domain_ids");
    }
  });

  it("`reject` and `hold` carry neither", () => {
    for (const decision of ["reject", "hold"] as const) {
      const branch = requestBranch(VOCAB as string, decision);
      expect(branch, decision).toContain("review_reason");
      expect(branch, decision).not.toContain("resulting_skill_id");
      expect(branch, decision).not.toContain("proposed_skill_name");
    }
  });

  it("every branch sends the concurrency token", () => {
    // Without `expected_status` the guarded UPDATE has nothing to match on, and the second of two
    // reviewers silently overwrites the first. It is required on every branch of the server union.
    for (const decision of ADMIN_SKILL_REVIEW_DECISIONS) {
      expect(requestBranch(VOCAB as string, decision), decision).toContain("expected_status");
    }
  });

  it("the console sends no reviewer and no timestamp on any branch", () => {
    // An actor a caller can type is not an actor. The server takes both from the session and
    // `.strict()` makes sending either a 400 — so a console that offered them would be building a
    // form whose submit can only fail.
    //
    // THE ONLY ALL-NEGATIVE ASSERTION IN THIS FILE, so it carries its own positive control: every
    // other block happens to check for a field it expects BEFORE checking for one it forbids, and
    // is therefore safe against `requestBranch` returning "" for a branch it could not parse.
    // This one is not, and a parser that quietly matched nothing would report five clean branches.
    for (const decision of ADMIN_SKILL_REVIEW_DECISIONS) {
      const branch = requestBranch(VOCAB as string, decision);
      expect(branch.length, `${decision} branch must actually parse`).toBeGreaterThan(0);
      expect(branch, `${decision} branch must be the real one`).toContain("review_reason");
      for (const forbidden of ["reviewer_admin_id", "reviewed_at", "candidate_id"]) {
        expect(branch, `${decision}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe.skipIf(!present)("the two literal markers are quoted, not paraphrased", () => {
  it("the console asserts the exact `corpus_effect` and `next_step` strings", () => {
    // These are LITERAL types on the wire precisely so a client cannot render an approval as
    // "skill created". The console asserts them with `z.literal`, which means a server that
    // changed either string would fail the console's own parse — but only if the strings match
    // today, which is what this checks.
    expect(VOCAB as string).toContain(`"${SKILL_DECISION_EFFECT_RECORDED_ONLY}"`);
    expect(VOCAB as string).toContain(`"${SKILL_DECISION_NEXT_STEP_OFFLINE_CORPUS_CHAIN}"`);
  });
});

describe.skipIf(!present)("no similarity score crosses the boundary", () => {
  it("the console's mirrored match type has no score, vector or model key", () => {
    // The wire type has no `score` key by construction and the mapper must project explicitly.
    // This is the other end of that promise: a console that added the key would be inventing a
    // number, and a reviewer who learns "0.9 is fine" has recreated an approval floor with no
    // owner ruling behind it.
    //
    // Comments are stripped first — both console files EXPLAIN at length that they carry no
    // score, naming the key, and counting prose would flag the files most careful to refuse it.
    const code = (TYPES as string)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const key of ["score:", "cosine", "embedding_model", "vector"]) {
      expect(code, key).not.toContain(key);
    }
  });
});

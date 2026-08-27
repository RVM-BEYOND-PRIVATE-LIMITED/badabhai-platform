/**
 * The programme graph, checked against itself and against the repository.
 *
 * `project-control.md` §H said *"No independently executable engineering task remains in this
 * programme"*. It was true when written, and nine engineering tasks have landed since. Prose
 * cannot be wrong out loud. These assertions can.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  blockersOf,
  executable,
  PROGRAMME,
  statusCounts,
  validateProgramme,
  type ProgrammeItem,
} from "./programme-graph";

const item = (o: Partial<ProgrammeItem> & { id: string; status: ProgrammeItem["status"] }): ProgrammeItem => ({
  title: "t",
  dependsOn: [],
  evidence: "e",
  unblocks: [],
  ...o,
});

describe("validateProgramme", () => {
  it("accepts a coherent graph", () => {
    expect(
      validateProgramme([
        item({ id: "A", status: "COMPLETE", unblocks: ["B"] }),
        item({ id: "B", status: "EXECUTABLE", dependsOn: ["A"] }),
      ]),
    ).toEqual([]);
  });

  it("refuses BLOCKED_ON_OWNER with no decision named", () => {
    // "Waiting on the owner" without saying what for is how an item waits forever.
    const p = validateProgramme([item({ id: "A", status: "BLOCKED_ON_OWNER" })]);
    expect(p[0]?.problem).toMatch(/without naming the decision/);
  });

  it("refuses BLOCKED_ON_AI_SPEND with no measured cost", () => {
    const p = validateProgramme([item({ id: "A", status: "BLOCKED_ON_AI_SPEND" })]);
    expect(p[0]?.problem).toMatch(/without a measured cost/);
  });

  it("refuses EXECUTABLE with an unfinished dependency — the rule that earns its keep", () => {
    // Otherwise a plan promises work that cannot start, which is the specific way a dependency
    // list becomes reassuring and wrong.
    const p = validateProgramme([
      item({ id: "A", status: "BLOCKED_ON_OWNER", decision: "d", unblocks: ["B"] }),
      item({ id: "B", status: "EXECUTABLE", dependsOn: ["A"] }),
    ]);
    expect(p.map((x) => x.problem).join(" ")).toMatch(/EXECUTABLE but depends on A/);
  });

  it("refuses a dangling dependency and a one-sided unblocks edge", () => {
    const p = validateProgramme([
      item({ id: "A", status: "COMPLETE", dependsOn: ["ghost"], unblocks: ["B"] }),
      item({ id: "B", status: "COMPLETE" }),
    ]);
    expect(p.map((x) => x.problem).join(" ")).toMatch(/unknown item ghost/);
    expect(p.map((x) => x.problem).join(" ")).toMatch(/does not depend on it/);
  });

  it("refuses an item with no evidence reference", () => {
    const p = validateProgramme([item({ id: "A", status: "COMPLETE", evidence: "  " })]);
    expect(p[0]?.problem).toMatch(/no evidence reference/);
  });
});

describe("blockersOf walks the whole tree, not one path", () => {
  const g = [
    item({ id: "leaf", status: "BLOCKED_ON_OWNER", decision: "d", dependsOn: ["a", "b"] }),
    item({ id: "a", status: "BLOCKED_ON_AI_SPEND", costInr: 1, dependsOn: ["c"], unblocks: ["leaf"] }),
    item({ id: "b", status: "COMPLETE", unblocks: ["leaf"] }),
    item({ id: "c", status: "BLOCKED_ON_INFRA", unblocks: ["a"] }),
  ];

  it("reports every unfinished ancestor and omits the finished ones", () => {
    expect(blockersOf(g, "leaf").map((i) => i.id)).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
describe("the real graph", () => {
  it("is internally coherent", () => {
    expect(validateProgramme(PROGRAMME)).toEqual([]);
  });

  it("every id is unique and every item names its evidence", () => {
    expect(new Set(PROGRAMME.map((i) => i.id)).size).toBe(PROGRAMME.length);
    for (const i of PROGRAMME) expect(i.evidence.length, i.id).toBeGreaterThan(20);
  });

  it("nothing is BLOCKED_ON_AI_SPEND without a rupee figure", () => {
    for (const i of PROGRAMME.filter((x) => x.status === "BLOCKED_ON_AI_SPEND")) {
      expect(typeof i.costInr, i.id).toBe("number");
    }
  });

  it("the total spend needed to clear every spend-blocked item is under one rupee", () => {
    // ₹0.028128 -> ₹0.0035 -> ₹0. Both halves are now bought: the evaluation cost nothing
    // (127/127 cached) and the sweep was run for ₹0.0035 on 2026-08-26. Nothing on the graph is
    // waiting for money any more, which is a different statement from "it was always cheap".
    const spendBlocked = PROGRAMME.filter((i) => i.status === "BLOCKED_ON_AI_SPEND");
    expect(spendBlocked).toEqual([]);
    const total = spendBlocked.reduce((n, i) => n + (i.costInr ?? 0), 0);
    expect(total).toBe(0);
    expect(total).toBeLessThan(1);
  });
});

describe("what the graph says about the programme", () => {
  const counts = statusCounts(PROGRAMME);

  it("nothing is executable today — and that is a measurement, not an assumption", () => {
    // project-control §H said "No independently executable engineering task remains in this
    // programme". It was WRONG while nine tasks were available and is TRUE again now they have
    // landed. The value of holding it as data is that it fails when it stops being true,
    // instead of being right by luck.
    //
    // This assertion is also a correction. A first pass claimed one executable item — six write
    // runners with no ops guard — from a grep for the literal `enforceOpsGuard`. All six reach
    // it through parseCommonCli. The item is retracted, not quietly deleted.
    expect(counts.EXECUTABLE).toBe(0);
    expect(executable(PROGRAMME)).toEqual([]);
  });

  it("the owner is the largest single blocker", () => {
    const others =
      counts.BLOCKED_ON_AI_SPEND +
      counts.BLOCKED_ON_DATA +
      counts.BLOCKED_ON_INFRA +
      counts.BLOCKED_ON_PRODUCTION_WRITE;
    expect(counts.BLOCKED_ON_OWNER).toBeGreaterThan(others / 2);
  });

  it("promotion has NO unfinished ancestors left, and canonicalization has exactly one", () => {
    // Q1 and EVAL_COVERED are direct dependencies and are COMPLETE, so they do not appear —
    // blockersOf reports what is still in the way, not the whole ancestry.
    //
    // UNCHANGED BY THE 2026-08-26 RULINGS, and that is the point worth pinning: the four
    // corpus decisions ruled that day (D-7A, D-7C-1a, D-7C-1b, 5a-2) all sat on the
    // CANONICALIZATION branch. None of them ever gated PROMOTION, so ruling them moved the
    // promotion leaf not at all.
    // Four -> one -> NONE, and the last step was a ruling rather than a build. PROMOTION-SCOPE
    // was ruled option B on 2026-08-27 and the promotion ran the same day: 62 promoted, 34 held.
    // Pinned as an empty list rather than deleted — a NEW blocker appearing on the promotion
    // leaf after it has already happened would mean the graph has lost track of what is done.
    expect(blockersOf(PROGRAMME, "PROMOTION").map((i) => i.id)).toEqual([]);
    expect(PROGRAMME.find((i) => i.id === "PROMOTION")!.status).toBe("COMPLETE");
    // And with PROMOTION done, the activation leaf is down to ONE blocker — not a decision and
    // not a build, but a FACT nobody in this repository can read: what the running container
    // actually has SKILL_CANONICALIZE_ENABLED set to. Everything the graph could answer, it has.
    const canon = blockersOf(PROGRAMME, "CANONICALIZATION").map((i) => i.id);
    expect(canon).toEqual(["CANONICALIZE-FLAG-VALUE"]);
    // …and the four ruled items are gone from it.
    for (const ruled of ["D-7A", "D-7C-1a", "D-7C-1b", "5a-2"]) {
      expect(canon, ruled).not.toContain(ruled);
    }
  });

  it("no path to CANONICALIZATION is engineering-only", () => {
    // PROMOTION has dropped out of this test because it HAPPENED, not because the rule was
    // relaxed: it reached zero blockers by way of an owner ruling and then ran. The invariant
    // itself is unchanged and still guards the one leaf that is left — nothing between here and
    // activation is something an engineer may simply do.
    const b = blockersOf(PROGRAMME, "CANONICALIZATION");
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((i) => i.status !== "EXECUTABLE")).toBe(true);
    // And the way PROMOTION cleared is recorded, so "it has no blockers" can never be read as
    // "it was never gated".
    const scope = PROGRAMME.find((i) => i.id === "PROMOTION-SCOPE")!;
    expect(scope.status).toBe("COMPLETE");
    expect(scope.decision).toMatch(/OWNER RULING 2026-08-27, OPTION B/);
    expect(scope.decision).toMatch(/No criterion was waived, the 0\.75 floor did not move/);
  });

  it("D-7C's seed was blocked by BOTH owner decisions, then by an authorization, and is now applied", () => {
    // It used to be blocked by BOTH owner decisions that reach it: D-7A held boring, D-7C-1a
    // was the orphan conflict, and either alone stopped the seed. Both were ruled 2026-08-26,
    // so the graph now has nothing in the way — which is NOT the same as the seed being
    // allowed to run. Its own status is what still stops it, and that is a human signal, not
    // a dependency.
    expect(blockersOf(PROGRAMME, "D-7C-SEED").map((i) => i.id)).toEqual([]);
    // …and it has since been APPLIED, under both ops-guard signals, 3 rows.
    expect(PROGRAMME.find((i) => i.id === "D-7C-SEED")!.status).toBe("COMPLETE");
  });
});

describe("the graph agrees with the repository", () => {
  const root = join(__dirname, "..", "..", "..");

  it("every artifact an item cites as evidence exists", () => {
    // Three roots, because evidence lives in three places by design: the decision register,
    // the architecture docs, and machine-read inputs beside the code that reads them. A
    // citation resolving in none is a dead reference, and a graph full of those is a graph
    // nobody can check.
    const roots = [
      join(root, "docs", "registers", "taxonomy-decisions"),
      join(root, "docs", "architecture"),
      join(root, "packages", "db", "data", "taxonomy"),
    ];
    const cited = new Set<string>();
    for (const i of PROGRAMME) {
      for (const m of i.evidence.matchAll(/([a-z0-9][a-z0-9._-]*\.(?:md|json))/g)) cited.add(m[1]!);
    }
    expect(cited.size).toBeGreaterThan(8);
    for (const f of cited) {
      const found = roots
        .map((r) => {
          try {
            return readFileSync(join(r, f), "utf8");
          } catch {
            return null;
          }
        })
        .find((x) => x !== null);
      expect(found, `${f} is cited by the graph and exists in neither root`).toBeTruthy();
    }
  });

  it("the six runners once reported as unguarded all reach the guard via parseCommonCli", () => {
    // The measurement that was wrong, redone by the method that can see indirection. If someone
    // detaches one of these from parseCommonCli without adding enforceOpsGuard directly, an
    // --apply against production stops needing two signals and this fails.
    const src = join(root, "packages", "db", "src");
    const runners = [
      "materialize-job-reach",
      "normalize-skill-aliases",
      "seed-domain-skills",
      "normalize-job-domain-aliases",
      "backfill-worker-skills",
      "grant-free-tier",
    ];
    const helper = readFileSync(join(src, "match-v1-cli.ts"), "utf8");
    expect(helper).toContain("enforceOpsGuard({");
    expect(helper).toContain("mutating: apply");
    for (const r of runners) {
      const code = readFileSync(join(src, `${r}.ts`), "utf8");
      const guarded = code.includes("enforceOpsGuard") || code.includes("parseCommonCli");
      expect(guarded, `${r} reaches no ops guard by either route`).toBe(true);
    }
  });

  it("and the retraction stays visible in the item itself", () => {
    const item = PROGRAMME.find((i) => i.id === "OPS-GUARD-COVERAGE")!;
    expect(item.status).toBe("COMPLETE");
    expect(item.evidence).toMatch(/RETRACTED AND RE-MEASURED/);
    expect(item.evidence).toMatch(/cannot see indirection/);
  });
});

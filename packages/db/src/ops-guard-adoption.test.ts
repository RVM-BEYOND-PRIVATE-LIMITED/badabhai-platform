/**
 * WHICH RUNNERS STILL DECIDE WITH `NODE_ENV`, AND WHY EACH ONE IS STILL ALLOWED TO.
 *
 * Four runners moved onto `opsGuard` because they are the D2 path — the seed, the embed, the
 * promote, and the shared `match-v1-cli` harness that thirteen scripts route through. That fixes
 * the runs that were about to happen. It does NOT fix the ones that were not, and the gap
 * between "we fixed some" and "we fixed them" is exactly the kind of thing that is true on the
 * day it is written and quietly false a month later.
 *
 * So the remainder is an ALLOW-LIST rather than a memory, and this test drives it in BOTH
 * directions:
 *
 *   • every file that still contains `NODE_ENV === "production"` must be on the list, so a NEW
 *     runner cannot ship with the old guard;
 *   • every file ON the list must still contain it, so an entry cannot outlive its reason and
 *     rot into a lie.
 *
 * The list is the honest statement of what is left. Deleting an entry is how a fix is recorded.
 *
 * ===========================================================================
 * WHY THE OLD GUARD IS NOT MERELY WEAKER — IT IS BACKWARDS
 * ===========================================================================
 * `NODE_ENV` labels the PROCESS. The blast radius is decided by `DATABASE_URL`, which labels the
 * TARGET. They are set independently, so the same line produces two failures at once.
 *
 * On THIS repository, measured 2026-08-20: `NODE_ENV` is unset in the shell and set to
 * `production` by the repo `.env`, which every one of these runners loads through dotenv before
 * its guard. So the old line does fire — and what it produces here is the FALSE REFUSAL, on
 * every run including read-only ones. The write protection is real and it lives in one line of
 * a GITIGNORED file: a fresh clone, CI, or a teammate whose `.env` omits it reaches the same
 * production database with nothing in the way. The obvious cure for the over-refusal — delete
 * that line — removes the write protection in the same gesture.
 *
 * ⚠ THE THREE FIXTURE SEEDS ARE THE SHARPEST CASE, and they are not on the D2 path, which is
 * why they are still here. `seed.ts`, `seed-demand.ts` and `seed-reach-pool.ts` write SYNTHETIC
 * data. Their guard reads as "never in production" — and against an unset NODE_ENV it permits
 * exactly that. Nothing on this list is more worth fixing next.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = __dirname;

/** The literal that used to be the whole guard. */
const OLD_GUARD = 'NODE_ENV === "production"';

interface Remaining {
  readonly file: string;
  /** What the runner does, and why it has not been converted yet. */
  readonly reason: string;
  /** Would an unguarded run against production write? */
  readonly writesOnProduction: boolean;
}

/**
 * Every runner still keyed on `NODE_ENV` alone, as of 2026-08-20.
 *
 * Ordered by how much a false permit would cost, worst first.
 */
export const STILL_ON_THE_OLD_GUARD: readonly Remaining[] = [
  {
    file: "seed.ts",
    reason:
      "Base fixture seed — writes SYNTHETIC rows. Its guard says 'never in production' and, " +
      "with NODE_ENV unset, permits exactly that. Not on the D2 path, so out of this change's " +
      "scope; first in line for the next one.",
    writesOnProduction: true,
  },
  {
    file: "seed-demand.ts",
    reason: "Fixture seed for demand. Same shape and same hazard as seed.ts.",
    writesOnProduction: true,
  },
  {
    file: "seed-reach-pool.ts",
    reason:
      "Fixture seed for the reach pool, and the largest of the three by row count. Same hazard.",
    writesOnProduction: true,
  },
  {
    file: "reencrypt-pii-backfill.ts",
    reason:
      "PII key-rotation backfill. A REAL ops action with a legitimate production path, so it " +
      "needs the two-signal model rather than a refusal — the same treatment retag-skills.ts got.",
    writesOnProduction: true,
  },
  {
    file: "embed-job-domain-aliases.ts",
    reason:
      "The domain-alias twin of embed-skill-aliases.ts, which this change did convert. Left " +
      "only because the D2 runbook does not call it; converting it is a near-copy of that diff.",
    writesOnProduction: true,
  },
  {
    file: "growth-cluster.ts",
    reason: "Phase-3 growth clustering. Ops action, legitimate production path.",
    writesOnProduction: true,
  },
  {
    file: "growth-occupation.ts",
    reason: "Phase-3 growth occupation pass. Ops action, legitimate production path.",
    writesOnProduction: true,
  },
];

/** Source files (not tests, not the guard itself) that still contain the old literal. */
function filesStillUsingTheOldGuard(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "ops-guard.ts")
    .filter((f) => {
      // Strip line comments before matching: several converted runners still DISCUSS the old
      // guard in prose explaining why it was wrong, and a prose mention is not a guard.
      const body = readFileSync(join(SRC, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join("\n");
      return body.includes(OLD_GUARD);
    })
    .sort();
}

describe("ops-guard adoption — the list of what is left is checked, not remembered", () => {
  it("every runner still on the old guard is on the allow-list", () => {
    // FAILS FOR A NEW RUNNER. Copying `if (process.env.NODE_ENV === "production") throw` into a
    // new script is the single most likely way this regresses, and it is now a red test rather
    // than a thing somebody might notice in review.
    const actual = filesStillUsingTheOldGuard();
    const allowed = STILL_ON_THE_OLD_GUARD.map((r) => r.file).sort();
    expect(actual).toEqual(allowed);
  });

  it("every allow-list entry still has the guard it describes — no entry outlives its reason", () => {
    // THE OTHER DIRECTION, and the one that rots silently. An entry left behind after its file
    // was fixed makes this list overstate the debt, and a list that is wrong in the safe
    // direction is still a list nobody trusts.
    const actual = new Set(filesStillUsingTheOldGuard());
    for (const r of STILL_ON_THE_OLD_GUARD) {
      expect(actual.has(r.file), `${r.file} no longer uses the old guard — delete its entry`).toBe(
        true,
      );
    }
  });

  it("every entry states a reason and its production write risk", () => {
    for (const r of STILL_ON_THE_OLD_GUARD) {
      expect(r.reason.length, `${r.file} needs a real reason`).toBeGreaterThan(40);
      expect(typeof r.writesOnProduction).toBe("boolean");
    }
  });

  it("the four D2-path runners are NOT on the list — they were converted", () => {
    // Named explicitly rather than inferred from the absence of a string: the point of the
    // change was these four, and an assertion that only counted files would pass if one of
    // them had been converted halfway and lost its guard entirely.
    const converted = [
      "seed-skills.ts",
      "embed-skill-aliases.ts",
      "promote-skills.ts",
      "match-v1-cli.ts",
    ];
    const still = new Set(filesStillUsingTheOldGuard());
    for (const f of converted) expect(still.has(f)).toBe(false);
    for (const f of converted) {
      expect(readFileSync(join(SRC, f), "utf8")).toContain("enforceOpsGuard(");
    }
  });

  it("the converted runners each name themselves for OPS_ALLOW_PRODUCTION", () => {
    // A runner that passed a shared or empty `script` would let one authorisation unlock
    // several, which is the whole reason the env var names the runner rather than being a
    // bare boolean. Asserted as the literal each file must contain, and — for the two that
    // route through a constant — the value of that constant too, so renaming one without the
    // other cannot pass.
    const nameArg: Record<string, string> = {
      "seed-skills.ts": "script: SCRIPT,",
      "embed-skill-aliases.ts": "script: SCRIPT,",
      "promote-skills.ts": "script: SCRIPT,",
      "match-v1-cli.ts": "script: scriptName,",
    };
    for (const [file, token] of Object.entries(nameArg)) {
      expect(readFileSync(join(SRC, file), "utf8"), `${file} must pass a script name`).toContain(
        token,
      );
    }
    expect(readFileSync(join(SRC, "seed-skills.ts"), "utf8")).toContain(
      'const SCRIPT = "seed:skills"',
    );
    expect(readFileSync(join(SRC, "embed-skill-aliases.ts"), "utf8")).toContain(
      'const SCRIPT = "embed:skills"',
    );
  });
});

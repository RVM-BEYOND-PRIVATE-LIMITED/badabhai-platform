import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHICH TEMPLATE DOES PRODUCTION ACTUALLY ASK FOR? (R16 §1.)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * R16 §1 wired the Verdict Line's fourth segment and asked for it to be asserted END TO END. It
 * is — the mapper composes it on both branches and `bb_trade.v1.html` renders it. But "end to
 * end" has an end, and checking it turned up something larger than the segment:
 *
 *     `resume.service.ts` names `templateId: "classic"` for every production render, and
 *     `{{headline_line}}` exists in EXACTLY ONE template — `bb_trade.v1.html` — which nothing
 *     in non-test source selects.
 *
 * So no part of the Verdict Line has ever reached a worker's PDF. Not the axis segment, not the
 * tools, not the salary R12 §1.4 fixed, not the years R13 §2 fixed. Four packets have been
 * correcting the composition of a line the product does not currently print.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. It is the same shape as the allowlist row that read "no pack
 * asks for axes yet": a true statement about today that nobody re-checks. Written as an
 * assertion, the day someone points `resume.service.ts` at `bb_trade` this file goes red and
 * says so, and the change is a deliberate edit here rather than a silent one there.
 *
 * NOT FIXED HERE, DELIBERATELY. Which template ships is an output ruling — the skin system is
 * explicitly out of scope (R16 §7) and `bb_trade.v1` is the sheet the whole Resume Engine
 * guideline describes. Wiring it is one line and an owner's decision, not a mapper fix.
 */

const SRC = join(__dirname);

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("R16 §1 — the Verdict Line's reachability, measured rather than assumed", () => {
  it("exactly one template renders the verdict line", () => {
    const templates = ["bb_trade.v1", "classic.v1", "classic.v2", "classic.v3"];
    const carrying = templates.filter((t) =>
      read(`templates/${t}.html`).includes("{{headline_line}}"),
    );
    expect(carrying).toEqual(["bb_trade.v1"]);
  });

  it("`classic.v3` renders `{{headline}}`, which is a DIFFERENT slot", () => {
    // Worth stating because the two names are one character apart and the confusion is the
    // reason this went unnoticed: `{{headline}}` is `canonicalRole`, a job title, not the
    // composed verdict line.
    const classic = read("templates/classic.v3.html");
    expect(classic).toContain("{{headline}}");
    expect(classic).not.toContain("{{headline_line}}");
  });

  it("production still asks for `classic`, so the whole verdict line is INERT", () => {
    // THE FINDING. When this goes red, somebody pointed the product at the trade sheet — delete
    // this test and move the scorecard line from "absent" to "met".
    const service = read("resume.service.ts");
    const named = [...service.matchAll(/templateId:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(named.length, "no templateId literal found — the reader is broken").toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set(["classic"]));
  });
});

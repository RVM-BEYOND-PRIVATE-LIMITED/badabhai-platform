import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { templateIdForPack } from "./resume-document";

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
 * FIXED. The owner asked for the CNC turner sheet end to end, which is that decision made:
 * `resume.service.ts` now resolves the template from the worker's role pack, GATED on the pack
 * having a resume map so a trade with none still renders `classic` byte-identically. The
 * assertions below are inverted rather than deleted — see the first of them.
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

  it("production selects the trade sheet for a pack that has a resume map", () => {
    // THE FINDING, CLOSED. This test used to assert the opposite — that `resume.service.ts`
    // hardcoded `classic` on both branches, so no part of the Verdict Line had ever reached a
    // worker's PDF and four packets had been correcting the composition of a line the product
    // did not print. Its own instruction was: when this goes red, somebody pointed the product
    // at the trade sheet — delete it and move the scorecard line from absent to met.
    //
    // INVERTED RATHER THAN DELETED, for the same reason the profiling module's
    // `controllers === []` assertion was inverted rather than dropped: losing the negative
    // without gaining the positive is how a thing comes to be built dark a second time.
    const service = read("resume.service.ts");
    // No literal survives — the id is resolved from the worker's pack.
    const named = [...service.matchAll(/templateId:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(named).toEqual([]);
    expect(service).toContain("templateIdForPack");
  });

  it("the gate is the pack having a resume map, and nothing looser", () => {
    // A looser gate silently re-lays-out every worker in the country. This is the assertion
    // that keeps the flip incremental: a trade with no authored map still renders `classic`.
    expect(templateIdForPack("qp_cnc_turning")).toBe("bb_trade");
    expect(templateIdForPack("qp_universal")).toBe("classic");
    expect(templateIdForPack(null)).toBe("classic");
  });
});

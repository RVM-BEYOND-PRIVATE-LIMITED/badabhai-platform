import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_ASKS_PER_QUESTION, MAX_ENGINE_ASKS } from "./next-question";

/**
 * THE AUTHORING-TIME BUDGET GUARD (R6 §5).
 *
 * WHAT WAS MISSING. `MAX_ENGINE_ASKS` is enforced at RUNTIME — the engine closes the interview
 * with `completionReason: "ask_budget"` the moment a worker hits it. Nothing checked it at
 * authoring time, and the strongest assertion that existed (`asked.length <= MAX_ENGINE_ASKS`)
 * is vacuous, because the engine enforces that bound by construction: it can never fail.
 *
 * So a pack author who adds a sixteenth turning question gets NO signal. The first symptom is a
 * senior worker's interview closing early in production, and what it silently deletes is the
 * TAIL — the occupation pack drains before the universal one, so the question actually lost is
 * `shift_preference`, not the question that was added.
 *
 * WHAT IT ASSERTS. That the budget can serve every question a single worker can be routed to,
 * plus one retry for each mandatory question. Those are the two ways the count grows, and the
 * second is the one the R5 audit found had already eaten the margin: a senior turner needing one
 * re-ask on a mandatory answer hit 24 exactly.
 *
 * THE BOUND IS AN UPPER BOUND, and deliberately so. It counts every item in a pack as reachable
 * by one worker, which is exact for the shipped corpus (the turner's gates are monotone
 * thresholds on one field, so the top tier satisfies all of them) and pessimistic for a future
 * pack with mutually exclusive branches. Pessimistic in this direction means an author gets a red
 * test and has to think — which is the whole point — rather than a green one and a production
 * surprise.
 */

const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

interface PackItem {
  question_key: string;
  is_mandatory?: boolean;
  max_asks?: number;
}
interface Pack {
  pack_id: string;
  version: number;
  items: PackItem[];
}

function loadPacks(): Pack[] {
  return readdirSync(PACK_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(PACK_DIR, f), "utf8")) as Pack);
}

/** The universal tail every interview appends, at its highest published version. */
function universal(packs: Pack[]): Pack {
  const versions = packs.filter((p) => p.pack_id === "qp_universal");
  return versions.reduce((a, b) => (b.version > a.version ? b : a));
}

/**
 * The asks one worker can be served: every question once, plus one retry per mandatory question.
 *
 * ONLY MANDATORY QUESTIONS COUNT TOWARDS THE RETRY TERM. `max_asks` permits a re-serve for any
 * item, but the engine only re-serves when an answer did not settle, and the interview moves on
 * from an optional question rather than pressing. Charging every item its full `max_asks` would
 * budget for 46 asks on a turner and make the guard meaningless.
 */
function worstCaseAsks(occupation: Pack, tail: Pack): number {
  const items = [...occupation.items, ...tail.items];
  const retries = items
    .filter((i) => i.is_mandatory === true)
    .reduce(
      (n, i) => n + Math.min(i.max_asks ?? MAX_ASKS_PER_QUESTION, MAX_ASKS_PER_QUESTION) - 1,
      0,
    );
  return items.length + retries;
}

describe("the ask budget, checked where a pack is authored rather than where it is served", () => {
  const packs = loadPacks();
  const tail = universal(packs);
  const occupations = packs.filter((p) => p.pack_id !== "qp_universal");

  it("reads a corpus at all (guards the loader, not the rule)", () => {
    // Without this, a moved directory would make every assertion below iterate an empty list and
    // report green while asserting nothing.
    expect(occupations.length).toBeGreaterThan(100);
    expect(tail.items.length).toBeGreaterThan(0);
  });

  it("can serve every question of the LARGEST pack, retries included", () => {
    const worst = occupations
      .map((p) => ({ pack: p.pack_id, asks: worstCaseAsks(p, tail) }))
      .sort((a, b) => b.asks - a.asks)[0]!;
    // The failure this prevents is silent and it deletes the wrong question. If this goes red,
    // either the pack sheds an ask or `MAX_ENGINE_ASKS` rises — and the second is a product
    // decision about ABANDONMENT, not about tokens (R6 §5), so it wants the drop-off curve
    // `chat.session_abandoned.engine_asks` now records.
    expect(
      MAX_ENGINE_ASKS,
      `${worst.pack} needs ${worst.asks} asks and the budget is ${MAX_ENGINE_ASKS}`,
    ).toBeGreaterThanOrEqual(worst.asks);
  });

  it("pins the worst case, so a pack that grows shows up in a diff", () => {
    // DELIBERATELY EXACT. The assertion above is the floor and stays green while headroom lasts;
    // this one turns red the moment any pack adds or removes a question, which is the authoring
    // signal that did not exist. Update it in the same commit as the pack, on purpose.
    //
    // 26 = qp_cnc_turning's 15 + qp_universal@2's 8 + one retry each for the three mandatory
    // questions (turning_experience, primary_trade, current_city).
    const worst = Math.max(...occupations.map((p) => worstCaseAsks(p, tail)));
    expect(worst).toBe(26);
  });

  it("keeps the headroom small enough to be a decision rather than a default", () => {
    // An inflated cap is not free: every ask it permits is a drop-off opportunity for a man
    // answering in Hinglish on a mid-range Android between shifts. The cap should sit just above
    // what the corpus needs, with room for the specific asks that are actually proposed — today
    // that is the two Zone 5 credential questions in docs/profiling/sample-parity-gap.md.
    const worst = Math.max(...occupations.map((p) => worstCaseAsks(p, tail)));
    expect(MAX_ENGINE_ASKS - worst).toBeLessThanOrEqual(2);
  });

  it("every pack fits the budget, not merely the largest one", () => {
    const overBudget = occupations
      .map((p) => ({ pack: p.pack_id, asks: worstCaseAsks(p, tail) }))
      .filter((p) => p.asks > MAX_ENGINE_ASKS);
    expect(overBudget).toEqual([]);
  });
});

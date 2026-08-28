import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_ASKS_PER_QUESTION, MAX_ENGINE_ASKS } from "./next-question";
import { evaluatePredicate } from "./predicate";

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
  /** The tier gate, when the item has one. Shape validated by the corpus validator. */
  ask_if?: unknown;
  target_field?: string;
  options?: { value_number?: number }[];
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
/**
 * Every `field` operand named anywhere inside a predicate.
 *
 * A LOCAL WALKER rather than `@badabhai/db`'s `predicateFields`, which is not on that package's
 * export map — widening a package barrel for one test would be a larger change than the six lines
 * it saves, and the predicate shape here is fixed by the contract.
 */
function fieldsOf(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  if (typeof n.field === "string") out.add(n.field);
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) value.forEach((v) => fieldsOf(v, out));
    else if (value && typeof value === "object") fieldsOf(value, out);
  }
  return out;
}

function asksFor(items: readonly PackItem[]): number {
  const retries = items
    .filter((i) => i.is_mandatory === true)
    .reduce(
      (n, i) => n + Math.min(i.max_asks ?? MAX_ASKS_PER_QUESTION, MAX_ASKS_PER_QUESTION) - 1,
      0,
    );
  return items.length + retries;
}

/**
 * Every value the pack's TIER GATE can take, read off the item that owns it.
 *
 * A pack whose questions are gated on `experience` has MUTUALLY EXCLUSIVE branches, and summing
 * them budgets for a worker who cannot exist. `qp_cnc_turning` is the case: tiers 1 and 2 are
 * `gte 2` and `gte 5`, R10 §2.6's fresher items are `lte 0`, and `turning_experience` is a
 * single_select — so no worker is both under one year and over five. Returns an empty list for a
 * pack with no gate, which then falls back to the plain sum.
 */
function tierValues(occupation: Pack): number[] {
  const gated = occupation.items.filter((i) => i.ask_if);
  const fields = new Set(
    gated.flatMap((i) => [...fieldsOf(i.ask_if)]).filter(Boolean),
  );
  if (fields.size !== 1) return [];
  const gate = occupation.items.find((i) => i.target_field === [...fields][0]);
  const values = (gate?.options ?? [])
    .map((o) => o.value_number)
    .filter((v): v is number => typeof v === "number");
  return [...new Set(values)];
}

/**
 * The asks one worker can be served: every question once, plus one retry per mandatory question.
 *
 * ONLY MANDATORY QUESTIONS COUNT TOWARDS THE RETRY TERM. `max_asks` permits a re-serve for any
 * item, but the engine only re-serves when an answer did not settle, and the interview moves on
 * from an optional question rather than pressing. Charging every item its full `max_asks` would
 * budget for 46 asks on a turner and make the guard meaningless.
 *
 * MUTUALLY EXCLUSIVE TIERS ARE MAXED, NOT SUMMED (R10 §2.6). The first version of this function
 * summed every item in the pack, which was right while every gate pointed the same way — tiers 1
 * and 2 are `gte 2` and `gte 5`, and a senior sees both. It stopped being right the moment a
 * FRESHER branch appeared: `lte 0` is disjoint from `gte 2`, so the sum modelled a worker who is
 * simultaneously under one year and over five, and reported 29 asks for a pack no worker can
 * spend more than 26 on.
 *
 * THIS IS NOT THE GUARD BEING WEAKENED TO FIT A CHANGE, and the distinction matters because that
 * is exactly what it would look like. The budget is unchanged at 28 and the retry rule is
 * unchanged; what changed is that the worst case is now computed over workers who can exist. The
 * assertion below still pins the real worst case EXACTLY, so a pack that genuinely needs 29 asks
 * still fails.
 */
function worstCaseAsks(occupation: Pack, tail: Pack): number {
  const tiers = tierValues(occupation);
  if (tiers.length === 0) return asksFor([...occupation.items, ...tail.items]);
  return Math.max(
    ...tiers.map((value) => {
      // A PLAIN OBJECT, NOT A MAP. `resolveOperand` reads `ctx.answers[field]?.value_normalized`,
      // so a Map silently resolves every gate to `undefined` and every gated item to false — the
      // first version of this did exactly that and reported 19 asks for a pack that needs 26,
      // i.e. it under-reported, which is the direction a budget guard must never fail in.
      const ctx = {
        answers: {
          [gateFieldOf(occupation)]: { value_normalized: value, value_raw: String(value) },
        },
        occupation: null,
        phase: "occupation_specific" as const,
        turn: 1,
      } as never;
      const served = occupation.items.filter(
        (i) => !i.ask_if || evaluatePredicate(i.ask_if as never, ctx),
      );
      return asksFor([...served, ...tail.items]);
    }),
  );
}

/** The single field every gate in this pack reads. */
function gateFieldOf(occupation: Pack): string {
  const gated = occupation.items.filter((i) => i.ask_if);
  const fields = new Set(
    gated.flatMap((i) => [...fieldsOf(i.ask_if)]).filter(Boolean),
  );
  return [...fields][0] ?? "";
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

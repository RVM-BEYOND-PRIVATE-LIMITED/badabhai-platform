import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEVEL_FIT_ORDER,
  LEVEL_SORT_LADDERS,
  LEVEL_SORT_TRADE_KINDS,
  isLevelSortTradeKind,
  levelFitFor,
  levelNeededSpec,
  type LevelNeededSpec,
} from "./level-needed";
import { POSTING_TRADES, POSTING_TRADE_KINDS } from "./posting-trades";
import { TRADE_LEVEL_LABELS, TRADE_LEVEL_PACKS, normalizeTradeLevelKey } from "./trade-levels";

/** Every key a ladder places (its rungs and its aliases). */
function placed(kind: (typeof LEVEL_SORT_TRADE_KINDS)[number]): Set<string> {
  const ladder = LEVEL_SORT_LADDERS[kind];
  return new Set<string>([...ladder.rungs, ...Object.keys(ladder.aliases)]);
}

describe("level-needed — the trades it is on for (30 Oct ruling Q4 step 1)", () => {
  it("is on for exactly the 4 CNC trades", () => {
    expect([...LEVEL_SORT_TRADE_KINDS]).toEqual([
      "cnc_turner",
      "vmc_milling",
      "cnc_grinding",
      "cam_programmer",
    ]);
  });

  it("every level-sort trade is a postable trade with its own sort ladder", () => {
    for (const kind of LEVEL_SORT_TRADE_KINDS) {
      expect(POSTING_TRADE_KINDS).toContain(kind);
      expect(LEVEL_SORT_LADDERS[kind].rungs.length).toBeGreaterThan(0);
    }
  });

  it("isLevelSortTradeKind accepts the 4 and refuses everything else", () => {
    expect(isLevelSortTradeKind("cnc_turner")).toBe(true);
    expect(isLevelSortTradeKind("welder")).toBe(false);
    expect(isLevelSortTradeKind(null)).toBe(false);
    expect(isLevelSortTradeKind(42)).toBe(false);
  });

  it("every ladder key is a known TradeLevel, and an alias always lands on a rung", () => {
    for (const kind of LEVEL_SORT_TRADE_KINDS) {
      const ladder = LEVEL_SORT_LADDERS[kind];
      for (const key of placed(kind)) expect(Object.keys(TRADE_LEVEL_LABELS)).toContain(key);
      for (const target of Object.values(ladder.aliases)) expect(ladder.rungs).toContain(target);
    }
  });
});

describe("level-needed — exhaustiveness: no stored key falls through by accident", () => {
  it("every rung the posting form offers for the trade has a sort position", () => {
    // The employer picks from POSTING_TRADES' ladder. A rung missing here would make
    // levelNeededSpec return null — the post silently sorts as "Any level".
    for (const kind of LEVEL_SORT_TRADE_KINDS) {
      const trade = POSTING_TRADES.find((t) => t.roleKind === kind)!;
      for (const { rung } of trade.ladder) {
        expect(placed(kind), `${kind}: posting rung ${rung}`).toContain(rung);
        expect(levelNeededSpec(kind, rung), `${kind}: ${rung}`).not.toBeNull();
      }
    }
  });

  it("every level answer any version of the trade's pack can store has a sort position", () => {
    // A worker's frozen rung is a key one of these packs stored. A key missing here would sort
    // him as "not confirmed" when he did state a rung.
    const packsDir = join(__dirname, "..", "..", "db", "data", "question-packs", "packs");
    const files = readdirSync(packsDir);
    for (const kind of LEVEL_SORT_TRADE_KINDS) {
      const packId = POSTING_TRADES.find((t) => t.roleKind === kind)!.packId;
      const levelKey = TRADE_LEVEL_PACKS[packId]!.levelKey;
      const versions = files.filter((f) => f.startsWith(`${packId}@`) && f.endsWith(".json"));
      expect(versions.length, `${packId} has pack files`).toBeGreaterThan(0);
      for (const file of versions) {
        const pack = JSON.parse(readFileSync(join(packsDir, file), "utf8")) as {
          items?: {
            target_field?: string;
            options?: { value_text?: string; option_key?: string }[];
          }[];
        };
        const item = (pack.items ?? []).find((i) => i.target_field === levelKey);
        for (const option of item?.options ?? []) {
          const stored = normalizeTradeLevelKey(option.value_text ?? option.option_key);
          expect(stored, `${file}: ${String(option.value_text)}`).not.toBeNull();
          expect(placed(kind), `${file}: ${String(stored)}`).toContain(stored);
        }
      }
    }
  });
});

describe("levelNeededSpec", () => {
  it("is null for 'Any level' — no rung on the posting", () => {
    expect(levelNeededSpec("cnc_turner", null)).toBeNull();
    expect(levelNeededSpec("cnc_turner", undefined)).toBeNull();
  });

  it("is null for a trade the sort is not on for, even with a rung", () => {
    expect(levelNeededSpec("welder", "skilled")).toBeNull();
    expect(levelNeededSpec(null, "setter")).toBeNull();
  });

  it("is null for a rung the trade's ladder does not know — never a guessed position", () => {
    expect(levelNeededSpec("cnc_turner", "senior")).toBeNull();
    expect(levelNeededSpec("cnc_grinding", "programmer")).toBeNull();
  });

  it("'Setter needed' on a turner post: Setter AND ABOVE, upper rungs need the confirm", () => {
    expect(levelNeededSpec("cnc_turner", "setter")).toEqual({
      needed: "setter",
      below: ["trainee", "operator", "helper"],
      meets: [],
      meetsIfConfirmed: ["setter", "setter_programmer", "programmer", "supervisor"],
    });
  });

  it("'Operator needed': a stated operator meets without any separating question", () => {
    const spec = levelNeededSpec("vmc_milling", "operator")!;
    expect(spec.below).toEqual(["trainee", "helper"]);
    expect(spec.meets).toEqual(["operator"]);
    expect(spec.meetsIfConfirmed).toContain("setter");
  });

  it("resolves the posting's legacy CAM rungs onto sheet 3", () => {
    expect(levelNeededSpec("cam_programmer", "senior_programmer")!.needed).toBe("senior");
    expect(levelNeededSpec("cam_programmer", "junior_programmer")!.needed).toBe("trainee");
    expect(levelNeededSpec("cam_programmer", "senior_programmer")!.below).toEqual([
      "trainee",
      "programmer",
      "junior_programmer",
    ]);
  });

  it("the lowest rung puts nobody below", () => {
    expect(levelNeededSpec("cnc_turner", "helper")!.below).toEqual([]);
    expect(levelNeededSpec("cnc_turner", "trainee")!.below).toEqual([]);
  });
});

describe("levelFitFor — the three groups", () => {
  const setter: LevelNeededSpec = levelNeededSpec("cnc_turner", "setter")!;

  it("meets: Setter and above, confirmed", () => {
    expect(levelFitFor(setter, "setter", true)).toBe("meets");
    expect(levelFitFor(setter, "programmer", true)).toBe("meets");
    expect(levelFitFor(setter, "supervisor", true)).toBe("meets");
  });

  it("not confirmed: no rung stated (never answered)", () => {
    expect(levelFitFor(setter, null, null)).toBe("not_confirmed");
  });

  it("not confirmed: an upper rung whose separating question was answered 'koi aur'", () => {
    expect(levelFitFor(setter, "setter", false)).toBe("not_confirmed");
    expect(levelFitFor(setter, "programmer", null)).toBe("not_confirmed");
  });

  it("not confirmed: a rung this ladder does not know", () => {
    expect(levelFitFor(setter, "senior", true)).toBe("not_confirmed");
    expect(levelFitFor(setter, "made_up", true)).toBe("not_confirmed");
  });

  it("below: under the needed rung, whatever the confirm bit says", () => {
    expect(levelFitFor(setter, "operator", false)).toBe("below");
    expect(levelFitFor(setter, "trainee", null)).toBe("below");
    expect(levelFitFor(setter, "helper", true)).toBe("below");
  });

  it("a disconfirmed setter on a Programmer post is below, not middle — his claim is lower", () => {
    const programmer = levelNeededSpec("cnc_turner", "programmer")!;
    expect(levelFitFor(programmer, "setter", false)).toBe("below");
  });

  it("an old-pack helper meets a Trainee post (Launch Pack §2: helper → trainee)", () => {
    expect(levelFitFor(levelNeededSpec("cnc_turner", "trainee")!, "helper", false)).toBe("meets");
  });

  it("a CAM@3 senior_programmer meets a sheet-3 Senior post", () => {
    expect(
      levelFitFor(levelNeededSpec("cam_programmer", "senior")!, "senior_programmer", true),
    ).toBe("meets");
  });

  it("orders the groups meets < not_confirmed < below", () => {
    expect(LEVEL_FIT_ORDER.meets).toBeLessThan(LEVEL_FIT_ORDER.not_confirmed);
    expect(LEVEL_FIT_ORDER.not_confirmed).toBeLessThan(LEVEL_FIT_ORDER.below);
  });
});

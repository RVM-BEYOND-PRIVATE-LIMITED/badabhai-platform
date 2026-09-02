/**
 * The question-pack seeder's PURE PLANNERS — and above all its item-to-option mapping.
 *
 * WHY THIS FILE EXISTS. The seeder used to write ~2,150 single-row statements with no
 * transaction, and a dropped connection on the fifth of 145 packs left a live trade
 * serving one of its five questions. Batching the inserts fixes the exposure and
 * introduces one sharp new way to be wrong: an item's `item_id` is a surrogate the
 * database mints, so a batched insert has to read the ids back with `RETURNING` — and
 * Postgres does NOT promise `RETURNING` rows arrive in `VALUES` order. Attaching options
 * to items by POSITION would be correct on every run where the server happens to return
 * them in order and catastrophic on the one where it does not: the chips of one trade's
 * question, silently hanging off another trade's question, with no constraint violated
 * and nothing at run time to report it.
 *
 * So the interesting tests here are the ones that hand the planner a RETURNING order that
 * is deliberately NOT the VALUES order. Each one names the mutation it catches, because a
 * test that passes against a positional implementation is worse than no test — it makes
 * the thing look covered.
 *
 * Deliberately NOT a database test. The statements themselves are five inserts and a
 * delete whose correctness is a property of the schema's constraints; proving that needs a
 * real Postgres, which is `pnpm db:verify:packs`, not a unit test pretending to have one.
 *
 * Importing this module runs no CLI: `seed-question-packs.ts` guards its `main()`.
 */
import { describe, expect, it } from "vitest";

import { chunkSizeForColumns, PG_MAX_BIND_PARAMS } from "./chunk";
import type { PackItemRecord, PackRecord } from "./question-pack-corpus";
import {
  BINDING_INSERT_COLUMNS,
  FAMILY_INSERT_COLUMNS,
  indexItemIds,
  ITEM_INSERT_COLUMNS,
  itemKey,
  OPTION_INSERT_COLUMNS,
  PACK_INSERT_COLUMNS,
  PACK_KEY_COLUMNS,
  planBindingRows,
  planFamilyRows,
  planItemRows,
  planOptionRows,
  planPackRows,
  type InsertedItemRow,
  type PlannedItemRow,
} from "./seed-question-packs";

const NOW = new Date("2026-09-02T00:00:00.000Z");

function item(overrides: Partial<PackItemRecord> = {}): PackItemRecord {
  return {
    question_key: "experience_years",
    prompt_text: "Kitne saal se ye kaam kar rahe ho?",
    target_kind: "rfs",
    target_field: "total_experience_months",
    answer_type: "duration",
    ...overrides,
  };
}

function pack(overrides: Partial<PackRecord> = {}): PackRecord {
  return {
    pack_id: "qp_welding",
    version: 1,
    family_id: "fam_welding",
    items: [item()],
    ...overrides,
  };
}

/**
 * The id the fake server mints, built so a wrong attachment is READABLE in the failure
 * message: an option carrying `id:qp_fitting:1:experience_years` when it belongs to
 * `qp_welding` names both halves of the bug on the spot.
 */
function fakeItemId(r: { packId: string; packVersion: number; questionKey: string }): string {
  return `id:${r.packId}:${r.packVersion}:${r.questionKey}`;
}

/**
 * What `RETURNING` hands back, in an order that is deliberately NOT the VALUES order.
 *
 * Reversing is the cheapest order that is wrong in a way positional code cannot survive:
 * with n items, zipping planned[i] to returned[i] mis-attaches every row but the middle
 * one. Postgres is free to return any order at all; this stands in for all of them.
 */
function returnedOutOfOrder(rows: readonly PlannedItemRow[]): InsertedItemRow[] {
  return rows
    .map((r) => ({
      itemId: fakeItemId(r),
      packId: r.packId,
      packVersion: r.packVersion,
      questionKey: r.questionKey,
    }))
    .reverse();
}

describe("planItemRows", () => {
  it("restarts display_order at 0 for every pack", () => {
    // CATCHES: a single counter carried across packs. That would not merely renumber rows,
    // it would reorder the interview for all 144 packs after the first — and the corpus
    // would still seed cleanly, because `qpi_display_order_chk` only demands >= 0.
    const rows = planItemRows([
      pack({ items: [item({ question_key: "a" }), item({ question_key: "b" })] }),
      pack({
        pack_id: "qp_fitting",
        family_id: "fam_fitting",
        items: [item({ question_key: "c" }), item({ question_key: "d" })],
      }),
    ]);
    expect(rows.map((r) => [r.packId, r.questionKey, r.displayOrder])).toEqual([
      ["qp_welding", "a", 0],
      ["qp_welding", "b", 1],
      ["qp_fitting", "c", 0],
      ["qp_fitting", "d", 1],
    ]);
  });

  it("coalesces every optional field, so an absent key becomes an explicit value", () => {
    // CATCHES: dropping a `?? null` / `?? false` / `?? 2`. `undefined` makes drizzle emit
    // the DEFAULT keyword instead of a bound parameter, which changes the statement's
    // shape (and therefore its parameter count) invisibly.
    const [row] = planItemRows([pack()]);
    expect(row).toMatchObject({
      whyText: null,
      retryText: null,
      targetSkillId: null,
      isMandatory: false,
      isCore: false,
      maxAsks: 2,
      minTurn: null,
      maxTurn: null,
      askIf: null,
      skipIf: null,
      parentItemKey: null,
    });
  });

  it("binds exactly ITEM_INSERT_COLUMNS values per row", () => {
    // CATCHES: a column added to the planner without bumping the budget the chunk size is
    // derived from. The margin under the 65535-parameter ceiling would shrink silently and
    // the failure would surface only as a production apply that dies once the corpus grows.
    const [row] = planItemRows([pack()]);
    expect(Object.keys(row as object)).toHaveLength(ITEM_INSERT_COLUMNS);
  });
});

describe("item -> option attachment under batching", () => {
  it("attaches options by KEY, not by RETURNING position", () => {
    // CATCHES: zipping planned rows to RETURNING rows by index. With the ids handed back
    // reversed, positional code gives welding's chips to fitting's question and vice versa.
    const packs = [
      pack({
        items: [
          item({
            question_key: "welding_type",
            answer_type: "single_select",
            options: [
              { option_key: "gas", label_text: "Gas welding" },
              { option_key: "arc", label_text: "Arc welding" },
            ],
          }),
        ],
      }),
      pack({
        pack_id: "qp_fitting",
        family_id: "fam_fitting",
        items: [
          item({
            question_key: "fitting_type",
            answer_type: "single_select",
            options: [{ option_key: "pipe", label_text: "Pipe fitting" }],
          }),
        ],
      }),
    ];
    const planned = planItemRows(packs);
    const rows = planOptionRows(packs, indexItemIds(returnedOutOfOrder(planned)));
    expect(rows.map((r) => [r.optionKey, r.itemId])).toEqual([
      ["gas", "id:qp_welding:1:welding_type"],
      ["arc", "id:qp_welding:1:welding_type"],
      ["pipe", "id:qp_fitting:1:fitting_type"],
    ]);
  });

  it("distinguishes the SAME question_key in two packs", () => {
    // CATCHES: keying the id map on question_key alone. `question_key` is unique only
    // WITHIN a pack (`qpi_pack_question_uq`), and `experience_years` is in most of the 145
    // — so a bare-key map would give every pack the last pack's item_id. This is the exact
    // shape of a chunk of 500 items, which always spans packs.
    const shared = (packId: string, label: string): PackRecord =>
      pack({
        pack_id: packId,
        family_id: `fam_${packId}`,
        items: [
          item({
            question_key: "experience_years",
            answer_type: "single_select",
            options: [{ option_key: "under_1", label_text: label }],
          }),
        ],
      });
    const packs = [shared("qp_welding", "Ek saal se kam"), shared("qp_fitting", "1 saal se kam")];
    const rows = planOptionRows(packs, indexItemIds(returnedOutOfOrder(planItemRows(packs))));
    expect(rows.map((r) => r.itemId)).toEqual([
      "id:qp_welding:1:experience_years",
      "id:qp_fitting:1:experience_years",
    ]);
  });

  it("distinguishes two VERSIONS of one pack", () => {
    // CATCHES: keying on (pack_id, question_key) and dropping the version. Two versions of
    // a pack legitimately coexist — (pack_id, version) is the primary key — and v1's chips
    // landing on v2's item would corrupt a version that is supposed to be immutable.
    const versioned = (version: number): PackRecord =>
      pack({
        version,
        items: [
          item({
            question_key: "welding_type",
            answer_type: "single_select",
            options: [{ option_key: "gas", label_text: "Gas welding" }],
          }),
        ],
      });
    const packs = [versioned(1), versioned(2)];
    const rows = planOptionRows(packs, indexItemIds(returnedOutOfOrder(planItemRows(packs))));
    expect(rows.map((r) => r.itemId)).toEqual([
      "id:qp_welding:1:welding_type",
      "id:qp_welding:2:welding_type",
    ]);
  });

  it("restarts option display_order at 0 for every item", () => {
    // CATCHES: a counter scoped to the pack rather than the item. The chips would still
    // insert (`qpo_display_order_chk` only demands >= 0) and the second question's chips
    // would render in a valid but wrong order behind the first question's.
    const packs = [
      pack({
        items: [
          item({
            question_key: "welding_type",
            answer_type: "single_select",
            options: [
              { option_key: "gas", label_text: "Gas" },
              { option_key: "arc", label_text: "Arc" },
            ],
          }),
          item({
            question_key: "shift_pref",
            answer_type: "single_select",
            options: [{ option_key: "night", label_text: "Night" }],
          }),
        ],
      }),
    ];
    const rows = planOptionRows(packs, indexItemIds(returnedOutOfOrder(planItemRows(packs))));
    expect(rows.map((r) => [r.optionKey, r.displayOrder])).toEqual([
      ["gas", 0],
      ["arc", 1],
      ["night", 0],
    ]);
  });

  it("THROWS when an item's id never came back, instead of dropping its chips", () => {
    // CATCHES: the old `if (itemId === undefined) continue`. Silently skipping is exactly
    // the damage the incident produced — an active question with no options and nothing to
    // alert on. Inside the seed's transaction this throw rolls the whole run back.
    const packs = [
      pack({
        items: [
          item({
            question_key: "welding_type",
            answer_type: "single_select",
            options: [{ option_key: "gas", label_text: "Gas" }],
          }),
        ],
      }),
    ];
    expect(() => planOptionRows(packs, new Map())).toThrow(/qp_welding v1 welding_type/);
  });

  it("THROWS when two returned rows share an item key", () => {
    // CATCHES: narrowing the key until it stops identifying a row. A Map would otherwise
    // keep the last writer and hand one item's id to another item's options — the silent
    // version of the bug the test above makes loud.
    const dup: InsertedItemRow = {
      itemId: "id:a",
      packId: "qp_welding",
      packVersion: 1,
      questionKey: "welding_type",
    };
    expect(() => indexItemIds([dup, { ...dup, itemId: "id:b" }])).toThrow(/not identifying/);
  });

  it("binds exactly OPTION_INSERT_COLUMNS values per row", () => {
    // CATCHES: the option budget drifting from the planner, same as the item case above.
    const packs = [
      pack({
        items: [
          item({
            question_key: "welding_type",
            answer_type: "single_select",
            options: [{ option_key: "gas", label_text: "Gas" }],
          }),
        ],
      }),
    ];
    const [row] = planOptionRows(packs, indexItemIds(returnedOutOfOrder(planItemRows(packs))));
    expect(Object.keys(row as object)).toHaveLength(OPTION_INSERT_COLUMNS);
  });

  it("itemKey is injective over the three components", () => {
    // CATCHES: a key built by bare concatenation. This pair is the whole point of the
    // test — both sides concatenate to "qp_a11b", and BOTH are legal corpus values:
    // `qp_a` and `qp_a1` each satisfy `^qp_[a-z0-9_]+$`, versions 11 and 1 are integers,
    // and `b` satisfies `^[a-z_]+$`. Drop the separator and two different packs' items
    // hash together, so one pack's chips silently hang off the other's question.
    //
    // The earlier assertions here were both satisfied by bare concatenation
    // ("qp_a1b" != "qp_a11b", "qp_a1bc" != "qp_ab1c"), so the test named a mutation it
    // did not actually catch — kept below, but they are not the load-bearing case.
    expect(itemKey("qp_a", 11, "b")).not.toBe(itemKey("qp_a1", 1, "b"));
    expect(itemKey("qp_a", 1, "b")).not.toBe(itemKey("qp_a", 11, "b"));
    expect(itemKey("qp_a", 1, "bc")).not.toBe(itemKey("qp_ab", 1, "c"));
  });
});

describe("chunk sizes stay under Postgres' Bind ceiling", () => {
  // CATCHES: taking `--batch-size` on faith. `parseCommonCli` accepts up to 10000, and
  // 10000 x 19 columns is 190,000 bound parameters against a hard limit of 65,535 — the
  // server rejects the whole statement, so the apply dies part-way with the corpus half
  // written, which is the failure this change exists to remove.
  const budgets: [string, number][] = [
    ["families", FAMILY_INSERT_COLUMNS],
    ["bindings", BINDING_INSERT_COLUMNS],
    ["packs", PACK_INSERT_COLUMNS],
    ["pack keys (the item DELETE)", PACK_KEY_COLUMNS],
    ["items", ITEM_INSERT_COLUMNS],
    ["options", OPTION_INSERT_COLUMNS],
  ];

  it.each(budgets)("%s: the CLI maximum is clamped, not trusted", (_name, columns) => {
    const size = chunkSizeForColumns(10_000, columns);
    expect(size).toBeGreaterThan(0);
    expect(size * columns).toBeLessThanOrEqual(PG_MAX_BIND_PARAMS);
  });

  it.each(budgets)("%s: the DEFAULT batch of 500 is passed through unchanged", (_name, columns) => {
    // The clamp must not quietly shrink the ordinary run into more round trips than
    // asked for; at 500 rows the widest statement here is 9,500 parameters.
    expect(chunkSizeForColumns(500, columns)).toBe(500);
  });
});

describe("the remaining planners", () => {
  it("planFamilyRows defaults status to active and coalesces the optional labels", () => {
    // CATCHES: dropping `?? "active"`, which would insert NULL into a NOT NULL column and
    // abort the apply, or dropping a `?? null` on the nullable crosswalk columns.
    expect(planFamilyRows([{ kind: "family", family_id: "fam_welding", label_en: "Welding" }], NOW)).toEqual([
      {
        familyId: "fam_welding",
        labelEn: "Welding",
        labelHi: null,
        canonicalRoleId: null,
        industryId: null,
        status: "active",
        updatedAt: NOW,
      },
    ]);
  });

  it("planPackRows defaults locale to hi-IN and status to draft", () => {
    // CATCHES: defaulting a pack to `active`. `question_pack_active_uq` allows one active
    // version per (family, locale), so a wrong default turns an authoring mistake into an
    // aborted apply — or, worse, publishes an unreviewed pack.
    expect(planPackRows([pack()], NOW)).toEqual([
      {
        packId: "qp_welding",
        version: 1,
        familyId: "fam_welding",
        locale: "hi-IN",
        status: "draft",
        reviewNote: null,
        updatedAt: NOW,
      },
    ]);
  });

  it("planBindingRows derives specificity from the target and drops an untargeted row", () => {
    // CATCHES: hardcoding a specificity, which `pfb_specificity_matches_target_chk` would
    // reject, and losing the `continue` that keeps a targetless record out of the insert.
    const rows = planBindingRows([
      { kind: "binding", family_id: "fam_welding", isco_unit_code: "7212" },
      { kind: "binding", family_id: "fam_universal", is_universal: true },
      { kind: "binding", family_id: "fam_broken" },
    ]);
    expect(rows.map((r) => [r.familyId, r.specificity, r.isUniversal])).toEqual([
      ["fam_welding", 40, false],
      ["fam_universal", 0, true],
    ]);
  });

  it("binds exactly the declared number of values for families, bindings and packs", () => {
    // CATCHES: any of those three budgets drifting from its planner.
    expect(
      Object.keys(planFamilyRows([{ kind: "family", family_id: "fam_a", label_en: "A" }], NOW)[0] as object),
    ).toHaveLength(FAMILY_INSERT_COLUMNS);
    expect(
      Object.keys(planBindingRows([{ kind: "binding", family_id: "fam_a", is_universal: true }])[0] as object),
    ).toHaveLength(BINDING_INSERT_COLUMNS);
    expect(Object.keys(planPackRows([pack()], NOW)[0] as object)).toHaveLength(PACK_INSERT_COLUMNS);
  });
});

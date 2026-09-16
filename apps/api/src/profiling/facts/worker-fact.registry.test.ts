import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CROSSWALK_FIELD_IDS } from "@badabhai/profiling-lexicon";

import { SetMyEmploymentSchema } from "../../profiles/worker-employment.dto";
import { SetMyPreferencesSchema } from "../../profiles/worker-preferences.dto";
import { PREFERENCE_KEYS } from "../../profiles/worker-preferences.vocabulary";
import { SetMyQualificationsSchema } from "../../profiles/worker-qualifications.dto";
import { ENABLED_ROLE_DESCRIPTORS } from "../roles/role-registry";
import {
  factForPackItem,
  factMatchesForPackItem,
  MARKER_OWNED_FACTS,
  NOT_A_WORKER_FACT,
  WORKER_FACT_IDS,
  WORKER_FACTS,
  type FactAliasKind,
  type MarkerScreenType,
} from "./worker-fact.registry";

/**
 * ═══ THE REGISTRY IS EXHAUSTIVE, OR IT IS A SECOND PLACE TO FORGET SOMETHING ═══
 *
 * A fact registry that nothing holds complete is worse than none: a consumer trusts it to know
 * every spelling, and the one it misses is the duplicate that ships. So every source of spellings
 * the platform actually has is read here — every ACTIVE pack in the corpus, the RFS crosswalk,
 * `PREFERENCE_KEYS` and the three marker DTOs — and anything that looks like a worker fact must
 * either resolve to exactly one fact or be named in `NOT_A_WORKER_FACT` with a reason.
 */

const PACK_DIR = join(__dirname, "../../../../../packages/db/data/question-packs/packs");

interface RawItem {
  readonly question_key: string;
  readonly target_kind?: string;
  readonly target_field?: string | null;
}
interface RawPack {
  readonly pack_id: string;
  readonly version: number;
  readonly status: string;
  readonly items: readonly RawItem[];
}

const ACTIVE_PACKS: readonly RawPack[] = readdirSync(PACK_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")) as RawPack)
  .filter((pack) => pack.status === "active");

const ALL_ITEMS = ACTIVE_PACKS.flatMap((pack) =>
  pack.items.map((item) => ({ where: `${pack.pack_id}@${pack.version}.${item.question_key}`, item })),
);

/**
 * WHAT "LOOKS LIKE A WORKER FACT". Token-bounded so `turning_capacity` does not match on "city"
 * the way a bare substring would — a pattern that flags innocent keys gets an exclusion list that
 * grows until nobody reads it. `trade` is anchored WHOLE for the same reason: as a token it flags
 * `trade_test_status` on every form pack and `learning_trade`, neither of which is the worker's
 * trade.
 */
const FACT_SHAPED =
  /(^|_)(experience|city|location|locations|salary|shift|night|education|availability|certification|certifications|work_history|language|languages|documents|job_type|relocation|accommodation)(_|$)|^(primary_)?trade$/;

const aliasNames = (kind: FactAliasKind): ReadonlySet<string> =>
  new Set(
    Object.values(WORKER_FACTS).flatMap((definition) =>
      definition.aliases.filter((alias) => alias.kind === kind).map((alias) => alias.name),
    ),
  );

describe("worker fact registry", () => {
  it("VACUITY — reads a real corpus", () => {
    expect(ACTIVE_PACKS.length).toBeGreaterThan(50);
    expect(ALL_ITEMS.filter(({ item }) => FACT_SHAPED.test(item.question_key)).length).toBeGreaterThan(
      20,
    );
  });

  it("every fact-shaped item in every active pack resolves to EXACTLY one fact", () => {
    const wrong: string[] = [];
    for (const { where, item } of ALL_ITEMS) {
      const shaped =
        FACT_SHAPED.test(item.question_key) || FACT_SHAPED.test(item.target_field ?? "");
      if (!shaped) continue;
      const excluded =
        item.question_key in NOT_A_WORKER_FACT || (item.target_field ?? "") in NOT_A_WORKER_FACT;
      const matches = factMatchesForPackItem({
        question_key: item.question_key,
        target_field: item.target_field ?? null,
      });
      const expected = excluded ? 0 : 1;
      if (matches.length !== expected) {
        wrong.push(`${where} → [${matches.map((match) => match.fact).join(", ")}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every RFS-targeted item names a registered fact or a considered exclusion", () => {
    const wrong = ALL_ITEMS.filter(
      ({ item }) =>
        item.target_kind === "rfs" &&
        factMatchesForPackItem({ question_key: item.question_key, target_field: item.target_field ?? null })
          .length === 0 &&
        !((item.target_field ?? "") in NOT_A_WORKER_FACT),
    ).map(({ where, item }) => `${where} (${item.target_field})`);
    expect(wrong).toEqual([]);
  });

  it("every RFS crosswalk field is a registered target_field or a considered exclusion", () => {
    const registered = aliasNames("target_field");
    const missing = [...CROSSWALK_FIELD_IDS].filter(
      (field) => !registered.has(field) && !(field in NOT_A_WORKER_FACT),
    );
    expect(CROSSWALK_FIELD_IDS.size).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("every PREFERENCE_KEYS key is a registered attribute_key or a considered exclusion", () => {
    const registered = aliasNames("attribute_key");
    const missing = Object.keys(PREFERENCE_KEYS).filter(
      (key) => !registered.has(key) && !(key in NOT_A_WORKER_FACT),
    );
    expect(missing).toEqual([]);
  });

  it("no exclusion is stale — each names something a source actually carries", () => {
    const carried = new Set<string>([
      ...CROSSWALK_FIELD_IDS,
      ...Object.keys(PREFERENCE_KEYS),
      ...ALL_ITEMS.flatMap(({ item }) => [item.question_key, item.target_field ?? ""]),
    ]);
    expect(Object.keys(NOT_A_WORKER_FACT).filter((name) => !carried.has(name))).toEqual([]);
  });

  it("no alias NAME belongs to two facts, whatever its kind", () => {
    const owners = new Map<string, Set<string>>();
    for (const definition of Object.values(WORKER_FACTS)) {
      for (const alias of definition.aliases) {
        owners.set(alias.name, (owners.get(alias.name) ?? new Set()).add(definition.id));
      }
    }
    const shared = [...owners.entries()]
      .filter(([, facts]) => facts.size > 1)
      .map(([name, facts]) => `${name}: ${[...facts].join(", ")}`);
    expect(shared).toEqual([]);
    // And an alias is never also an exclusion.
    expect([...owners.keys()].filter((name) => name in NOT_A_WORKER_FACT)).toEqual([]);
  });

  it("every fact is keyed by its own id, declares a strength on every alias, and can be settled", () => {
    expect(Object.keys(WORKER_FACTS).sort()).toEqual([...WORKER_FACT_IDS].sort());
    for (const [id, definition] of Object.entries(WORKER_FACTS)) {
      expect(definition.id).toBe(id);
      for (const alias of definition.aliases) {
        expect(["settles", "prefill_hint"], `${id}.${alias.name}`).toContain(alias.strength);
      }
      expect(
        definition.aliases.some((alias) => alias.strength === "settles"),
        `${id} has no settling alias, so nothing can ever settle it`,
      ).toBe(true);
    }
  });

  it.each(ENABLED_ROLE_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor] as const))(
    "%s — its tier question is the form's EXPERIENCE ask",
    (_kind, descriptor) => {
      expect(
        factForPackItem({
          question_key: descriptor.tenureQuestionKey,
          target_field: descriptor.tenureQuestionKey,
        }),
      ).toEqual({ fact: "experience", strength: "settles" });
    },
  );

  it("a yes/no shift or night-work item is a HINT and can never settle the shift preference", () => {
    for (const key of ["shift_work", "night_work"]) {
      expect(factForPackItem({ question_key: key, target_field: key })).toEqual({
        fact: "shift",
        strength: "prefill_hint",
      });
    }
    // The discriminating half: the preference itself does settle it.
    expect(
      factForPackItem({ question_key: "shift_preference", target_field: "shift_preference" }),
    ).toEqual({ fact: "shift", strength: "settles" });
  });

  it("a capability question names no fact", () => {
    expect(factForPackItem({ question_key: "turning_machine", target_field: "turning_machine" })).toBeNull();
  });

  it("an item naming two facts FAILS CLOSED rather than picking one", () => {
    expect(() =>
      factForPackItem({ question_key: "shift_preference", target_field: "education_level" }),
    ).toThrow(/names 2 worker facts/);
  });

  describe("marker ownership", () => {
    const unwrap = (schema: z.ZodTypeAny): z.AnyZodObject =>
      (schema instanceof z.ZodEffects ? unwrap(schema.innerType()) : schema) as z.AnyZodObject;
    const DTO_FIELDS: Readonly<Record<MarkerScreenType, ReadonlySet<string>>> = {
      preferences: new Set(Object.keys(unwrap(SetMyPreferencesSchema).shape)),
      qualifications: new Set(Object.keys(unwrap(SetMyQualificationsSchema).shape)),
      employment: new Set(Object.keys(unwrap(SetMyEmploymentSchema).shape)),
    };

    it("no fact is owned by two marker pages", () => {
      const owned = Object.values(MARKER_OWNED_FACTS).flat();
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.filter((fact, index) => owned.indexOf(fact) !== index)).toEqual([]);
    });

    it.each(Object.keys(MARKER_OWNED_FACTS) as MarkerScreenType[])(
      "%s — every fact it owns is spelled by a field its PUT DTO really has",
      (marker) => {
        expect(DTO_FIELDS[marker].size, `${marker}: no DTO fields read`).toBeGreaterThan(0);
        for (const fact of MARKER_OWNED_FACTS[marker]) {
          const spelled = WORKER_FACTS[fact].aliases.some(
            (alias) =>
              alias.kind === "marker_dto_field" &&
              alias.strength === "settles" &&
              DTO_FIELDS[marker].has(alias.name),
          );
          expect(spelled, `${marker} owns ${fact} but its DTO has no settling field for it`).toBe(
            true,
          );
        }
      },
    );
  });
});

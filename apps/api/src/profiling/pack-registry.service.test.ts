import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { PackRegistryService, computeContentHash } from "./pack-registry.service";
import { PACK_CACHE_MAX_ENTRIES, PACK_RESOLUTION_TTL_MS } from "./pack-cache.constants";
import { fakePackCache, type FakePackCache } from "./pack-cache.fake";
import type { PackHeadRow, PackItemRow, PackOptionRow } from "./pack.repository";

const NOW = 1_700_000_000_000;

function itemRow(over: Partial<PackItemRow> & { questionKey: string }): PackItemRow {
  return {
    itemId: `item_${over.questionKey}`,
    displayOrder: 0,
    promptText: `${over.questionKey}?`,
    whyText: null,
    retryText: null,
    targetKind: "none",
    targetField: null,
    targetSkillId: null,
    answerType: "text",
    isMandatory: false,
    isCore: false,
    maxAsks: 2,
    minTurn: null,
    maxTurn: null,
    askIf: null,
    skipIf: null,
    parentItemKey: null,
    ...over,
  };
}

function head(packId: string, familyId: string, version = 1): PackHeadRow {
  return { packId, version, familyId, locale: "hi-IN", contentHash: null };
}

/**
 * A repository fake holding whole packs, so a test states WHICH families have packs rather than
 * which four queries return what.
 */
/**
 * A binding as the SHARED resolver reads it. Built from the level rather than hand-written, so a
 * test cannot accidentally describe a binding the `pfb_specificity_matches_target_chk` constraint
 * would reject — which would make the fallback tests pass against rows the database cannot hold.
 */
function binding(familyId: string, specificity: number) {
  const target: Record<number, Record<string, unknown>> = {
    50: { jobDomainId: "dom_welder" },
    40: { iscoUnitCode: "7212" },
    30: { iscoMinorCode: "721" },
    20: { iscoSubmajorCode: "72" },
    10: { iscoMajorCode: "7" },
    0: { isUniversal: true },
  };
  return { familyId, specificity, ...target[specificity] };
}

function makeRegistry(world: {
  bindings?: { familyId: string; specificity: number }[];
  packs?: Record<string, { head: PackHeadRow; items: PackItemRow[] }>;
  options?: PackOptionRow[];
  /** Share one L2 across two registries, to prove a cold instance reads a warm one's entry. */
  shared?: FakePackCache;
}) {
  const packs = world.packs ?? {};
  const repo = {
    findBindings: vi.fn(async () => world.bindings ?? []),
    findActivePacks: vi.fn(async (familyIds: readonly string[]) =>
      Object.values(packs)
        .map((p) => p.head)
        .filter((h) => familyIds.includes(h.familyId)),
    ),
    findPackHead: vi.fn(
      async (packId: string, version: number) =>
        Object.values(packs).find((p) => p.head.packId === packId && p.head.version === version)
          ?.head ?? null,
    ),
    // Keyed on (packId, VERSION), like the real query. Ignoring the version here would make the
    // pinning tests pass for the wrong reason — the fake would be answering a question the
    // implementation is not asking.
    findItems: vi.fn(
      async (packId: string, version: number) =>
        Object.values(packs).find((p) => p.head.packId === packId && p.head.version === version)
          ?.items ?? [],
    ),
    findOptions: vi.fn(async (itemIds: readonly string[]) =>
      (world.options ?? []).filter((o) => itemIds.includes(o.itemId)),
    ),
  };
  const config = { PROFILING_PACK_LOCALE: "hi-IN" };
  // A REAL in-memory shared tier, not a null object — see `pack-cache.fake.ts`. A double that
  // always missed would make every caching assertion below pass against an implementation that
  // cached nothing at all.
  const shared = world.shared ?? fakePackCache();
  return {
    registry: new PackRegistryService(config as never, repo as never, shared.cache),
    repo,
    shared,
  };
}

const WELDING = {
  head: head("qp_welding", "fam_welding"),
  items: [itemRow({ questionKey: "q_process" })],
};
const METAL = {
  head: head("qp_metal", "fam_metal_trades"),
  items: [itemRow({ questionKey: "q_metal" })],
};
const UNIVERSAL = {
  head: head("qp_universal", "fam_universal"),
  items: [itemRow({ questionKey: "q_city" })],
};

const PIN = {
  job_domain_id: "dom_welder",
  label: "Welder",
  isco_unit_code: "7212",
  match_status: "matched_lexical" as const,
  match_score: 0.9,
  match_layer: "l1_skeleton" as const,
  pack_id: null,
  pack_version: null,
  catalog_version: null,
};

describe("the fallback chain — most specific wins", () => {
  it("takes the job-domain pack over every broader one", async () => {
    const { registry } = makeRegistry({
      bindings: [
        binding("fam_welding", 50),
        binding("fam_metal_trades", 20),
        binding("fam_universal", 0),
      ],
      packs: { WELDING, METAL, UNIVERSAL },
    });
    expect((await registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_welding");
  });

  it("FALLS THROUGH a family that has a binding but no ACTIVE pack", async () => {
    // Phase 6 lands 200 families incrementally, so a half-authored family is the NORMAL state.
    // Aborting the chain there would leave a worker with no interview at all.
    const { registry } = makeRegistry({
      bindings: [
        binding("fam_welding", 50),
        binding("fam_metal_trades", 20),
        binding("fam_universal", 0),
      ],
      packs: { METAL, UNIVERSAL },
    });
    expect((await registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_metal");
  });

  it("lands on the universal pack when nothing more specific has one", async () => {
    const { registry } = makeRegistry({
      bindings: [binding("fam_welding", 50), binding("fam_universal", 0)],
      packs: { UNIVERSAL },
    });
    expect((await registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_universal");
  });

  it("resolves a SHORT ISCO code the way Postgres does, not the way a stricter rule would", async () => {
    // REGRESSION. This service used to derive the ancestry itself behind a `^[0-9]{4}$` guard, so
    // a 3-digit code yielded all-nulls and fell to the universal pack — while `RESOLVE_FAMILY_SQL`
    // used `left(code, 3)` and found a real family. The engine and the deploy gate disagreed about
    // the same worker. Deferring to the shared `resolveFamily` is what fixes it.
    const { registry } = makeRegistry({
      bindings: [binding("fam_metal_trades", 30), binding("fam_universal", 0)],
      packs: { METAL, UNIVERSAL },
    });
    const shortCode = { ...PIN, job_domain_id: "dom_unbound", isco_unit_code: "721" };
    expect((await registry.resolveForOccupation(shortCode, NOW))?.pack_id).toBe("qp_metal");
  });

  it("returns null when even the universal pack is missing", async () => {
    // A seeding failure, not a normal outcome — the caller closes with `no_pack` rather than
    // degrading to an interview with no questions in it.
    const { registry } = makeRegistry({ bindings: [], packs: {} });
    expect(await registry.resolveForOccupation(PIN, NOW)).toBeNull();
  });

  it("resolves the universal pack with no occupation at all", async () => {
    const { registry } = makeRegistry({
      bindings: [binding("fam_universal", 0)],
      packs: { UNIVERSAL },
    });
    expect((await registry.loadUniversal(NOW))?.pack_id).toBe("qp_universal");
  });
});

describe("pinning — risk #13, a pack release must not move under a live interview", () => {
  it("loads the EXACT version asked for, never the active one", async () => {
    const v1 = { head: head("qp_welding", "fam_welding", 1), items: WELDING.items };
    const v2 = {
      head: head("qp_welding", "fam_welding", 2),
      items: [itemRow({ questionKey: "q_new" })],
    };
    const { registry } = makeRegistry({ packs: { v1, v2 } });
    const pinned = await registry.loadPinned("qp_welding", 1, NOW);
    expect(pinned?.version).toBe(1);
    expect(pinned?.items.map((i) => i.question_key)).toEqual(["q_process"]);
  });

  it("returns null rather than substituting a different version", async () => {
    // Answering question 7 of a pack whose questions 1–6 the worker was never asked is worse
    // than closing the interview.
    const { registry } = makeRegistry({ packs: { WELDING } });
    expect(await registry.loadPinned("qp_welding", 9, NOW)).toBeNull();
  });
});

describe("validation on the way OUT of the database", () => {
  it("DROPS a pack whose row violates the contract, and falls through to the next level", async () => {
    // `db:verify:packs` gates authoring, but a row can be hand-edited or restored from an older
    // dump — and this is the object a LIVE interview reads.
    const broken = {
      head: head("qp_welding", "fam_welding"),
      // An EMPTY prompt passes the database (`prompt_text` is NOT NULL, not non-empty) and fails
      // the contract's `min(1)`. A question with no words is not a question.
      items: [itemRow({ questionKey: "q_bad", promptText: "" })],
    };
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { registry } = makeRegistry({
      bindings: [binding("fam_welding", 50), binding("fam_universal", 0)],
      packs: { broken, UNIVERSAL },
    });
    expect((await registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_universal");
    vi.restoreAllMocks();
  });

  it("keeps a well-formed ask_if and DROPS a malformed one to null", async () => {
    // An unevaluatable condition must mean "no condition", never a hard failure that ends the
    // interview and never something the evaluator has to guess at.
    const withPredicates = {
      head: head("qp_welding", "fam_welding"),
      items: [
        itemRow({
          questionKey: "q_a",
          askIf: { op: "answered", field: "q_city" },
          skipIf: { op: "nonsense_operator" },
        }),
      ],
    };
    const { registry } = makeRegistry({ packs: { withPredicates } });
    const pack = await registry.loadPinned("qp_welding", 1, NOW);
    expect(pack?.items[0]?.ask_if).toEqual({ op: "answered", field: "q_city" });
    expect(pack?.items[0]?.skip_if).toBeNull();
  });

  it("MAPS the three answer types the database allows and the contract does not", async () => {
    // Migration 0069's CHECK accepts 'city' | 'salary' | 'duration'; ANSWER_TYPES does not. A
    // reviewer authoring a perfectly legal row would otherwise drop the ENTIRE pack, leaving
    // that trade with no interview at all.
    const typed = {
      head: head("qp_welding", "fam_welding"),
      items: [
        itemRow({ questionKey: "q_city", answerType: "city", displayOrder: 0 }),
        itemRow({ questionKey: "q_pay", answerType: "salary", displayOrder: 1 }),
        itemRow({ questionKey: "q_len", answerType: "duration", displayOrder: 2 }),
        itemRow({ questionKey: "q_free", answerType: "text", displayOrder: 3 }),
      ],
    };
    const { registry } = makeRegistry({ packs: { typed } });
    const pack = await registry.loadPinned("qp_welding", 1, NOW);
    expect(pack?.items.map((i) => i.answer_type)).toEqual(["text", "number", "number", "text"]);
  });

  it("derives content_hash rather than reading the column nothing writes", async () => {
    // The column is nullable and currently written by nothing; trusting it would make a REQUIRED
    // contract field null for every pack and drop all of them at validation.
    const { registry } = makeRegistry({ packs: { WELDING } });
    const pack = await registry.loadPinned("qp_welding", 1, NOW);
    expect(pack?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two packs with different content different hashes", async () => {
    expect(computeContentHash([{ a: 1 }])).not.toBe(computeContentHash([{ a: 2 }]));
    expect(computeContentHash([{ a: 1 }])).toBe(computeContentHash([{ a: 1 }]));
  });
});

describe("chips — three typed value columns, one contract field", () => {
  const chip = (over: Partial<PackOptionRow> & { optionKey: string }): PackOptionRow => ({
    itemId: "item_q_shift",
    displayOrder: 0,
    labelText: over.optionKey,
    valueText: null,
    valueNumber: null,
    valueBool: null,
    impliesSkillId: null,
    isNoneOfAbove: false,
    ...over,
  });

  it("takes whichever typed column is populated, and falls back to the LABEL", async () => {
    // The label IS the worker's answer of record when tapped, so a chip with no typed value is
    // not a defect — it is the common case for a plain multiple choice.
    const chips = {
      head: head("qp_welding", "fam_welding"),
      items: [itemRow({ questionKey: "q_shift", answerType: "single_select" })],
    };
    const { registry } = makeRegistry({
      packs: { chips },
      options: [
        chip({ optionKey: "day", labelText: "Din", valueText: "day", displayOrder: 0 }),
        chip({ optionKey: "hours", labelText: "12 ghante", valueNumber: 12, displayOrder: 1 }),
        chip({ optionKey: "yes", labelText: "Haan", valueBool: true, displayOrder: 2 }),
        chip({ optionKey: "none", labelText: "Koi nahi", isNoneOfAbove: true, displayOrder: 3 }),
      ],
    });
    const options = (await registry.loadPinned("qp_welding", 1, NOW))?.items[0]?.options;
    // TYPED, NOT STRINGIFIED. This line used to read `["day", "12", "true", null]` and it was
    // pinning the defect: `String()` on the number and the boolean columns meant every layer
    // downstream — which routes on the value's SHAPE — saw text. See `typed-option-value.test.ts`
    // for the three consequences, one of which throws in the extraction job.
    expect(options?.map((o) => o.value)).toEqual(["day", 12, true, null]);
    expect(options?.map((o) => o.is_none_of_above)).toEqual([false, false, false, true]);
  });
});

describe("caching", () => {
  it("reads a pack from the database ONCE, then serves it from memory", async () => {
    const { registry, repo } = makeRegistry({ packs: { WELDING } });
    await registry.loadPinned("qp_welding", 1, NOW);
    await registry.loadPinned("qp_welding", 1, NOW + 1000);
    expect(repo.findItems).toHaveBeenCalledTimes(1);
  });

  it("re-reads once BOTH tiers have expired", async () => {
    // Both, because they expire on the same clock: the in-process entry lapsing only sends the
    // read to Redis, whose key carries the same TTL. `expire()` is how the fake says the Redis
    // keys have gone too — see `pack-cache.fake.ts`.
    const shared = fakePackCache();
    const { registry, repo } = makeRegistry({ packs: { WELDING }, shared });
    await registry.loadPinned("qp_welding", 1, NOW);
    shared.expire();
    await registry.loadPinned("qp_welding", 1, NOW + 900_001);
    expect(repo.findItems).toHaveBeenCalledTimes(2);
  });

  it("an expired in-process entry is served by the SHARED tier without touching the database", async () => {
    // The tier that makes an expiry cheap. Before this existed, every lapse cost four queries.
    const { registry, repo } = makeRegistry({ packs: { WELDING } });
    await registry.loadPinned("qp_welding", 1, NOW);
    await registry.loadPinned("qp_welding", 1, NOW + 900_001);
    expect(repo.findItems).toHaveBeenCalledTimes(1);
  });

  it("keys on version, so a new version is a new entry and never a stale hit", async () => {
    // Versioning is MOST of the invalidation — but deliberately not all of it, which is why the
    // TTL above still exists. `seed-question-packs.ts` deletes and re-inserts a version's items in
    // place, so re-seeding an edited file rewrites content under an unchanged key; the expiry is
    // what bounds that. See PACK_CACHE_TTL_MS.
    const v1 = { head: head("qp_welding", "fam_welding", 1), items: WELDING.items };
    const v2 = {
      head: head("qp_welding", "fam_welding", 2),
      items: [itemRow({ questionKey: "q_new" })],
    };
    const { registry } = makeRegistry({ packs: { v1, v2 } });
    expect((await registry.loadPinned("qp_welding", 1, NOW))?.items[0]?.question_key).toBe(
      "q_process",
    );
    expect((await registry.loadPinned("qp_welding", 2, NOW))?.items[0]?.question_key).toBe("q_new");
  });

  it("evicts oldest-first once the entry cap is reached", async () => {
    // The TTL alone does not bound the map — an entry is only dropped when it is next READ. A
    // process that resolves many packs and re-reads few would otherwise hold every one of them.
    const packs: Record<string, { head: PackHeadRow; items: PackItemRow[] }> = {};
    for (let v = 1; v <= PACK_CACHE_MAX_ENTRIES + 1; v++) {
      packs[`v${v}`] = {
        head: head("qp_welding", "fam_welding", v),
        items: [itemRow({ questionKey: "q_process" })],
      };
    }
    const shared = fakePackCache();
    const { registry, repo } = makeRegistry({ packs, shared });
    for (let v = 1; v <= PACK_CACHE_MAX_ENTRIES + 1; v++) {
      await registry.loadPinned("qp_welding", v, NOW);
    }
    // The shared tier is emptied so the assertion measures the IN-PROCESS map, which is what the
    // cap governs. Left populated, an evicted entry would simply be re-served from Redis and the
    // eviction would be invisible.
    shared.expire();
    repo.findItems.mockClear();
    // Version 1 was the first in and is therefore the first out; the newest is still resident.
    await registry.loadPinned("qp_welding", 1, NOW);
    await registry.loadPinned("qp_welding", PACK_CACHE_MAX_ENTRIES + 1, NOW);
    expect(repo.findItems).toHaveBeenCalledTimes(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * THE RESOLUTION CACHE — the part of this path that was never cached at all.
 *
 * `load()` has always cached pack CONTENT. What ran uncached on EVERY turn of EVERY interview is
 * the resolution in front of it: `resolvePacks` calls `loadUniversal`, which is
 * `resolveForOccupation(null, …)`, which runs `findBindings` — a SELECT over
 * `profiling_family_binding` with no WHERE clause, filtered in JS — and then `findActivePacks`.
 * Two round trips per turn, one a full table read, to re-derive an answer that changes only when a
 * reviewer publishes a pack.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("the resolution cache", () => {
  const WORLD = {
    bindings: [binding("fam_welding", 50), binding("fam_universal", 0)],
    packs: { WELDING, UNIVERSAL },
  };

  it("walks the chain ONCE across many turns — the whole point of the change", async () => {
    const { registry, repo } = makeRegistry(WORLD);
    for (let turn = 0; turn < 10; turn++) {
      expect((await registry.loadUniversal(NOW + turn))?.pack_id).toBe("qp_universal");
    }
    // ONE, not ten. This is the acceptance criterion for the whole change; if it regresses, the
    // hot path is back to a full-table read per turn.
    expect(repo.findBindings).toHaveBeenCalledTimes(1);
    expect(repo.findActivePacks).toHaveBeenCalledTimes(1);
  });

  it("re-walks once the resolution expires, so a published pack is picked up", async () => {
    // The one thing this cache may NOT do is pin a stale answer forever: which version is `active`
    // is exactly what a reviewer changes.
    const shared = fakePackCache();
    const { registry, repo } = makeRegistry({ ...WORLD, shared });
    await registry.loadUniversal(NOW);
    shared.expire("resolutions");
    await registry.loadUniversal(NOW + PACK_RESOLUTION_TTL_MS + 1);
    expect(repo.findBindings).toHaveBeenCalledTimes(2);
  });

  it("caches an EXHAUSTED chain, so an unauthored trade stops re-reading the table", async () => {
    // Half the corpus is unauthored at any time and those trades walk the whole chain to reach
    // nothing. Collapsing "not cached" into "no pack" would make them the most expensive callers.
    // Bindings EXIST here; no family among them has a loadable pack — the legitimate negative.
    const { registry, repo } = makeRegistry({
      bindings: [binding("fam_welding", 50), binding("fam_universal", 0)],
      packs: {},
    });
    expect(await registry.resolveForOccupation(PIN, NOW)).toBeNull();
    expect(await registry.resolveForOccupation(PIN, NOW + 1)).toBeNull();
    expect(repo.findBindings).toHaveBeenCalledTimes(1);
  });

  it("NEVER caches zero bindings — that is a re-seed in flight, not an answer", async () => {
    // THE OUTAGE THIS PREVENTS. A healthy database always has the `is_universal` binding, so zero
    // rows means unseeded or mid-reseed: `seed-question-packs.ts` runs
    // `db.delete(profilingFamilyBindings)` and re-inserts, OUTSIDE a transaction. Caching that
    // millisecond-wide gap would hold `no_pack` for a full TTL, fleet-wide, for every worker.
    const { registry, repo } = makeRegistry({ bindings: [], packs: {} });
    expect(await registry.loadUniversal(NOW)).toBeNull();
    expect(await registry.loadUniversal(NOW + 1)).toBeNull();
    expect(repo.findBindings).toHaveBeenCalledTimes(2);
  });

  it("zero bindings WARNS with the remedy — the degradation must not be silent", async () => {
    // WHAT SILENCE COST. This branch is the single point every unseeded-database interview passes
    // through, and it returned null without a word. `nextQuestion` then falls through to the
    // universal pack, so the worker answered eight generic questions instead of their trade's and
    // the only symptom was a thin profile — diagnosed, eventually, from screenshots of the chat.
    // The condition is exactly knowable here, so it is stated here.
    const { registry } = makeRegistry({ bindings: [], packs: {} });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    await registry.loadUniversal(NOW);

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("no family bindings");
    // The remedy is IN the log line: an operator reading it must not have to find this file.
    expect(line).toContain("db:seed:packs");
    warn.mockRestore();
  });

  it("promotes a SHARED hit into memory, so only the first turn pays a round trip", async () => {
    // Without this the in-process tier is populated only by the instance that WALKED the chain, so
    // every other instance pays a Redis round trip on every turn — most of the saving, undone one
    // layer down.
    const shared = fakePackCache();
    const warm = makeRegistry({ ...WORLD, shared });
    await warm.registry.loadUniversal(NOW);

    const cold = makeRegistry({ ...WORLD, shared });
    const reads = vi.spyOn(shared.cache, "readResolution");
    await cold.registry.loadUniversal(NOW);
    await cold.registry.loadUniversal(NOW + 1);
    await cold.registry.loadUniversal(NOW + 2);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(cold.repo.findBindings).not.toHaveBeenCalled();
  });

  it("a cached resolution whose pack no longer loads RE-WALKS rather than answering null", async () => {
    // A cache may cost a query; it may never cost an interview. If the pinned version has been
    // deleted or edited into something the contract rejects, the cached answer is simply wrong —
    // and the live chain would have fallen through to the parent family's pack.
    const shared = fakePackCache();
    const warm = makeRegistry({ ...WORLD, shared });
    expect((await warm.registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_welding");

    // The RESOLUTION survives (it is what we are testing) while the cached CONTENT has aged out —
    // the realistic shape, since content and resolution expire on different clocks.
    shared.expire("packs");

    // A second instance, cold in-process, reading that surviving resolution — against a database
    // that has since lost the welding pack entirely.
    const cold = makeRegistry({ bindings: WORLD.bindings, packs: { UNIVERSAL }, shared });
    expect((await cold.registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_universal");
  });
});

describe("the shared tier", () => {
  it("lets a COLD instance skip the database entirely", async () => {
    // A deploy, a restart or a scale-out used to mean every worker mid-interview paid four queries
    // to rebuild a pack another instance already had.
    const shared = fakePackCache();
    const warm = makeRegistry({ packs: { WELDING }, shared });
    await warm.registry.loadPinned("qp_welding", 1, NOW);
    expect(shared.packWrites).toContain("qp_welding:1");

    const cold = makeRegistry({ packs: { WELDING }, shared });
    expect((await cold.registry.loadPinned("qp_welding", 1, NOW))?.pack_id).toBe("qp_welding");
    expect(cold.repo.findItems).not.toHaveBeenCalled();
  });

  it("FAILS OPEN — a Redis outage costs queries, never an interview", async () => {
    // The deliberate opposite of the rate limiters and the spend ledger, which fail closed. Being
    // wrong there permits an unaccounted spend; being wrong here would refuse to serve a worker
    // their questions over a cache outage.
    const shared = fakePackCache();
    shared.fail();
    const { registry, repo } = makeRegistry({ ...WORLD_FOR_OUTAGE, shared });
    expect((await registry.resolveForOccupation(PIN, NOW))?.pack_id).toBe("qp_welding");
    expect(repo.findBindings).toHaveBeenCalled();
  });

  it("only ever publishes a pack that passed validation", async () => {
    // Redis must not become a way to distribute a malformed pack to every instance that has not
    // read the database yet.
    const broken = {
      head: head("qp_broken", "fam_welding"),
      items: [itemRow({ questionKey: "NOT A VALID KEY" })],
    };
    const shared = fakePackCache();
    const { registry } = makeRegistry({ packs: { broken }, shared });
    expect(await registry.loadPinned("qp_broken", 1, NOW)).toBeNull();
    expect(shared.packWrites).toEqual([]);
  });
});

const WORLD_FOR_OUTAGE = {
  bindings: [binding("fam_welding", 50), binding("fam_universal", 0)],
  packs: { WELDING, UNIVERSAL },
};

/* ════════════════════════════════════════════════════════════════════════════
 * R2 — an unseeded database must SAY SO at boot.
 *
 * The packs live in git and reach a database only via `db:seed:packs --apply`. An environment
 * that migrated but never seeded looks completely healthy — `/health` green, process serving —
 * while every worker's first turn resolves no pack and gets the unavailable line, forever. The
 * symptom points at the orchestrator, which is the wrong place to go and look.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("boot-time seeding check", () => {
  /** Capture what reaches the logger without printing it through the suite. */
  function spyLogger() {
    return {
      error: vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
      log: vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined),
    };
  }

  it("logs at ERROR when even the UNIVERSAL pack is missing", async () => {
    const spy = spyLogger();
    try {
      // No bindings at all — exactly what an unseeded `profiling_family_binding` looks like.
      const { registry } = makeRegistry({});
      registry.onModuleInit();
      await vi.waitFor(() => expect(spy.error).toHaveBeenCalled());

      const message = String(spy.error.mock.calls[0]![0]);
      expect(message).toContain("NO UNIVERSAL QUESTION PACK");
      // The message has to carry the FIX, not just the fact. An operator reading this at 2am
      // should not have to find the seed command themselves.
      expect(message).toContain("db:seed:packs --apply");
      // …and the locale, because a mismatch presents identically and is the likelier cause on a
      // database somebody did seed.
      expect(message).toContain("hi-IN");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("logs at LOG, never ERROR, when the packs ARE seeded", async () => {
    const spy = spyLogger();
    try {
      const { registry } = makeRegistry({
        bindings: [binding("fam_universal", 0)],
        packs: { UNIVERSAL },
      });
      registry.onModuleInit();
      await vi.waitFor(() => expect(spy.log).toHaveBeenCalled());

      expect(spy.error).not.toHaveBeenCalled();
      expect(String(spy.log.mock.calls[0]![0])).toContain("qp_universal");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("NEVER throws out of onModuleInit, even when the database is unreachable", async () => {
    // The whole point of ERROR-not-throw. An unseeded or unreachable database must not take down
    // auth, the payer portal and resume rendering with it, and a crash-loop hides the very
    // message this check exists to print.
    const spy = spyLogger();
    try {
      const { registry, repo } = makeRegistry({});
      repo.findBindings = vi.fn(async () => {
        throw new Error("db down");
      });

      expect(() => registry.onModuleInit()).not.toThrow();
      await vi.waitFor(() => expect(spy.error).toHaveBeenCalled());
      expect(String(spy.error.mock.calls[0]![0])).toContain("could not run");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not block boot on a slow database", async () => {
    // Fire-and-forget: `onModuleInit` returns void and must return IMMEDIATELY, or a slow
    // database delays `listen` for every route in the process.
    const spy = spyLogger();
    try {
      const { registry, repo } = makeRegistry({});
      let release!: () => void;
      repo.findBindings = vi.fn(
        () => new Promise((resolve) => (release = () => resolve([]))),
      ) as never;

      registry.onModuleInit(); // returns while the query is still pending
      expect(spy.error).not.toHaveBeenCalled();

      // WAIT FOR THE QUERY TO BE REACHED before releasing it. `resolveForOccupation` now consults
      // the resolution cache first, so `findBindings` is dispatched a microtask later than it used
      // to be and `release` is not yet assigned when this line is reached synchronously. The
      // property under test is unchanged — `onModuleInit` returned above without awaiting
      // anything, which is the assertion two lines up.
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      release();
      await vi.waitFor(() => expect(spy.error).toHaveBeenCalled());
    } finally {
      vi.restoreAllMocks();
    }
  });
});

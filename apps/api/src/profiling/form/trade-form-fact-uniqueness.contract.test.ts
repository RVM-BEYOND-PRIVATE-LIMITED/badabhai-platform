import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

import type { QuestionPack } from "@badabhai/ai-contracts";

import {
  factForPackItem,
  MARKER_OWNED_FACTS,
  type MarkerScreenType,
  type WorkerFactId,
} from "../facts/worker-fact.registry";
import { ENABLED_ROLE_DESCRIPTORS } from "../roles/role-registry";
import { packFromCorpus, rawCorpusPack, UNIVERSAL_PACK_FILE } from "./corpus-pack.test-support";
import type { TradeFormSchemaResponse } from "./trade-form.dto";
import { TradeFormService } from "./trade-form.service";

/**
 * ═══ #1503 — ONE FACT, ASKED ONCE, ON THE PAGE THAT OWNS IT ═══
 *
 * `f455bb36` appended all eight `qp_universal@2` questions to every trade form. Five of them were
 * facts the form ALREADY asked: the tier question is the form's experience ask, and the
 * preferences and qualifications pages served a few screens later own preferred city, shift,
 * salary and education (owner ruling 2026-09-15). A worker answered each twice, and the page's
 * write raced the question's.
 *
 * WHY BOTH SUITES THAT SHOULD HAVE CAUGHT IT DID NOT. Each stubbed `loadUniversal` to `null`, so
 * every assertion ran against a form with nothing appended. This file's double answers EVERY
 * method that can return the universal pack with the REAL one, asserts that it does, and then
 * asserts on the OUTPUT of `schema()` — never on which loader was called — so the append cannot
 * come back through a different door (a `resolveForOccupation(null)`, a pinned load) and stay
 * green.
 *
 * TWO PROPERTIES, and they fail for different regressions:
 *   (a) no served question is a `qp_universal@2` key, read straight from the JSON file rather than
 *       through the loader under test;
 *   (b) no `WorkerFactId` occurs twice across the served question screens and the facts the served
 *       marker pages own — counting SETTLING aliases only, so a yes/no "night work?" hint can never
 *       be mistaken for the shift preference it is only evidence about.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

/** The universal pack as the registry would serve it — parsed and answer-type-aliased. */
const UNIVERSAL: QuestionPack = packFromCorpus(UNIVERSAL_PACK_FILE);
/** Its keys, read off the FILE, so property (a) does not trust the loader it is guarding. */
const UNIVERSAL_KEYS: ReadonlySet<string> = new Set(
  rawCorpusPack(UNIVERSAL_PACK_FILE).items.map((item) => item.question_key),
);

interface RoleCase {
  readonly kind: (typeof ENABLED_ROLE_DESCRIPTORS)[number]["kind"];
  readonly familyId: string;
  readonly pack: QuestionPack;
}

const ROLES: readonly RoleCase[] = ENABLED_ROLE_DESCRIPTORS.map((descriptor) => ({
  kind: descriptor.kind,
  familyId: descriptor.familyId,
  pack: packFromCorpus(descriptor.packId),
}));
const CASES = ROLES.map((role) => [role.kind, role] as const);

/**
 * A pack registry that hands out the universal pack from EVERY door it has.
 *
 * `loadUniversal` is `resolveForOccupation(null)` in production and `loadPinned` can name it too;
 * a double that answered only the first would let a regression through the other two.
 */
function registryFor(role: RoleCase) {
  return {
    loadForFamily: vi.fn(async (familyId: string) =>
      familyId === role.familyId ? role.pack : null,
    ),
    loadUniversal: vi.fn(async () => UNIVERSAL),
    resolveForOccupation: vi.fn(async () => UNIVERSAL),
    loadPinned: vi.fn(async (packId: string) =>
      packId === UNIVERSAL.pack_id ? UNIVERSAL : packId === role.pack.pack_id ? role.pack : null,
    ),
  };
}

function serviceFor(role: RoleCase) {
  const packs = registryFor(role);
  const service = new TradeFormService(
    {
      findLatestSessionByWorker: vi.fn(async () => ({
        id: SESSION,
        conversationState: { form_kind: role.kind },
      })),
    } as never,
    packs as never,
    {
      listAnswers: vi.fn(async () => []),
      // #1459 — the cross-pack tier read. No chat row in this contract fixture, so nothing is
      // derived and the served set is exactly what the #1503 assertions describe.
      findLatestAnswerByQuestionKey: vi.fn(async () => undefined),
      withTransaction: vi.fn(async <T,>(cb: (tx: unknown) => Promise<T>) => cb(undefined)),
      upsertAnswer: vi.fn(async () => undefined),
    } as never,
    { upsertMany: vi.fn(async () => 0) } as never,
    { emit: vi.fn(async () => ({})) } as never,
    { rebuildQuietly: vi.fn(async () => undefined) } as never,
    { forWorker: async () => new Map() } as never,
    { findLatestForWorker: async () => undefined } as never,
    // "TYPED CUSTOM ANSWER, EVERYWHERE" trigger — a spy, since this suite is about pack fact
    // uniqueness, not the review-or-omit path (`trade-form.service.test.ts` covers that).
    { review: vi.fn(async () => null) } as never,
    { WORK_HISTORY_POLISH_ENABLED: false } as never,
    // Safety-net resume refresh (no resume row here → never fires) + render queue.
    // Present so the constructor arity matches; this suite asserts uniqueness, not the refresh.
    { latestResume: vi.fn(async () => undefined) } as never,
    { add: vi.fn(async () => ({})) } as never,
  );
  return { service, packs };
}

type Screen = TradeFormSchemaResponse["sections"][number]["screens"][number];

const MARKER_TYPES: ReadonlySet<string> = new Set(Object.keys(MARKER_OWNED_FACTS));
const isMarker = (screen: Screen): screen is Extract<Screen, { type: MarkerScreenType }> =>
  MARKER_TYPES.has(screen.type);

describe("#1503 — a trade form asks each worker fact once", () => {
  it("covers all fourteen enabled roles, so every parametrised case below is evidence", () => {
    // `it.each` over an empty table passes silently.
    expect(ROLES).toHaveLength(14);
  });

  it("VACUITY — the double really serves the eight-item universal pack from every door", async () => {
    // Without this, property (a) could be green because the double served nothing to append.
    const packs = registryFor(ROLES[0]!);
    expect(UNIVERSAL_KEYS.size).toBe(8);
    expect((await packs.loadUniversal())?.items).toHaveLength(8);
    expect((await packs.resolveForOccupation())?.items).toHaveLength(8);
    expect((await packs.loadPinned(UNIVERSAL.pack_id))?.items).toHaveLength(8);
    // And no role pack already defines a universal key — `f455bb36` filtered collisions out, so a
    // role that did would have hidden its own share of the append.
    for (const role of ROLES) {
      const overlap = role.pack.items.filter((item) => UNIVERSAL_KEYS.has(item.question_key));
      expect(overlap.map((item) => item.question_key), `${role.kind}`).toEqual([]);
    }
  });

  it.each(CASES)("%s — (a) serves no qp_universal@2 question", async (_kind, role) => {
    const { service } = serviceFor(role);
    const schema = await service.schema(WORKER);
    const served = schema.sections
      .flatMap((section) => section.screens)
      .flatMap((screen) => (screen.type === "question" ? [screen.question.question_key] : []));

    expect(served.length, `${role.kind}: served no questions at all`).toBeGreaterThan(0);
    expect(served.filter((key) => UNIVERSAL_KEYS.has(key))).toEqual([]);
    // The positive half: every question is the role's own.
    const own = new Set(role.pack.items.map((item) => item.question_key));
    expect(served.filter((key) => !own.has(key))).toEqual([]);
  });

  it.each(CASES)(
    "%s — (b) no worker fact occurs twice across question screens and marker pages",
    async (_kind, role) => {
      const { service } = serviceFor(role);
      const schema = await service.schema(WORKER);
      const screens = schema.sections.flatMap((section) => section.screens);

      // Every served item, from whichever pack defines its key — so an appended universal item
      // resolves to its fact rather than silently to nothing.
      const itemFor = (key: string) =>
        role.pack.items.find((item) => item.question_key === key) ??
        UNIVERSAL.items.find((item) => item.question_key === key);

      const occurrences = new Map<WorkerFactId, string[]>();
      const record = (fact: WorkerFactId, where: string) =>
        occurrences.set(fact, [...(occurrences.get(fact) ?? []), where]);

      for (const screen of screens) {
        if (screen.type === "question") {
          const item = itemFor(screen.question.question_key);
          expect(item, `${role.kind}: served an unknown key`).toBeDefined();
          const match = factForPackItem(item!);
          if (match?.strength === "settles") record(match.fact, `question:${item!.question_key}`);
        } else if (isMarker(screen)) {
          for (const fact of MARKER_OWNED_FACTS[screen.type]) record(fact, `marker:${screen.type}`);
        }
      }

      // Not vacuous: the tier question and the three markers always contribute.
      expect(occurrences.get("experience"), `${role.kind}: no experience ask`).toBeDefined();
      expect(occurrences.get("shift"), `${role.kind}: no preferences marker`).toBeDefined();

      const duplicated = Object.fromEntries(
        [...occurrences.entries()].filter(([, where]) => where.length > 1),
      );
      expect(duplicated, `${role.kind}: a fact is asked more than once`).toEqual({});
    },
  );
});

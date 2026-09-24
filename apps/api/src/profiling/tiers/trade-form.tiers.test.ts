import "reflect-metadata";
import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { QuestionPack } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer, WorkerProfilingTier } from "@badabhai/db";
import type { ProfilingTier } from "@badabhai/types";

import { packFromCorpus, rawCorpusPack } from "../form/corpus-pack.test-support";
import { TradeFormService } from "../form/trade-form.service";
import { ProfilingTierService } from "./profiling-tier.service";
import type { ItemTierMap } from "./profiling-tier.policy";

/**
 * ═══ TIERED PROFILING THROUGH THE REAL FORM ═══
 *
 * `TradeFormService` + the real `ProfilingTierService`, over the REAL turner pack and its REAL
 * tags; only the database is faked. What these pin is what a worker sees: the questions a tier
 * asks, that an upgrade never re-asks an answer, that a tier is never lowered, and that with the
 * flag off the form is exactly today's.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const TURNER: QuestionPack = packFromCorpus("qp_cnc_turning");

const TAGS: ItemTierMap = new Map(
  (
    rawCorpusPack("qp_cnc_turning") as unknown as {
      items: { question_key: string; min_tier: ProfilingTier }[];
    }
  ).items.map((item) => [item.question_key, item.min_tier]),
);

function answered(questionKey: string, over: Partial<WorkerPackAnswer> = {}): WorkerPackAnswer {
  return {
    questionKey,
    status: "answered",
    answerOptionKeys: ["x"],
    answerText: null,
    answerNumber: null,
    answerBool: null,
    ...over,
  } as WorkerPackAnswer;
}

function build(
  opts: {
    enabled?: boolean;
    row?: Partial<WorkerProfilingTier> | null;
    saved?: WorkerPackAnswer[];
    /** Null = the form came from a résumé import, not an interview. */
    sessionId?: string | null;
    /** The chat's `experience_years` — pre-settles the tier gate (#1459). Default 10 (senior). */
    chatYears?: number;
    /** The pack's tags as the DATABASE holds them. Default: the corpus tags (a seeded pack). */
    tags?: ItemTierMap;
  } = {},
) {
  let row: WorkerProfilingTier | null =
    opts.row === undefined || opts.row === null ? null : ({ ...opts.row } as WorkerProfilingTier);
  const repo = {
    findForWorker: vi.fn(async () => row),
    findItemTiers: vi.fn(async () => opts.tags ?? TAGS),
    insertSelected: vi.fn(
      async (input: { tier: ProfilingTier; at: Date; chatSessionId: string | null }) => {
        if (row) return { row, inserted: false };
        row = {
          workerId: WORKER,
          tier: input.tier,
          source: "selected",
          upgradedFrom: null,
          formKind: "cnc_turner",
          chatSessionId: input.chatSessionId,
          selectedAt: input.at,
          createdAt: input.at,
          updatedAt: input.at,
        };
        return { row, inserted: true };
      },
    ),
    upgrade: vi.fn(async (input: { from: ProfilingTier; to: ProfilingTier; at: Date }) => {
      if (!row || row.tier !== input.from) return null;
      row = { ...row, tier: input.to, upgradedFrom: input.from, selectedAt: input.at };
      return row;
    }),
  };
  const emitted: { event_name: string; payload: Record<string, unknown> }[] = [];
  const events = {
    emit: vi.fn(async (params: { event_name: string; payload: Record<string, unknown> }) => {
      emitted.push(params);
      return {};
    }),
  };
  const tiers = new ProfilingTierService(repo as never, events as never, {
    PROFILING_TIERS_ENABLED: opts.enabled ?? true,
  });

  let saved = opts.saved ?? [];
  const sessionId = opts.sessionId === undefined ? SESSION : opts.sessionId;
  const service = new TradeFormService(
    {
      findLatestSessionByWorker: async () =>
        sessionId === null
          ? undefined
          : { id: sessionId, conversationState: { form_kind: "cnc_turner" } },
    } as never,
    { loadForFamily: async () => TURNER, loadUniversal: async () => null } as never,
    {
      listAnswers: async () => saved,
      findLatestAnswerByQuestionKey: async () =>
        ({ status: "answered", answerNumber: opts.chatYears ?? 10 }) as unknown as WorkerPackAnswer,
      withTransaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb(undefined),
      upsertAnswer: async (r: { questionKey: string; status: string }) => {
        saved = [
          ...saved.filter((s) => s.questionKey !== r.questionKey),
          answered(r.questionKey, r as never),
        ];
      },
    } as never,
    { upsertMany: async () => 0 } as never,
    events as never,
    { rebuildQuietly: async () => undefined } as never,
    { forWorker: async () => new Map() } as never,
    {
      findLatestForWorker: async () =>
        sessionId === null ? { route: "form", formKind: "cnc_turner" } : undefined,
    } as never,
    { review: async () => null } as never,
    { WORK_HISTORY_POLISH_ENABLED: false } as never,
    { latestResume: async () => undefined } as never,
    { add: async () => ({}) } as never,
    tiers,
  );
  return { service, repo, emitted, getRow: () => row };
}

type Schema = Awaited<ReturnType<TradeFormService["schema"]>>;
const askedKeys = (schema: Schema) =>
  schema.sections.flatMap((s) =>
    s.screens.flatMap((screen) =>
      screen.type === "question" ? [screen.question.question_key] : [],
    ),
  );
const pages = (schema: Schema) =>
  schema.sections.flatMap((s) => s.screens.filter((screen) => screen.type !== "question"));

describe("the form at a tier", () => {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  it("asks an Easy turner only machines and controllers (the gate is pre-settled from the chat)", async () => {
    const { service } = build({ row: { tier: "easy" } });
    const schema = await service.schema(WORKER);
    expect(askedKeys(schema)).toEqual(["turning_machine", "controller_brand"]);
    expect(schema.profiling_tier).toBe("easy");
  });

  it("asks a Medium turner the calibration's Medium rows too, and nothing Hard", async () => {
    const { service } = build({ row: { tier: "medium" } });
    const asked = askedKeys(await service.schema(WORKER));
    expect(asked).toEqual(
      expect.arrayContaining([
        "material_worked",
        "measuring_tools",
        "programming_level",
        "drawing_reading",
      ]),
    );
    for (const hard of [
      "workholding",
      "setting_operation",
      "tolerance_band",
      "advanced_capability",
    ]) {
      expect(asked).not.toContain(hard);
    }
  });

  it("asks a Hard turner exactly what the flag-off form asks", async () => {
    const hard = await build({ row: { tier: "hard" } }).service.schema(WORKER);
    const off = await build({ enabled: false }).service.schema(WORKER);
    expect(askedKeys(hard)).toEqual(askedKeys(off));
  });

  it("with the flag off, serves today's form byte-for-byte and never touches the tier table", async () => {
    const { service, repo } = build({ enabled: false });
    const schema = await service.schema(WORKER);
    expect(schema).not.toHaveProperty("profiling_tier");
    for (const page of pages(schema)) expect(page).not.toHaveProperty("tier_scope");
    expect(repo.findForWorker).not.toHaveBeenCalled();
    expect(repo.findItemTiers).not.toHaveBeenCalled();
  });

  it("scopes the shared pages at Easy: asks no further jobs, descriptions, documents or certificates", async () => {
    const schema = await build({ row: { tier: "easy" } }).service.schema(WORKER);
    const byType = Object.fromEntries(pages(schema).map((p) => [p.type, p]));
    expect(byType.preferences).toMatchObject({
      tier_scope: { hidden_fields: ["documents_ready"] },
    });
    expect(byType.employment).toEqual({
      type: "employment",
      endpoint: "PUT /workers/me/employment",
      // ASK-ONLY, and no list cap: a whole-list PUT must round-trip every stored job.
      tier_scope: { hidden_fields: ["work_done", "additional_entries"] },
    });
    expect(byType.qualifications).toMatchObject({
      tier_scope: { hidden_fields: ["certificates", "trainings"] },
    });
  });

  it("titles the Easy capability section as the approved Easy sheet does", async () => {
    const schema = await build({ row: { tier: "easy" } }).service.schema(WORKER);
    expect(schema.sections.find((s) => s.id === "capability")?.title).toBe(
      "Machines & controllers",
    );
  });
});

describe("upgrading", () => {
  it("serves ONLY unanswered questions in the new range — an answered one is never re-asked", async () => {
    const { service } = build({
      row: { tier: "medium", upgradedFrom: "easy" },
      saved: [
        answered("turning_machine"),
        answered("controller_brand"),
        answered("material_worked"),
      ],
    });
    const asked = askedKeys(await service.schema(WORKER, "upgrade"));
    expect(asked).not.toContain("turning_machine");
    expect(asked).not.toContain("controller_brand");
    expect(asked).not.toContain("material_worked");
    expect(asked).toEqual(
      expect.arrayContaining(["measuring_tools", "programming_level", "drawing_reading"]),
    );
  });

  it("re-serves each page naming ONLY the fields the upgrade adds (reveal_fields), never the whole page", async () => {
    const schema = await build({ row: { tier: "medium", upgradedFrom: "easy" } }).service.schema(
      WORKER,
      "upgrade",
    );
    const byType = Object.fromEntries(pages(schema).map((p) => [p.type, p]));
    expect(byType.preferences).toMatchObject({
      tier_scope: { hidden_fields: [], reveal_fields: ["documents_ready"] },
    });
    expect(byType.employment).toMatchObject({
      tier_scope: { hidden_fields: [], reveal_fields: ["work_done", "additional_entries"] },
    });
    expect(byType.qualifications).toMatchObject({
      tier_scope: { hidden_fields: [], reveal_fields: ["certificates", "trainings"] },
    });
  });

  it("a TWO-STEP upgrade (Easy → Medium abandoned → Hard) still offers every page field Easy skipped", async () => {
    const schema = await build({
      row: { tier: "hard", upgradedFrom: "medium" },
    }).service.schema(WORKER, "upgrade");
    expect(pages(schema).map((p) => p.type)).toEqual([
      "preferences",
      "employment",
      "qualifications",
    ]);
    for (const page of pages(schema)) {
      expect(
        (page as { tier_scope?: { reveal_fields?: string[] } }).tier_scope?.reveal_fields?.length,
      ).toBeGreaterThan(0);
    }
  });

  it("with the flag off, ?view=upgrade is today's full form", async () => {
    const off = build({ enabled: false, saved: [answered("turning_machine")] }).service;
    const upgrade = await off.schema(WORKER, "upgrade");
    const full = await off.schema(WORKER, "full");
    expect(upgrade).toEqual(full);
    expect(askedKeys(upgrade)).toContain("turning_machine");
  });

  it("a DECLINED answer is settled too, and is not re-asked", async () => {
    const { service } = build({
      row: { tier: "hard", upgradedFrom: "medium" },
      saved: [answered("workholding", { status: "declined" } as never)],
    });
    expect(askedKeys(await service.schema(WORKER, "upgrade"))).not.toContain("workholding");
  });
});

describe("choosing a tier", () => {
  it("shows the screen to a fresh Chat-path worker, with every tier's estimate", async () => {
    const { service, emitted } = build();
    const state = await service.tierState(WORKER);
    expect(state).toMatchObject({ enabled: true, needs_choice: true, current_tier: null });
    expect(state.tiers.map((t) => t.tier)).toEqual(["easy", "medium", "hard"]);
    expect(emitted.map((e) => e.event_name)).toEqual(["profile.tier_screen_shown"]);
  });

  it("does NOT show it on the upload path, or to a worker who started the form before tiers", async () => {
    const upload = await build({ sessionId: null }).service.tierState(WORKER);
    expect(upload).toMatchObject({ needs_choice: false, current_tier: "hard" });
    const started = await build({ saved: [answered("turning_machine")] }).service.tierState(WORKER);
    expect(started).toMatchObject({ needs_choice: false, current_tier: "hard" });
  });

  it("records the first choice once, and a retried tap is unchanged with no second event", async () => {
    const { service, emitted, getRow } = build();
    expect(await service.chooseTier(WORKER, "easy")).toEqual({
      tier: "easy",
      previous_tier: null,
      change: "selected",
    });
    expect(await service.chooseTier(WORKER, "easy")).toEqual({
      tier: "easy",
      previous_tier: "easy",
      change: "unchanged",
    });
    expect(getRow()?.tier).toBe("easy");
    expect(emitted.filter((e) => e.event_name === "profile.tier_selected")).toHaveLength(1);
  });

  it("raises a tier and says so", async () => {
    const { service, emitted, getRow } = build({ row: { tier: "easy" } });
    expect(await service.chooseTier(WORKER, "hard")).toEqual({
      tier: "hard",
      previous_tier: "easy",
      change: "upgraded",
    });
    expect(getRow()).toMatchObject({ tier: "hard", upgradedFrom: "easy" });
    expect(emitted.at(-1)).toMatchObject({
      event_name: "profile.tier_upgraded",
      payload: { from_tier: "easy", to_tier: "hard" },
    });
  });

  it("NEVER lowers a tier — a downgrade is a 409 and the row is untouched", async () => {
    const { service, getRow } = build({ row: { tier: "medium" } });
    await expect(service.chooseTier(WORKER, "easy")).rejects.toBeInstanceOf(ConflictException);
    expect(getRow()?.tier).toBe("medium");
  });

  it("a pre-tier (Hard) worker cannot be lowered either", async () => {
    const { service } = build({ sessionId: null });
    await expect(service.chooseTier(WORKER, "easy")).rejects.toBeInstanceOf(ConflictException);
    expect(await service.chooseTier(WORKER, "hard")).toMatchObject({ change: "unchanged" });
  });

  it("is a 404 while tiers are off", async () => {
    const { service } = build({ enabled: false });
    await expect(service.chooseTier(WORKER, "easy")).rejects.toBeInstanceOf(NotFoundException);
    expect(await service.tierState(WORKER)).toMatchObject({ enabled: false, tiers: [] });
  });
});

describe("finishing at a tier", () => {
  it("emits profile.tier_completed with the tier, the question count and the duration", async () => {
    const selectedAt = new Date(Date.now() - 150_000);
    const { service, emitted } = build({
      row: { tier: "easy", selectedAt },
      saved: [answered("turning_machine")],
    });
    await service.answer(WORKER, {
      question_key: "controller_brand",
      answer: { kind: "declined" },
    });
    const completed = emitted.find((e) => e.event_name === "profile.tier_completed");
    expect(completed?.payload).toMatchObject({
      tier: "easy",
      question_count: 2,
      form_kind: "cnc_turner",
    });
    expect(completed?.payload.duration_ms as number).toBeGreaterThanOrEqual(150_000);
    // The per-(worker, pack) funnel event still fires exactly as before.
    expect(emitted.some((e) => e.event_name === "profile.form_completed")).toBe(true);
  });
});

describe("a pack not yet re-seeded (every tag NULL in the database)", () => {
  const UNSEEDED: ItemTierMap = new Map([...TAGS.keys()].map((key) => [key, null]));

  it("turns tiers OFF for that form rather than serving an empty Easy tier", async () => {
    const { service } = build({ row: { tier: "easy" }, tags: UNSEEDED });
    const schema = await service.schema(WORKER);
    expect(schema).not.toHaveProperty("profiling_tier");
    expect(askedKeys(schema)).toContain("turning_machine");
    expect(await service.tierState(WORKER)).toMatchObject({ enabled: false, needs_choice: false });
  });

  it("refuses a tier choice for it", async () => {
    const { service } = build({ tags: UNSEEDED });
    await expect(service.chooseTier(WORKER, "easy")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("an upgrade onto a tier the worker has already finished", () => {
  it("records the tier completion at once — no answer will ever be posted to fire it", async () => {
    const mediumKeys = [...TAGS.entries()]
      .filter(([, tier]) => tier !== "hard")
      .map(([key]) => key);
    const { service, emitted } = build({
      row: { tier: "easy", selectedAt: new Date() },
      saved: mediumKeys.map((key) => answered(key)),
    });
    expect(await service.chooseTier(WORKER, "medium")).toMatchObject({ change: "upgraded" });
    expect(emitted.find((e) => e.event_name === "profile.tier_completed")?.payload).toMatchObject({
      tier: "medium",
    });
  });
});

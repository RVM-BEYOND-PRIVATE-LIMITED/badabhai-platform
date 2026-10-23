import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { tradeResumeMapFor } from "../resume/trade-resume-map";
import { packFromCorpus } from "./form/corpus-pack.test-support";
import { encodeOtherAnswerReview, readOtherAnswerReview } from "./other-answer-review-record";
import {
  MAX_OTHER_ANSWER_REVIEWS_PER_RENDER,
  OtherAnswerPolishService,
} from "./other-answer-polish.service";

/**
 * ═══ #2409 — A TYPED "KOI AUR" ANSWER, REVIEWED AGAINST THE TRADE AND THE FIELD ═══
 *
 * Driven on the REAL turner pack, so the field label and the examples the review is handed are the
 * shipped ones: the trade from the role descriptor, the field from the résumé row the question
 * prints in, the pack's options (never its escapes) as examples.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "c1", requestId: "r1" };
const ON = { WORK_HISTORY_POLISH_ENABLED: true };
const PACK: QuestionPack = packFromCorpus("qp_cnc_turning");
const MACHINE: QuestionPackItem = PACK.items.find((i) => i.question_key === "turning_machine")!;
const MACHINE_ROW = tradeResumeMapFor("qp_cnc_turning")!.capability.find(
  (row) => row.from === "turning_machine",
)!;
/** A question on the pack the turner's résumé map has no row for, so its answer never prints. */
const UNPRINTED: QuestionPackItem = PACK.items.find(
  (i) =>
    (i.answer_type === "multi_select" || i.answer_type === "single_select") &&
    !tradeResumeMapFor("qp_cnc_turning")!.capability.some((row) => row.from === i.question_key),
)!;

const TARGET = {
  workerId: WORKER,
  packId: "qp_cnc_turning",
  packVersion: PACK.version,
  item: MACHINE,
  ownText: "batliboi lath",
};
const FRESH = { polished: null, declined: false };

function makeService(
  overrides: {
    review?: ReturnType<typeof vi.fn>;
    save?: ReturnType<typeof vi.fn>;
    rows?: WorkerPackAnswer[];
    listThrows?: boolean;
  } = {},
) {
  const ai = {
    reviewOtherAnswer:
      overrides.review ??
      vi.fn(async () => ({
        items: ["Batliboi lathe"],
        reviewed: true,
        blocked: false,
        is_mock: false,
        ai_metadata: null,
      })),
  };
  const repo = {
    savePolishedOtherAnswer: overrides.save ?? vi.fn(async (..._args: unknown[]) => true),
    listAnswers: vi.fn(async () => {
      if (overrides.listThrows) throw new Error("db down");
      return overrides.rows ?? [];
    }),
  };
  const aiCost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const emitted: { event_name: string; payload: Record<string, unknown> }[] = [];
  const events = {
    emit: vi.fn(async (e: { event_name: string; payload: Record<string, unknown> }) => {
      emitted.push(e);
      return {};
    }),
  };
  const packs = { loadPinned: vi.fn(async () => PACK) };
  const service = new OtherAnswerPolishService(
    ai as never,
    repo as never,
    aiCost as never,
    events as never,
    packs as never,
  );
  return { service, ai, repo, aiCost, events, emitted, packs };
}

const row = (over: Partial<WorkerPackAnswer>): WorkerPackAnswer =>
  ({
    workerId: WORKER,
    packId: "qp_cnc_turning",
    packVersion: PACK.version,
    questionKey: "turning_machine",
    status: "answered",
    answerOtherText: "batliboi lath",
    answerOtherTextPolished: null,
    answerOtherTextPolishedDeclined: false,
    ...over,
  }) as WorkerPackAnswer;

describe("the stored record", () => {
  it("round-trips a settled review, including 'nothing prints'", () => {
    expect(
      readOtherAnswerReview(
        encodeOtherAnswerReview(["Batliboi lathe"], "batliboi lath"),
        "batliboi lath",
      ),
    ).toEqual(["Batliboi lathe"]);
    expect(
      readOtherAnswerReview(encodeOtherAnswerReview([], "batliboi lath"), "batliboi lath"),
    ).toEqual([]);
  });

  it("a record of DIFFERENT words is not a review of these", () => {
    const record = encodeOtherAnswerReview(["Batliboi lathe"], "batliboi lath");
    expect(readOtherAnswerReview(record, "haas")).toBeNull();
  });

  it("reads a pre-#2409 rewrite, or anything else, as NOT reviewed", () => {
    for (const legacy of ["Batliboi lathe (rewired)", '{"items":["x"]}', "", null, undefined]) {
      expect(readOtherAnswerReview(legacy, "batliboi lath")).toBeNull();
    }
  });
});

describe("OtherAnswerPolishService.review", () => {
  it("hands the review the two deciding inputs: the trade and the field, with the pack's options", async () => {
    const { service, ai } = makeService();
    await service.review(TARGET, CTX, ON, FRESH);
    const input = ai.reviewOtherAnswer.mock.calls[0]![0];
    expect(input).toMatchObject({
      text: "batliboi lath",
      trade_label: "CNC Turner",
      field_label: MACHINE_ROW.label,
      question_text: MACHINE.prompt_text,
    });
    // Examples of the FIELD: the real options, never the "Koi aur machine" escape.
    const realOptions = MACHINE.options.filter((o) => !o.is_none_of_above).map((o) => o.label_text);
    expect(input.example_options).toEqual(realOptions);
    expect(input.example_options).not.toContain("Koi aur machine");
  });

  it("stores the settled names against the exact text reviewed, emits 'accepted', and returns them", async () => {
    const { service, repo, emitted, aiCost } = makeService();
    expect(await service.review(TARGET, CTX, ON, FRESH)).toEqual(["Batliboi lathe"]);
    expect(repo.savePolishedOtherAnswer).toHaveBeenCalledWith(
      WORKER,
      "qp_cnc_turning",
      "turning_machine",
      encodeOtherAnswerReview(["Batliboi lathe"], "batliboi lath"),
      "batliboi lath",
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        event_name: "profile.other_answer_reviewed",
        payload: {
          worker_id: WORKER,
          pack_id: "qp_cnc_turning",
          pack_version: PACK.version,
          question_key: "turning_machine",
          outcome: "accepted",
          item_count: 1,
        },
      }),
    ]);
    expect(aiCost.record.mock.calls[0]![1]).toBe("work_history_polish");
  });

  it("stores a settled 'nothing prints' too, so the same text is never reviewed twice", async () => {
    const review = vi.fn(async () => ({ items: [], reviewed: true, ai_metadata: null }));
    const { service, repo, emitted } = makeService({ review });
    expect(await service.review(TARGET, CTX, ON, FRESH)).toEqual([]);
    expect(repo.savePolishedOtherAnswer.mock.calls[0]![3]).toBe(
      encodeOtherAnswerReview([], "batliboi lath"),
    );
    expect(emitted[0]!.payload).toMatchObject({ outcome: "rejected", item_count: 0 });
  });

  it.each([
    ["a mock posture or deadline", { items: [], reviewed: false, ai_metadata: null }],
    ["an unreachable service", null],
  ])("%s is no decision: nothing stored, nothing emitted, nothing printed", async (_, reply) => {
    const { service, repo, emitted } = makeService({ review: vi.fn(async () => reply) });
    expect(await service.review(TARGET, CTX, ON, FRESH)).toBeNull();
    expect(repo.savePolishedOtherAnswer).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("never throws when the call itself throws", async () => {
    const review = vi.fn(async () => {
      throw new Error("boom");
    });
    const { service } = makeService({ review });
    await expect(service.review(TARGET, CTX, ON, FRESH)).resolves.toBeNull();
  });

  it("emits nothing when the review could not be stored (he changed his answer mid-flight)", async () => {
    const { service, emitted } = makeService({ save: vi.fn(async (..._args: unknown[]) => false) });
    expect(await service.review(TARGET, CTX, ON, FRESH)).toEqual(["Batliboi lathe"]);
    expect(emitted).toEqual([]);
  });

  it("a failed write-back does not cost the caller its settled answer", async () => {
    const save = vi.fn(async () => {
      throw new Error("db down");
    });
    const { service } = makeService({ save });
    expect(await service.review(TARGET, CTX, ON, FRESH)).toEqual(["Batliboi lathe"]);
  });

  it("the API lock off: no call and nothing prints", async () => {
    const { service, ai } = makeService();
    expect(
      await service.review(TARGET, CTX, { WORK_HISTORY_POLISH_ENABLED: false }, FRESH),
    ).toBeNull();
    expect(ai.reviewOtherAnswer).not.toHaveBeenCalled();
  });

  it("the worker's refusal short-circuits before any call", async () => {
    const { service, ai } = makeService();
    expect(await service.review(TARGET, CTX, ON, { polished: null, declined: true })).toBeNull();
    expect(ai.reviewOtherAnswer).not.toHaveBeenCalled();
  });

  it("a stored v1 review is returned without a second call", async () => {
    const { service, ai } = makeService();
    const already = {
      polished: encodeOtherAnswerReview(["Haas"], "batliboi lath"),
      declined: false,
    };
    expect(await service.review(TARGET, CTX, ON, already)).toEqual(["Haas"]);
    expect(ai.reviewOtherAnswer).not.toHaveBeenCalled();
  });

  it("a pre-#2409 rewrite is reviewed again, never printed", async () => {
    const { service, ai } = makeService();
    const legacy = { polished: "Batliboi lathe (rewired)", declined: false };
    expect(await service.review(TARGET, CTX, ON, legacy)).toEqual(["Batliboi lathe"]);
    expect(ai.reviewOtherAnswer).toHaveBeenCalledOnce();
  });

  it("an answer to a question the résumé never prints is never reviewed", async () => {
    expect(UNPRINTED).toBeDefined();
    const { service, ai } = makeService();
    expect(await service.review({ ...TARGET, item: UNPRINTED }, CTX, ON, FRESH)).toBeNull();
    expect(ai.reviewOtherAnswer).not.toHaveBeenCalled();
  });

  it("a pack with no role descriptor has no trade to judge against, so nothing is reviewed", async () => {
    const { service, ai } = makeService();
    expect(await service.review({ ...TARGET, packId: "qp_unknown" }, CTX, ON, FRESH)).toBeNull();
    expect(ai.reviewOtherAnswer).not.toHaveBeenCalled();
  });
});

describe("OtherAnswerPolishService.reviewedForResume", () => {
  it("returns stored reviews as they are and reviews what has none", async () => {
    const { service, ai } = makeService({
      rows: [
        row({ questionKey: "turning_machine" }),
        row({
          questionKey: "controller_brand",
          answerOtherText: "siemns",
          answerOtherTextPolished: encodeOtherAnswerReview(["Siemens"], "siemns"),
        }),
      ],
    });
    expect(await service.reviewedForResume(WORKER, "qp_cnc_turning", CTX, ON)).toEqual({
      turning_machine: ["Batliboi lathe"],
      controller_brand: ["Siemens"],
    });
    expect(ai.reviewOtherAnswer).toHaveBeenCalledOnce();
  });

  it("includes a settled 'nothing prints' as [] so a stale ticked row does not print instead", async () => {
    const { service } = makeService({
      rows: [row({ answerOtherTextPolished: encodeOtherAnswerReview([], "batliboi lath") })],
    });
    expect(await service.reviewedForResume(WORKER, "qp_cnc_turning", CTX, ON)).toEqual({
      turning_machine: [],
    });
  });

  it("leaves out a refused, a declined-status or a ticked answer", async () => {
    const { service, ai } = makeService({
      rows: [
        row({ answerOtherTextPolishedDeclined: true }),
        row({ questionKey: "controller_brand", status: "declined" }),
        row({ questionKey: "tolerance_band", answerOtherText: null }),
      ],
    });
    expect(await service.reviewedForResume(WORKER, "qp_cnc_turning", CTX, ON)).toEqual({});
    expect(ai.reviewOtherAnswer).not.toHaveBeenCalled();
  });

  it(`starts at most ${MAX_OTHER_ANSWER_REVIEWS_PER_RENDER} reviews in one render`, async () => {
    const rows = Array.from({ length: MAX_OTHER_ANSWER_REVIEWS_PER_RENDER + 3 }, () =>
      row({ questionKey: "turning_machine" }),
    );
    const { service, ai } = makeService({ rows });
    await service.reviewedForResume(WORKER, "qp_cnc_turning", CTX, ON);
    expect(ai.reviewOtherAnswer).toHaveBeenCalledTimes(MAX_OTHER_ANSWER_REVIEWS_PER_RENDER);
  });

  it("the API lock off: even a stored review does not print", async () => {
    const { service, repo } = makeService({
      rows: [row({ answerOtherTextPolished: encodeOtherAnswerReview(["Haas"], "batliboi lath") })],
    });
    expect(
      await service.reviewedForResume(WORKER, "qp_cnc_turning", CTX, {
        WORK_HISTORY_POLISH_ENABLED: false,
      }),
    ).toEqual({});
    expect(repo.listAnswers).not.toHaveBeenCalled();
  });

  it("a pack with no résumé map, or a failed read, renders without them and never throws", async () => {
    expect(await makeService().service.reviewedForResume(WORKER, null, CTX, ON)).toEqual({});
    expect(await makeService().service.reviewedForResume(WORKER, "qp_unknown", CTX, ON)).toEqual(
      {},
    );
    const failing = makeService({ listThrows: true });
    await expect(
      failing.service.reviewedForResume(WORKER, "qp_cnc_turning", CTX, ON),
    ).resolves.toEqual({});
  });
});

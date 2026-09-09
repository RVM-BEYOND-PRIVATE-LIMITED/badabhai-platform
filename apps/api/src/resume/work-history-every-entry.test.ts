import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { buildEmploymentBlock, type WorkerEmploymentRecord } from "./resume-employment-rows";
import { buildFresherRows, ITI_PROJECT_WORK_KEY } from "./resume-fresher-rows";
import { WorkHistoryPolishService } from "./work-history-polish.service";

/**
 * ═══ EVERY ENTRY, AND EVERY DETAIL OF IT (owner report, 2026-09-09) ═══
 *
 * A worker with two employers was shown a resume where ONE line had been rewritten into
 * professional English and the other printed his raw Hinglish — same page, same render. A second
 * report, from a FRESHER's sheet, showed the whole of Zone 4 reading
 * "CNC lathe / turning centre · Trade test passed · kuch nhi banaya, bas knowledge he mujhe".
 *
 * THE DEFECT WAS INVISIBLE TO THE SUITE, and that is the part worth fixing first. Every polish
 * assertion in this codebase was written against a fixture with ONE employment holding ONE role,
 * and read `out[0].roles[0]`. A polisher that stopped after its first success, skipped every
 * entry but one, or dropped the second half of a two-part line was green on all of them.
 *
 * So these tests are deliberately shaped around PLURALITY: more than one employment, more than
 * one stint, and the case where the first call fails and a later one succeeds — which is what the
 * screenshot actually showed and what no fixture here could previously express.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "c1", requestId: "r1" };
const ON = { WORK_HISTORY_POLISH_ENABLED: true } as never;
const OFF = { WORK_HISTORY_POLISH_ENABLED: false } as never;

/** One employment, one stint, with the ids the polisher writes its results back against. */
function employment(
  id: string,
  workDone: string,
  over: Partial<{ polished: string | null; declined: boolean }> = {},
): WorkerEmploymentRecord {
  return {
    id: `emp-${id}`,
    employer: `Employer ${id}`,
    employerCity: "Pune",
    employerState: "Maharashtra",
    startYm: "2021-05",
    endYm: "2023-04",
    durationStated: true,
    roles: [
      {
        id: `role-${id}`,
        roleLabel: "CNC Turner",
        startYm: null,
        endYm: null,
        workDone,
        workDonePolished: over.polished ?? null,
        workDonePolishDeclined: over.declined ?? false,
      },
    ],
  } as WorkerEmploymentRecord;
}

/**
 * A polisher whose answer depends on WHAT IT WAS ASKED, not on a constant.
 *
 * The existing helpers return the same value for every call, which makes "the first stint failed
 * and the second succeeded" — the reported symptom — literally inexpressible. `byInput` maps the
 * worker's own sentence to the rewrite it should get, and `null` means that one call declines.
 */
function setup(byInput: Readonly<Record<string, string | null>>) {
  const polishWorkHistory = vi.fn(async (input: Record<string, unknown>) => ({
    work_done: byInput[input.work_done as string] ?? null,
    blocked: false,
    is_mock: false,
    ai_metadata: null,
  }));
  const savePolishedDescriptions = vi.fn(async (_m: ReadonlyMap<string, string>) => undefined);
  const saveAttributePolish = vi.fn(async () => true);
  const svc = new WorkHistoryPolishService(
    { polishWorkHistory } as never,
    { savePolishedDescriptions } as never,
    { saveAttributePolish } as never,
  );
  return { svc, polishWorkHistory, savePolishedDescriptions, saveAttributePolish };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

describe("the polisher visits EVERY entry", () => {
  it("polishes both employments, not just the first", async () => {
    const { svc, polishWorkHistory } = setup({ "raw one": "One.", "raw two": "Two." });
    const out = await svc.polish(
      WORKER,
      [employment("1", "raw one"), employment("2", "raw two")],
      CTX,
      ON,
    );

    expect(polishWorkHistory).toHaveBeenCalledTimes(2);
    expect(out[0]!.roles[0]!.workDonePolished).toBe("One.");
    expect(out[1]!.roles[0]!.workDonePolished).toBe("Two.");
  });

  it("keeps going after a stint the model declines — the reported defect", async () => {
    // THE ONE THAT MATTERS. The screenshot showed entry 1 raw and entry 2 rewritten, which is
    // only reachable if a failure is scoped to its own stint. A polisher that abandoned the loop
    // on the first null would leave entry 2 raw as well, and every previous test was blind to it.
    const { svc, polishWorkHistory } = setup({ "raw one": null, "raw two": "Two." });
    const out = await svc.polish(
      WORKER,
      [employment("1", "raw one"), employment("2", "raw two")],
      CTX,
      ON,
    );

    expect(polishWorkHistory).toHaveBeenCalledTimes(2);
    expect(out[0]!.roles[0]!.workDonePolished ?? null).toBeNull();
    expect(out[1]!.roles[0]!.workDonePolished).toBe("Two.");
  });

  it("polishes every stint of a promotion, not just the employment's first", async () => {
    // §11 #14 — a promotion is ONE employer block with two dated function lines. Both stints
    // carry their own description and both must be rewritten.
    const promoted = {
      ...employment("1", "unused"),
      roles: [
        {
          id: "role-a",
          roleLabel: "Senior Turner",
          startYm: "2022-01",
          endYm: null,
          workDone: "raw one",
          workDonePolished: null,
          workDonePolishDeclined: false,
        },
        {
          id: "role-b",
          roleLabel: "Turner",
          startYm: "2021-05",
          endYm: "2021-12",
          workDone: "raw two",
          workDonePolished: null,
          workDonePolishDeclined: false,
        },
      ],
    } as WorkerEmploymentRecord;

    const { svc, polishWorkHistory } = setup({ "raw one": "One.", "raw two": "Two." });
    const out = await svc.polish(WORKER, [promoted], CTX, ON);

    expect(polishWorkHistory).toHaveBeenCalledTimes(2);
    expect(out[0]!.roles.map((r) => r.workDonePolished)).toEqual(["One.", "Two."]);
  });

  it("persists every rewrite it earned in one write, keyed by stint", async () => {
    const { svc, savePolishedDescriptions } = setup({ "raw one": "One.", "raw two": "Two." });
    await svc.polish(WORKER, [employment("1", "raw one"), employment("2", "raw two")], CTX, ON);

    const written = savePolishedDescriptions.mock.calls[0]![0];
    expect([...written.entries()]).toEqual([
      ["role-1", "One."],
      ["role-2", "Two."],
    ]);
  });

  it("skips a stint the worker declined while still polishing the others (#1354)", async () => {
    // A refusal is scoped to the stint it was made on. It must not cost the worker's OTHER
    // employers their rewrite.
    const { svc, polishWorkHistory } = setup({ "raw two": "Two." });
    const out = await svc.polish(
      WORKER,
      [employment("1", "raw one", { declined: true }), employment("2", "raw two")],
      CTX,
      ON,
    );

    expect(polishWorkHistory).toHaveBeenCalledTimes(1);
    expect(out[0]!.roles[0]!.workDonePolished ?? null).toBeNull();
    expect(out[1]!.roles[0]!.workDonePolished).toBe("Two.");
  });
});

describe("every entry PRINTS its own rewrite", () => {
  const ON_OPTS = { polishEnabled: true } as const;

  it("renders each employment from its own polish state", async () => {
    const block = buildEmploymentBlock(
      [
        employment("1", "raw one", { polished: "One." }),
        employment("2", "raw two", { polished: null }),
      ],
      ON_OPTS,
    );

    expect(block.employments[0]!.work).toBe("One.");
    // Still the worker's own words — the fallback is per entry, never a whole-sheet decision.
    expect(block.employments[1]!.work).toBe("raw two");
  });

  it("never prints one employer's line half-English and half-Hinglish", () => {
    // A promotion whose two stints share a description, polished on one stint and not the other.
    // The dedupe used to key on the PRINTED text, so the two spellings of the same fact looked
    // like two facts and both were joined onto the one work line.
    const half = {
      ...employment("1", "unused"),
      roles: [
        {
          id: "role-a",
          roleLabel: "Senior Turner",
          startYm: "2022-01",
          endYm: null,
          workDone: "shaft banata tha",
          workDonePolished: "Turned shafts.",
          workDonePolishDeclined: false,
        },
        {
          id: "role-b",
          roleLabel: "Turner",
          startYm: "2021-05",
          endYm: "2021-12",
          workDone: "shaft banata tha",
          workDonePolished: null,
          workDonePolishDeclined: false,
        },
      ],
    } as WorkerEmploymentRecord;

    const block = buildEmploymentBlock([half], ON_OPTS).employments[0]!;
    expect(block.work).toBe("Turned shafts.");
    expect(block.work).not.toContain("shaft banata tha");
  });

  it("keeps the own-words line about the SAME stints as the printed line (#1354)", () => {
    // The two strings are shown side by side and the worker is asked to choose between them. A
    // comparison whose halves describe different stints is not a choice he can make.
    const two = {
      ...employment("1", "unused"),
      roles: [
        {
          id: "role-a",
          roleLabel: "Turner",
          startYm: null,
          endYm: null,
          workDone: "shaft banata tha",
          workDonePolished: "Turned shafts.",
          workDonePolishDeclined: false,
        },
        {
          id: "role-b",
          roleLabel: "Operator",
          startYm: null,
          endYm: null,
          workDone: "drawing padhta tha",
          workDonePolished: null,
          workDonePolishDeclined: false,
        },
      ],
    } as WorkerEmploymentRecord;

    const block = buildEmploymentBlock([two], ON_OPTS).employments[0]!;
    expect(block.work).toBe("Turned shafts. · drawing padhta tha");
    expect(block.work_own_words).toBe("shaft banata tha · drawing padhta tha");
    // Same number of parts, in the same order — one stint per part on both sides.
    expect(block.work.split(" · ")).toHaveLength(block.work_own_words!.split(" · ").length);
  });

  it("reverts EVERY entry when the kill switch is off (#1350 item 4)", () => {
    const block = buildEmploymentBlock(
      [
        employment("1", "raw one", { polished: "One." }),
        employment("2", "raw two", { polished: "Two." }),
      ],
      { polishEnabled: false },
    );

    expect(block.employments.map((e) => e.work)).toEqual(["raw one", "raw two"]);
  });
});

/**
 * ═══ THE FRESHER'S ZONE 4 (owner report, 2026-09-09) ═══
 *
 * A worker with no employment history gets his ITI training in Zone 4, and its one free-text
 * segment printed exactly as typed. The machines and the trade-test clause beside it are closed
 * vocabulary and must NEVER be sent to a model — these pin both halves of that.
 */
describe("the fresher's training description", () => {
  const PACK = "qp_cnc_turning";
  const RAW = "kuch nhi banaya, bas knowledge he mujhe";
  const POLISHED = "Gained working knowledge without independent production.";
  const attributes = {
    iti_workshop_machines: ["cnc_lathe"],
    trade_test_status: "passed",
    iti_project_work: RAW,
  };

  it("prints the rewrite when there is one and the switch is on", () => {
    const [row] = buildFresherRows(PACK, attributes, {
      polished: { [ITI_PROJECT_WORK_KEY]: POLISHED },
      polishEnabled: true,
    });
    expect(row!.work).toContain(POLISHED);
    expect(row!.work).not.toContain(RAW);
  });

  it("prints the worker's own words when there is no rewrite", () => {
    const [row] = buildFresherRows(PACK, attributes, { polishEnabled: true });
    expect(row!.work).toContain(RAW);
  });

  it("defaults to the worker's own words — fails closed", () => {
    // A caller that forgets the flag gets what §8 guaranteed, never the permissive answer.
    const [row] = buildFresherRows(PACK, attributes);
    expect(row!.work).toContain(RAW);
  });

  it("reverts an already-stored rewrite when the switch is off (#1350 item 4)", () => {
    const [row] = buildFresherRows(PACK, attributes, {
      polished: { [ITI_PROJECT_WORK_KEY]: POLISHED },
      polishEnabled: false,
    });
    expect(row!.work).toContain(RAW);
    expect(row!.work).not.toContain(POLISHED);
  });

  it("leaves the closed-vocabulary segments exactly as the dictionary spells them", () => {
    // The machine label and the trade-test clause are §8 closed vocabulary. A rewrite of the
    // project text must not disturb either — they never reach a model at all.
    const [row] = buildFresherRows(PACK, attributes, {
      polished: { [ITI_PROJECT_WORK_KEY]: POLISHED },
      polishEnabled: true,
    });
    const bare = buildFresherRows(PACK, attributes)[0]!;
    const segments = row!.work.split(" · ");
    expect(segments.slice(0, -1)).toEqual(bare.work.split(" · ").slice(0, -1));
  });
});

describe("the fresher polish call", () => {
  it("asks the model once and stores the answer beside the attribute", async () => {
    const { svc, polishWorkHistory, saveAttributePolish } = setup({ raw: "Rewritten." });
    const out = await svc.polishAttribute(
      WORKER,
      ITI_PROJECT_WORK_KEY,
      "raw",
      "ITI trainee",
      CTX,
      ON,
      null,
    );

    expect(out).toBe("Rewritten.");
    expect(polishWorkHistory).toHaveBeenCalledTimes(1);
    expect(saveAttributePolish).toHaveBeenCalledWith(WORKER, ITI_PROJECT_WORK_KEY, "Rewritten.");
  });

  it("spends nothing when a rewrite is already stored", async () => {
    const { svc, polishWorkHistory } = setup({ raw: "Rewritten." });
    const out = await svc.polishAttribute(
      WORKER,
      ITI_PROJECT_WORK_KEY,
      "raw",
      "ITI trainee",
      CTX,
      ON,
      "Stored.",
    );

    expect(out).toBe("Stored.");
    expect(polishWorkHistory).not.toHaveBeenCalled();
  });

  it("does not call the model at all when the kill switch is off", async () => {
    const { svc, polishWorkHistory } = setup({ raw: "Rewritten." });
    const out = await svc.polishAttribute(
      WORKER,
      ITI_PROJECT_WORK_KEY,
      "raw",
      "ITI trainee",
      CTX,
      OFF,
      null,
    );

    expect(out).toBeNull();
    expect(polishWorkHistory).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing when the model declines", async () => {
    const { svc } = setup({});
    await expect(
      svc.polishAttribute(WORKER, ITI_PROJECT_WORK_KEY, "raw", "ITI trainee", CTX, ON, null),
    ).resolves.toBeNull();
  });

  it("carries no identifying data to the model", async () => {
    // Same guarantee the stint path gives: the worker ref, the sentence and a context label.
    const { svc, polishWorkHistory } = setup({ raw: "Rewritten." });
    await svc.polishAttribute(WORKER, ITI_PROJECT_WORK_KEY, "raw", "ITI trainee", CTX, ON, null);

    const payload = polishWorkHistory.mock.calls[0]![0];
    expect(Object.keys(payload).sort()).toEqual([
      "role_label",
      "schema_version",
      "work_done",
      "worker_ref",
    ]);
  });
});

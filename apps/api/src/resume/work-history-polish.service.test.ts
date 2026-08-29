import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { WorkHistoryPolishService } from "./work-history-polish.service";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";

/**
 * ═══ WORK-HISTORY POLISH (#1350) ═══
 *
 * This is the ONE field on the sheet the model may compose, by an owner ruling that overrides
 * §8's "there is no fourth source". The fabrication gate can no longer prove it, so what this
 * file protects is the set of properties that replaced that proof:
 *
 *   1. IT IS OFF UNLESS TURNED ON, twice over — this flag and `AI_REAL_CALL_TASKS`.
 *   2. EVERY FAILURE COSTS POLISH, NEVER A DESCRIPTION. Null, a throw, an unreachable service:
 *      the worker's own words print, exactly as they did before the ruling.
 *   3. IT NEVER RE-ASKS. One model call per stint ever, because the answer is written back.
 *   4. IT SENDS NOTHING IDENTIFYING. Not the employer, not the city, not the dates.
 *
 * (4) is the one worth stating twice: the employer name is the single most sensitive string on
 * this page, it sits one field away in the same record, and nothing but this assertion stops a
 * later edit from putting it in the prompt for "context".
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "c1", requestId: "r1" };

const record = (over: Partial<WorkerEmploymentRecord> = {}): WorkerEmploymentRecord =>
  ({
    employer: "Sandhar Technologies Ltd",
    employerCity: "Gurugram",
    employerState: "Haryana",
    startYm: "2022-04",
    endYm: null,
    durationStated: true,
    roles: [
      {
        id: "role-1",
        roleLabel: "CNC Turner",
        startYm: "2022-04",
        endYm: null,
        workDone: "lathe pe shaft banata tha, EN8 material",
        workDonePolished: null,
      },
    ],
    ...over,
  }) as WorkerEmploymentRecord;

function setup(opts: { polished?: string | null; throws?: boolean; saveThrows?: boolean } = {}) {
  // TYPED TO TAKE ITS ARGUMENT, so the no-identifying-data assertion below can read the payload.
  // `vi.fn(async () => ...)` infers a zero-arg signature and `mock.calls[0][0]` is a compile error.
  const polishWorkHistory = vi.fn(async (_input: Record<string, unknown>) =>
    opts.throws
      ? Promise.reject(new Error("ai down"))
      : { work_done: opts.polished ?? null, blocked: false, is_mock: false, ai_metadata: null },
  );
  const savePolishedDescriptions = vi.fn(async (_m: ReadonlyMap<string, string>) => {
    if (opts.saveThrows) throw new Error("db down");
  });
  const svc = new WorkHistoryPolishService(
    { polishWorkHistory } as never,
    { savePolishedDescriptions } as never,
  );
  return { svc, polishWorkHistory, savePolishedDescriptions };
}

const ON = { WORK_HISTORY_POLISH_ENABLED: true } as never;
const OFF = { WORK_HISTORY_POLISH_ENABLED: false } as never;

describe("WorkHistoryPolishService", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  describe("the kill switch", () => {
    it("does nothing at all when disabled — no call, no write", async () => {
      const { svc, polishWorkHistory, savePolishedDescriptions } = setup({ polished: "x" });
      const out = await svc.polish(WORKER, [record()], CTX, OFF);
      expect(polishWorkHistory).not.toHaveBeenCalled();
      expect(savePolishedDescriptions).not.toHaveBeenCalled();
      // The records come back untouched, so the sheet renders the worker's own words.
      expect(out[0]!.roles[0]!.workDonePolished ?? null).toBeNull();
    });
  });

  describe("the happy path", () => {
    it("folds the rewrite into the records it returns", async () => {
      // RETURNED, not just persisted: the FIRST render prints polished text rather than waiting
      // for a second render to pick it up.
      const { svc } = setup({ polished: "Turned shafts from EN8 on a lathe." });
      const out = await svc.polish(WORKER, [record()], CTX, ON);
      expect(out[0]!.roles[0]!.workDonePolished).toBe("Turned shafts from EN8 on a lathe.");
      // The worker's own words are NEVER overwritten — they are the system of record.
      expect(out[0]!.roles[0]!.workDone).toBe("lathe pe shaft banata tha, EN8 material");
    });

    it("persists the rewrite, keyed by the stint it belongs to", async () => {
      const { svc, savePolishedDescriptions } = setup({ polished: "Turned shafts." });
      await svc.polish(WORKER, [record()], CTX, ON);
      const written = savePolishedDescriptions.mock.calls[0]![0];
      expect([...written.entries()]).toEqual([["role-1", "Turned shafts."]]);
    });

    it("sends the description and the role, and NOTHING identifying", async () => {
      const { svc, polishWorkHistory } = setup({ polished: "Turned shafts." });
      await svc.polish(WORKER, [record()], CTX, ON);
      const sent = polishWorkHistory.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent).toEqual({
        schema_version: "oie.v1",
        worker_ref: WORKER,
        work_done: "lathe pe shaft banata tha, EN8 material",
        role_label: "CNC Turner",
      });
      // The employer, the city, the state and both dates sit in the same record one field away.
      // None of them may travel — they are rendered deterministically and never leave the API.
      const payload = JSON.stringify(sent);
      for (const secret of ["Sandhar", "Gurugram", "Haryana", "2022-04"]) {
        expect(payload).not.toContain(secret);
      }
    });
  });

  describe("every failure costs polish, never a description", () => {
    it("a null rewrite leaves the worker's own words", async () => {
      const { svc, savePolishedDescriptions } = setup({ polished: null });
      const out = await svc.polish(WORKER, [record()], CTX, ON);
      expect(out[0]!.roles[0]!.workDonePolished ?? null).toBeNull();
      expect(savePolishedDescriptions).not.toHaveBeenCalled();
    });

    it("a throwing AI client does not throw into the render", async () => {
      const { svc } = setup({ throws: true });
      const out = await svc.polish(WORKER, [record()], CTX, ON);
      expect(out[0]!.roles[0]!.workDone).toBe("lathe pe shaft banata tha, EN8 material");
    });

    it("a failed write-back still returns this render's rewrite", async () => {
      // The output is already computed and already correct; a failed persist costs one model
      // call on the next render, not this render's sheet.
      const { svc } = setup({ polished: "Turned shafts.", saveThrows: true });
      const out = await svc.polish(WORKER, [record()], CTX, ON);
      expect(out[0]!.roles[0]!.workDonePolished).toBe("Turned shafts.");
    });
  });

  describe("it never re-asks", () => {
    it("skips a stint that already has a polish", async () => {
      const { svc, polishWorkHistory } = setup({ polished: "new" });
      const already = record({
        roles: [
          {
            id: "role-1",
            roleLabel: "CNC Turner",
            startYm: null,
            endYm: null,
            workDone: "raw",
            workDonePolished: "already polished",
          },
        ],
      } as Partial<WorkerEmploymentRecord>);
      const out = await svc.polish(WORKER, [already], CTX, ON);
      expect(polishWorkHistory).not.toHaveBeenCalled();
      expect(out[0]!.roles[0]!.workDonePolished).toBe("already polished");
    });

    it("skips a stint with no description to rewrite", async () => {
      const { svc, polishWorkHistory } = setup({ polished: "x" });
      const blank = record({
        roles: [
          {
            id: "role-1",
            roleLabel: "CNC Turner",
            startYm: null,
            endYm: null,
            workDone: "   ",
            workDonePolished: null,
          },
        ],
      } as Partial<WorkerEmploymentRecord>);
      await svc.polish(WORKER, [blank], CTX, ON);
      expect(polishWorkHistory).not.toHaveBeenCalled();
    });

    it("does not call at all when there is no history", async () => {
      const { svc, polishWorkHistory } = setup({ polished: "x" });
      const out = await svc.polish(WORKER, [], CTX, ON);
      expect(out).toEqual([]);
      expect(polishWorkHistory).not.toHaveBeenCalled();
    });
  });
});

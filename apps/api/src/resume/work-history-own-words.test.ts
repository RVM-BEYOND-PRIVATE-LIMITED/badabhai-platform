import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { buildEmploymentBlock, type WorkerEmploymentRecord } from "./resume-employment-rows";
import { WorkHistoryPolishService } from "./work-history-polish.service";

/**
 * ═══ THE WORKER'S OWN WORDS (#1354) ═══
 *
 * #1350 overrode §8 so the model may rephrase a work description and print it. ADR-0039 records
 * what that cost: the fabrication gate proved a property about bytes, and what replaced it are
 * checks on a model. No test can assert the absence of a plausible-but-false sentence.
 *
 * So the real mitigation is not a check at all — it is the worker, who is the only person able to
 * say whether a sentence about their own work is true. This file protects their ability to say it:
 *
 *   1. A REFUSAL OUTRANKS A REWRITE. Declined means the worker's words print.
 *   2. A REFUSAL SURVIVES A RE-RENDER. This is the one that is easy to get wrong: the polisher
 *      visits every stint whose polish is null, so expressing "I refused" by CLEARING the polish
 *      would have the next render silently rewrite it again. The decision must be recorded, not
 *      expressed as a missing value.
 *   3. THE COMPARISON IS HONEST. `work_own_words` is composed through the SAME joiner as `work`,
 *      so a diff shown to a worker reflects the rewrite and not two different builders.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "c1", requestId: "r1" };
const ON = { WORK_HISTORY_POLISH_ENABLED: true } as never;

const RAW = "lathe pe shaft banata tha, EN8 material";
const POLISHED = "Turned shafts from EN8 bar stock on a CNC lathe.";

function record(over: Partial<{ polished: string | null; declined: boolean }> = {}) {
  return {
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
        workDone: RAW,
        workDonePolished: over.polished === undefined ? POLISHED : over.polished,
        workDonePolishDeclined: over.declined ?? false,
      },
    ],
  } as WorkerEmploymentRecord;
}

// The polish may only PRINT while the kill switch is on (#1350 item 4), so every case below that
// expects the rewrite has to say so. `ON_OPTS` names that rather than sprinkling a bare literal.
const ON_OPTS = { polishEnabled: true } as const;

describe("which text prints", () => {
  it("prints the rewrite when the worker has not refused it", () => {
    const block = buildEmploymentBlock([record()], ON_OPTS).employments[0]!;
    expect(block.work).toBe(POLISHED);
  });

  it("prints the worker's own words when they refused", () => {
    // A refusal outranks a rewrite. Nobody else is in a position to know whether a sentence
    // about this worker's job is true.
    const block = buildEmploymentBlock([record({ declined: true })], ON_OPTS).employments[0]!;
    expect(block.work).toBe(RAW);
  });

  it("prints the worker's own words when there is no rewrite at all", () => {
    const block = buildEmploymentBlock([record({ polished: null })], ON_OPTS).employments[0]!;
    expect(block.work).toBe(RAW);
  });

  it("always carries the own-words line beside the printed one", () => {
    // The comparison a client shows. Composed through the SAME joiner, so a diff shown to a
    // worker reflects the rewrite rather than two differently-built strings.
    const block = buildEmploymentBlock([record()], ON_OPTS).employments[0]!;
    expect(block.work).toBe(POLISHED);
    expect(block.work_own_words).toBe(RAW);
  });

  it("collapses to one value when nothing was rewritten", () => {
    const block = buildEmploymentBlock([record({ polished: null })], ON_OPTS).employments[0]!;
    expect(block.work).toBe(block.work_own_words);
  });
});

/**
 * ═══ THE KILL SWITCH REVERTS WHAT ALREADY PRINTED (#1350 item 4) ═══
 *
 * #1350 requires a switch that makes the §8 override "revertible in production WITHOUT A DEPLOY".
 * Gating only the polisher would not have been that: it stops NEW rewrites, while every row
 * already carrying `work_done_polished` keeps printing model-composed text forever. Reverting
 * would have meant a data migration to NULL the column, or a deploy — precisely the two things a
 * kill switch exists to avoid. So the RENDERER reads it too, and these are the tests that say so.
 */
describe("the kill switch (#1350 item 4)", () => {
  it("reverts an ALREADY-POLISHED row to the worker's own words", () => {
    // THE ONE THAT MATTERS. The row is polished and the worker never objected — under the old
    // behaviour this printed the model's sentence no matter what the switch said.
    const block = buildEmploymentBlock([record()], { polishEnabled: false }).employments[0]!;
    expect(block.work).toBe(RAW);
  });

  it("defaults to off when a caller does not pass the flag — fails closed", () => {
    // The raw text is never overwritten, so falling back to it is always safe. A caller that
    // forgets the flag must get the answer §8 guaranteed, not the permissive one.
    const block = buildEmploymentBlock([record()]).employments[0]!;
    expect(block.work).toBe(RAW);
  });

  it("keeps the rewrite in the column, so flipping back on restores it", () => {
    // Reverting must not destroy anything. Same record, switch back on, polish returns — no
    // re-render cost, no second model call, no data migration in either direction.
    const off = buildEmploymentBlock([record()], { polishEnabled: false }).employments[0]!;
    const on = buildEmploymentBlock([record()], ON_OPTS).employments[0]!;
    expect(off.work).toBe(RAW);
    expect(on.work).toBe(POLISHED);
  });

  it("still exposes the worker's own words either way", () => {
    // `work_own_words` is not gated: it is the worker's own text and was never the model's.
    const off = buildEmploymentBlock([record()], { polishEnabled: false }).employments[0]!;
    expect(off.work_own_words).toBe(RAW);
  });
});

describe("a refusal survives a re-render", () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  function setup() {
    const polishWorkHistory = vi.fn(async (_i: Record<string, unknown>) => ({
      work_done: "a fresh rewrite",
      blocked: false,
      is_mock: false,
      ai_metadata: null,
    }));
    const svc = new WorkHistoryPolishService(
      { polishWorkHistory } as never,
      { savePolishedDescriptions: vi.fn(async () => undefined) } as never,
    );
    return { svc, polishWorkHistory };
  }

  it("does not re-polish a stint the worker declined, even with a null polish", async () => {
    // THE DEFECT THIS EXISTS FOR. Expressing a refusal by clearing `work_done_polished` would be
    // undone on the very next render: the polisher's work-list is "every stint whose polish is
    // null", which is exactly the state a cleared polish leaves behind. The worker's decision
    // would survive until the next re-render and no further, and nothing would report that.
    const { svc, polishWorkHistory } = setup();
    const out = await svc.polish(WORKER, [record({ polished: null, declined: true })], CTX, ON);
    expect(polishWorkHistory).not.toHaveBeenCalled();
    expect(out[0]!.roles[0]!.workDonePolished ?? null).toBeNull();
  });

  it("still polishes a stint that simply has not been done yet", async () => {
    // The discriminating case: same null polish, no refusal. Without it the test above would
    // pass against a polisher that had stopped working entirely.
    const { svc, polishWorkHistory } = setup();
    await svc.polish(WORKER, [record({ polished: null, declined: false })], CTX, ON);
    expect(polishWorkHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps the rewrite on a declined stint, so the worker can change their mind", async () => {
    // Declining does not destroy the polish — putting it back must not cost another model call.
    const { svc, polishWorkHistory } = setup();
    const out = await svc.polish(WORKER, [record({ declined: true })], CTX, ON);
    expect(polishWorkHistory).not.toHaveBeenCalled();
    expect(out[0]!.roles[0]!.workDonePolished).toBe(POLISHED);
  });
});

import { describe, expect, it } from "vitest";
import { HIRE_RECORD_SOURCES, type HireRecordSource } from "@badabhai/types";
import { hireDayOf, nextHireState, type HireState } from "./hire-state";

/**
 * #2753 item 9 — the rules of a hire record, source by source, as a pure function. The service
 * (`hires.service.test.ts`) and Postgres (`hires.db.test.ts`) prove the row follows them.
 */

const T1 = new Date("2026-11-16T04:00:00.000Z"); // 09:30 IST, 16 Nov
const T2 = new Date("2026-11-20T20:00:00.000Z"); // 01:30 IST, 21 Nov
const T3 = new Date("2026-12-01T06:00:00.000Z");

/** Apply sources in order from no record, returning every intermediate answer. */
function run(...steps: [HireRecordSource, Date][]): (HireState | null)[] {
  let state: HireState | null = null;
  const out: (HireState | null)[] = [];
  for (const [source, at] of steps) {
    const next = nextHireState(state, source, at);
    out.push(next);
    if (next !== null) state = next;
  }
  return out;
}

function last(...steps: [HireRecordSource, Date][]): HireState | null {
  let state: HireState | null = null;
  for (const [source, at] of steps) state = nextHireState(state, source, at) ?? state;
  return state;
}

describe("hireDayOf — the India day", () => {
  it("is the IST calendar day, across the UTC midnight", () => {
    expect(hireDayOf(T1)).toBe("2026-11-16");
    expect(hireDayOf(T2)).toBe("2026-11-21");
  });
});

describe("each source on no record", () => {
  it.each([
    ["company_mark", "companyMarkedAt"],
    ["company_answer", "companyAnsweredAt"],
    ["desk_confirm", "deskConfirmedAt"],
  ] as const)("%s creates a CONFIRMED record, stamps %s and the hire day", (source, column) => {
    const s = nextHireState(null, source, T1)!;
    expect(s.status).toBe("confirmed");
    expect(s[column]).toBe(T1);
    expect(s.hiredOn).toBe("2026-11-16");
    const others = (
      ["companyMarkedAt", "companyAnsweredAt", "workerAnsweredAt", "deskConfirmedAt"] as const
    ).filter((c) => c !== column);
    for (const c of others) expect(s[c]).toBeNull();
  });

  it("worker_answer creates a REPORTED record: no hire day, never confirmed by itself", () => {
    expect(nextHireState(null, "worker_answer", T1)).toEqual({
      status: "reported",
      companyMarkedAt: null,
      companyAnsweredAt: null,
      workerAnsweredAt: T1,
      deskConfirmedAt: null,
      hiredOn: null,
    });
  });

  it.each(["company_unmark", "desk_reject"] as const)(
    "%s on no record creates nothing",
    (source) => {
      expect(nextHireState(null, source, T1)).toBeNull();
    },
  );

  it("every source is handled (the closed list)", () => {
    for (const source of HIRE_RECORD_SOURCES) {
      expect(() => nextHireState(null, source, T1)).not.toThrow();
    }
  });
});

describe("three sources, one record (the issue's check)", () => {
  it("a mark, a company answer and a worker answer: one confirmed record, every source stamped", () => {
    expect(last(["company_mark", T1], ["company_answer", T2], ["worker_answer", T3])).toEqual({
      status: "confirmed",
      companyMarkedAt: T1,
      companyAnsweredAt: T2,
      workerAnsweredAt: T3,
      deskConfirmedAt: null,
      hiredOn: "2026-11-16",
    });
  });

  it("the worker first: reported, then the company's mark confirms it on the mark's day", () => {
    const [a, b] = run(["worker_answer", T1], ["company_mark", T2]);
    expect(a!.status).toBe("reported");
    expect(b).toMatchObject({ status: "confirmed", workerAnsweredAt: T1, companyMarkedAt: T2 });
    expect(b!.hiredOn).toBe("2026-11-21");
  });

  it("a worker answer AFTER a confirmation keeps it confirmed (and is still a change: a new source)", () => {
    const [, b] = run(["company_answer", T1], ["worker_answer", T2]);
    expect(b).toMatchObject({ status: "confirmed", workerAnsweredAt: T2, hiredOn: "2026-11-16" });
  });
});

describe("repeats change nothing", () => {
  it.each(["company_mark", "company_answer", "desk_confirm", "worker_answer"] as const)(
    "%s twice: the second is null, the first timestamp stays",
    (source) => {
      const [first, second] = run([source, T1], [source, T2]);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    },
  );

  it("a worker's repeat answer does not reopen a rejected record", () => {
    const [, , , again] = run(
      ["worker_answer", T1],
      ["company_mark", T1],
      ["company_unmark", T2],
      ["worker_answer", T3],
    );
    expect(again).toBeNull();
  });

  it("desk_reject of a rejected record changes nothing", () => {
    expect(run(["company_mark", T1], ["desk_reject", T2], ["desk_reject", T3])[2]).toBeNull();
  });
});

describe("the undo rule (company_unmark)", () => {
  it("a record only the company's mark confirmed goes to rejected; the history stays", () => {
    expect(last(["company_mark", T1], ["company_unmark", T2])).toEqual({
      status: "rejected",
      companyMarkedAt: T1,
      companyAnsweredAt: null,
      workerAnsweredAt: null,
      deskConfirmedAt: null,
      hiredOn: "2026-11-16",
    });
  });

  it("the worker's word does not keep it confirmed: rejected, his answer kept", () => {
    expect(last(["worker_answer", T1], ["company_mark", T1], ["company_unmark", T2])).toMatchObject(
      { status: "rejected", workerAnsweredAt: T1, companyMarkedAt: T1 },
    );
  });

  it.each([
    ["the company's answer", "company_answer"],
    ["the desk", "desk_confirm"],
  ] as const)("a record %s also confirmed stays confirmed (no change)", (_c, other) => {
    expect(run(["company_mark", T1], [other, T2], ["company_unmark", T3])[2]).toBeNull();
  });

  it("an undo of a record no mark confirmed (only the worker said so) changes nothing", () => {
    expect(run(["worker_answer", T1], ["company_unmark", T2])[1]).toBeNull();
  });

  it("a re-mark confirms it again, keeping the first mark's time and the first hire day", () => {
    const [, , again] = run(["company_mark", T1], ["company_unmark", T2], ["company_mark", T3]);
    expect(again).toEqual({
      status: "confirmed",
      companyMarkedAt: T1,
      companyAnsweredAt: null,
      workerAnsweredAt: null,
      deskConfirmedAt: null,
      hiredOn: "2026-11-16",
    });
  });
});

describe("the desk", () => {
  it("desk_reject rejects even a company-confirmed record; a later confirmation confirms again", () => {
    const [, rejected, back] = run(
      ["company_answer", T1],
      ["desk_reject", T2],
      ["desk_confirm", T3],
    );
    expect(rejected).toMatchObject({ status: "rejected", companyAnsweredAt: T1 });
    expect(back).toMatchObject({ status: "confirmed", deskConfirmedAt: T3, hiredOn: "2026-11-16" });
  });

  it("desk_confirm confirms a reported record", () => {
    expect(last(["worker_answer", T1], ["desk_confirm", T2])).toMatchObject({
      status: "confirmed",
      workerAnsweredAt: T1,
      deskConfirmedAt: T2,
      hiredOn: "2026-11-21",
    });
  });

  it("a worker answer on a rejected record (his first) reports it again", () => {
    expect(last(["company_mark", T1], ["desk_reject", T2], ["worker_answer", T3])).toMatchObject({
      status: "reported",
      workerAnsweredAt: T3,
    });
  });
});

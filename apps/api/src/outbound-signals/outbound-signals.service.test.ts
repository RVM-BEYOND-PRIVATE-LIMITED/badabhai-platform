import { describe, expect, it, vi } from "vitest";
import { istDayOf, OutboundSignalsService, selectionDedupeKey } from "./outbound-signals.service";

/**
 * #2747 item 8 — the recorder the stage transaction calls. It queues one row for a mark on an
 * actively linked RVM student, ids only, once per (posting, worker, stage); anyone else gets none.
 * The rows themselves are pinned on Postgres in outbound-signals.db.test.ts.
 */

const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const WORKER = "33333333-3333-4333-8333-000000000001";
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
const TX = { tx: true } as never;

function make(over: { rvm?: boolean; inserted?: boolean; switchOn?: boolean } = {}) {
  const repo = {
    isActiveRvmStudent: vi.fn(async () => over.rvm ?? true),
    insertSelection: vi.fn(async () => over.inserted ?? true),
  };
  const rollout = { isEnabledFor: vi.fn(async () => over.switchOn ?? false) };
  return { svc: new OutboundSignalsService(repo as never, rollout as never), repo, rollout };
}

describe("signalsOnFor — the company's switch", () => {
  it("asks `outbound_signals` with the tenant key", async () => {
    const d = make({ switchOn: true });
    await expect(d.svc.signalsOnFor(TENANT as never)).resolves.toBe(true);
    expect(d.rollout.isEnabledFor).toHaveBeenCalledWith("outbound_signals", TENANT);
  });
});

describe("recordMark — one row per mark on an RVM student", () => {
  const mark = (stage: "selected" | "hired", at = new Date("2026-11-15T10:00:00.000Z")) => ({
    postingKind: "company_posting" as const,
    postingId: POSTING,
    workerId: WORKER,
    stage,
    at,
  });

  it("queues the selected mark in the caller's transaction, ids only", async () => {
    const d = make();
    await expect(d.svc.recordMark(mark("selected"), TX)).resolves.toBe("queued");
    expect(d.repo.isActiveRvmStudent).toHaveBeenCalledWith(WORKER, TX);
    expect(d.repo.insertSelection).toHaveBeenCalledWith(
      {
        dedupeKey: `rvm_selection_events:company_posting:${POSTING}:${WORKER}:selected`,
        kind: "applicant_selected",
        payload: {
          posting_kind: "company_posting",
          posting_id: POSTING,
          worker_id: WORKER,
          stage: "selected",
          marked_on: "2026-11-15",
        },
        at: new Date("2026-11-15T10:00:00.000Z"),
      },
      TX,
    );
  });

  it("hired is its own kind and its own key: selected, then hired, is two signals", async () => {
    const d = make();
    await d.svc.recordMark(mark("hired"), TX);
    const arg = (
      d.repo.insertSelection.mock.calls[0] as unknown as [{ kind: string; dedupeKey: string }]
    )[0];
    expect(arg.kind).toBe("applicant_hired");
    expect(arg.dedupeKey).toBe(selectionDedupeKey("company_posting", POSTING, WORKER, "hired"));
    expect(arg.dedupeKey).not.toBe(
      selectionDedupeKey("company_posting", POSTING, WORKER, "selected"),
    );
  });

  it("a mark signalled before is a duplicate (the unique key), not a second row", async () => {
    const d = make({ inserted: false });
    await expect(d.svc.recordMark(mark("selected"), TX)).resolves.toBe("duplicate");
  });

  it("anyone who is not an actively linked RVM student gets nothing queued", async () => {
    const d = make({ rvm: false });
    await expect(d.svc.recordMark(mark("hired"), TX)).resolves.toBe("not_rvm");
    expect(d.repo.insertSelection).not.toHaveBeenCalled();
  });

  it("the payload never carries a name, a title, a company or a reference", async () => {
    const d = make();
    await d.svc.recordMark(mark("selected"), TX);
    const arg = (d.repo.insertSelection.mock.calls[0] as unknown as [{ payload: object }])[0];
    expect(Object.keys(arg.payload).sort()).toEqual(
      ["marked_on", "posting_id", "posting_kind", "stage", "worker_id"].sort(),
    );
  });
});

describe("istDayOf — the date RVM's event carries", () => {
  it("is the India calendar day: 18:29 UTC is still today, 18:30 UTC is tomorrow", () => {
    expect(istDayOf(new Date("2026-11-15T18:29:59.000Z"))).toBe("2026-11-15");
    expect(istDayOf(new Date("2026-11-15T18:30:00.000Z"))).toBe("2026-11-16");
    expect(istDayOf(new Date("2026-11-14T20:00:00.000Z"))).toBe("2026-11-15");
  });
});

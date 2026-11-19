import { describe, expect, it, vi } from "vitest";
import type { ChainRow } from "./outbound-signals.repository";
import {
  istDayOf,
  lastDeliveredFrom,
  latestOf,
  marksUndone,
  OUTBOUND_SEND_DELAY_MS,
  OutboundSignalsService,
  selectionDedupeKey,
} from "./outbound-signals.service";

/**
 * #2747 item 8 — the recorder the stage transaction calls. It queues one row for a mark on an
 * actively linked RVM student, ids only, once per (posting, worker, stage); anyone else gets none.
 * The rows themselves are pinned on Postgres in outbound-signals.db.test.ts.
 */

const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const WORKER = "33333333-3333-4333-8333-000000000001";
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
const TX = { tx: true } as never;

function make(
  over: { rvm?: boolean; inserted?: boolean; switchOn?: boolean; chain?: ChainRow[] } = {},
) {
  const repo = {
    isActiveRvmStudent: vi.fn(async () => over.rvm ?? true),
    chainFor: vi.fn(async (_key: unknown, _tx?: unknown) => over.chain ?? []),
    insertSignal: vi.fn(async (_input: unknown, _tx: unknown) => over.inserted ?? true),
  };
  const rollout = { stateFor: vi.fn(async () => (over.switchOn ? "on" : "off")) };
  return { svc: new OutboundSignalsService(repo as never, rollout as never), repo, rollout };
}

describe("signalsStateFor — the company's switch", () => {
  it("asks `outbound_signals` with the tenant key, keeping `unavailable` apart", async () => {
    const d = make({ switchOn: true });
    await expect(d.svc.signalsStateFor(TENANT as never)).resolves.toBe("on");
    expect(d.rollout.stateFor).toHaveBeenCalledWith("outbound_signals", TENANT);
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
    expect(d.repo.insertSignal).toHaveBeenCalledWith(
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
        // Due ten minutes later: a mis-tap undone in that window never reaches RVM.
        sendAfter: new Date("2026-11-15T10:10:00.000Z"),
      },
      TX,
    );
    expect(OUTBOUND_SEND_DELAY_MS).toBe(10 * 60_000);
  });

  it("hired is its own kind and its own key: selected, then hired, is two signals", async () => {
    const d = make();
    await d.svc.recordMark(mark("hired"), TX);
    const arg = (
      d.repo.insertSignal.mock.calls[0] as unknown as [{ kind: string; dedupeKey: string }]
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
    expect(d.repo.insertSignal).not.toHaveBeenCalled();
  });

  it("the payload never carries a name, a title, a company or a reference", async () => {
    const d = make();
    await d.svc.recordMark(mark("selected"), TX);
    const arg = (d.repo.insertSignal.mock.calls[0] as unknown as [{ payload: object }])[0];
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

// ── #2771 — the withdrawal of an undone mark ────────────────────────────────────────────────────

const SEL_1 = "11111111-1111-4111-8111-000000000001";
const WD_1 = "22222222-2222-4222-8222-000000000001";
const SEL_2 = "11111111-1111-4111-8111-000000000002";
const WD_2 = "22222222-2222-4222-8222-000000000002";
const FIRST_KEY = `rvm_selection_events:company_posting:${POSTING}:${WORKER}:selected`;

const sel = (id: string, status: ChainRow["status"], afterId: string | null = null): ChainRow => ({
  id,
  kind: "applicant_selected",
  status,
  afterId,
});
const wd = (id: string, status: ChainRow["status"], afterId: string): ChainRow => ({
  id,
  kind: "applicant_mark_withdrawn",
  status,
  afterId,
});

const markAt = (stage: "selected" | "hired" = "selected") => ({
  postingKind: "company_posting" as const,
  postingId: POSTING,
  workerId: WORKER,
  stage,
  at: new Date("2026-11-19T10:00:00.000Z"),
});

describe("marksUndone — which marks a real move takes back", () => {
  it.each([
    ["selected", "shortlist", ["selected"]],
    ["selected", "new", ["selected"]],
    ["selected", "passed", ["selected"]],
    ["hired", "shortlist", ["selected", "hired"]],
    ["hired", "new", ["selected", "hired"]],
    ["hired", "selected", ["hired"]],
    ["selected", "hired", []],
    ["new", "selected", []],
    ["shortlist", "passed", []],
    ["new", "hired", []],
  ] as const)("%s → %s undoes %j", (from, to, undone) => {
    expect(marksUndone(from, to)).toEqual(undone);
  });
});

describe("latestOf / lastDeliveredBefore — walking a mark's chain", () => {
  it("an empty chain has no latest row", () => {
    expect(latestOf([])).toBeNull();
  });

  it("the latest row is the end of the walk from the first selection, whatever the row order", () => {
    const chain = [
      wd(WD_1, "delivered", SEL_1),
      sel(SEL_2, "pending", WD_1),
      sel(SEL_1, "delivered"),
    ];
    expect(latestOf(chain)?.id).toBe(SEL_2);
    expect(latestOf([sel(SEL_1, "pending")])?.id).toBe(SEL_1);
  });

  it("what RVM holds up to a row's predecessor: the last delivered row, skipping cancelled ones", () => {
    const chain = [
      sel(SEL_1, "delivered"),
      wd(WD_1, "cancelled", SEL_1),
      sel(SEL_2, "cancelled", WD_1),
      wd(WD_2, "pending", SEL_2),
    ];
    // WD_2 follows SEL_2: walk back from SEL_2.
    expect(lastDeliveredFrom(chain, SEL_2)?.id).toBe(SEL_1);
    expect(lastDeliveredFrom(chain, SEL_1)?.id).toBe(SEL_1); // inclusive
    expect(lastDeliveredFrom(chain, null)).toBeNull(); // the first row: nothing before it
    expect(lastDeliveredFrom([sel(SEL_1, "cancelled")], SEL_1)).toBeNull();
    expect(lastDeliveredFrom([], SEL_1)).toBeNull(); // a predecessor not in the chain
  });

  it("a corrupted, cyclic chain ends the walk instead of looping", () => {
    const loop = [wd(WD_1, "cancelled", SEL_1), sel(SEL_1, "cancelled", WD_1)];
    expect(lastDeliveredFrom(loop, SEL_1)).toBeNull();
    expect(latestOf(loop)).toBeNull(); // no first selection to start from
  });
});

describe("recordUndo — one withdrawal per undo, never for a mark never sent", () => {
  it.each([
    ["delivered (RVM has it)", "delivered"],
    ["pending (it may still go)", "pending"],
  ] as const)(
    "the chain ends in a selection that is %s: one withdrawal, ids only, keyed on it",
    async (_label, status) => {
      const d = make({ chain: [sel(SEL_1, status)] });
      await expect(d.svc.recordUndo(markAt(), TX)).resolves.toBe("queued");
      expect(d.repo.chainFor).toHaveBeenCalledWith(markAt(), TX);
      expect(d.repo.insertSignal).toHaveBeenCalledWith(
        {
          dedupeKey: `${FIRST_KEY}:after:${SEL_1}`,
          kind: "applicant_mark_withdrawn",
          payload: {
            posting_kind: "company_posting",
            posting_id: POSTING,
            worker_id: WORKER,
            stage: "selected",
            undone_on: "2026-11-19",
            after_signal_id: SEL_1,
          },
          at: new Date("2026-11-19T10:00:00.000Z"),
          sendAfter: new Date("2026-11-19T10:10:00.000Z"),
        },
        TX,
      );
    },
  );

  it("never checks the link: a mark RVM holds is withdrawn even after the link ended", async () => {
    const d = make({ rvm: false, chain: [sel(SEL_1, "delivered")] });
    await expect(d.svc.recordUndo(markAt(), TX)).resolves.toBe("queued");
    expect(d.repo.isActiveRvmStudent).not.toHaveBeenCalled();
  });

  it.each([
    ["never signalled", []],
    ["its selection was cancelled before it went", [sel(SEL_1, "cancelled")]],
    ["its selection was refused for good (dead)", [sel(SEL_1, "dead")]],
    ["already withdrawn (a second undo)", [sel(SEL_1, "delivered"), wd(WD_1, "pending", SEL_1)]],
    ["already withdrawn and delivered", [sel(SEL_1, "delivered"), wd(WD_1, "delivered", SEL_1)]],
  ] as const)("a mark %s: nothing queued", async (_label, chain) => {
    const d = make({ chain: [...chain] });
    await expect(d.svc.recordUndo(markAt(), TX)).resolves.toBe("nothing_sent");
    expect(d.repo.insertSignal).not.toHaveBeenCalled();
  });

  it("the successor key is taken (a racing undo): duplicate, not a second row", async () => {
    const d = make({ chain: [sel(SEL_1, "delivered")], inserted: false });
    await expect(d.svc.recordUndo(markAt(), TX)).resolves.toBe("duplicate");
  });

  it("a hired mark's withdrawal is keyed on the hired chain", async () => {
    const d = make({ chain: [{ ...sel(SEL_1, "delivered"), kind: "applicant_hired" }] });
    await d.svc.recordUndo(markAt("hired"), TX);
    const arg = (d.repo.insertSignal.mock.calls[0] as unknown as [{ dedupeKey: string }])[0];
    expect(arg.dedupeKey).toBe(
      `${selectionDedupeKey("company_posting", POSTING, WORKER, "hired")}:after:${SEL_1}`,
    );
  });
});

describe("recordMark after #2771 — a re-mark", () => {
  it.each([
    ["the mark was withdrawn", [sel(SEL_1, "delivered"), wd(WD_1, "pending", SEL_1)], WD_1],
    ["its selection was cancelled", [sel(SEL_1, "cancelled")], SEL_1],
  ] as const)("%s: a fresh selection, after that row", async (_label, chain, after) => {
    const d = make({ chain: [...chain] });
    await expect(d.svc.recordMark(markAt(), TX)).resolves.toBe("queued");
    const arg = (
      d.repo.insertSignal.mock.calls[0] as unknown as [
        { dedupeKey: string; kind: string; payload: Record<string, unknown> },
      ]
    )[0];
    expect(arg.kind).toBe("applicant_selected");
    expect(arg.dedupeKey).toBe(`${FIRST_KEY}:after:${after}`);
    expect(arg.payload.after_signal_id).toBe(after);
  });

  it.each([
    ["pending", sel(SEL_1, "pending")],
    ["delivered", sel(SEL_1, "delivered")],
    ["dead (refused for good)", sel(SEL_1, "dead")],
  ] as const)("the chain ends in a %s selection: duplicate", async (_label, row) => {
    const d = make({ chain: [row] });
    await expect(d.svc.recordMark(markAt(), TX)).resolves.toBe("duplicate");
    expect(d.repo.insertSignal).not.toHaveBeenCalled();
  });
});

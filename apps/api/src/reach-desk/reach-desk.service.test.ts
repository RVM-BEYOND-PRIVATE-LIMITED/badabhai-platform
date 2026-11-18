import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ContactReachCaseRow } from "@badabhai/db";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import {
  CaseResolvedError,
  ReachDeskService,
  ReportWindowClosedError,
  withinReportWindow,
} from "./reach-desk.service";

/**
 * #2750 item 7 — the couldn't-reach guarantee and the worker desk: who may report and until when,
 * one case per open, the desk's three closes, the credit return lot by lot, and the deadline.
 */

const ACTOR = "a0000000-0000-4000-8000-000000000001";
const TENANT = "c0000000-0000-4000-8000-0000000000aa";
const UNLOCK = "u0000000-0000-4000-8000-000000000001";
const WORKER = "w0000000-0000-4000-8000-000000000001";
const ADMIN = "ad000000-0000-4000-8000-000000000001";
const CASE = "ca000000-0000-4000-8000-000000000001";
const CTX = { correlationId: "corr", requestId: "req" } as never;
const DAY = 86_400_000;

function caseRow(over: Partial<ContactReachCaseRow> = {}): ContactReachCaseRow {
  return {
    id: CASE,
    unlockId: UNLOCK,
    payerId: TENANT,
    workerId: WORKER,
    reportedBy: ACTOR,
    reportedAt: new Date("2026-11-17T06:00:00Z"),
    deadlineAt: new Date("2026-11-19T06:00:00Z"),
    status: "open",
    creditsReturned: 0,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByAdminId: null,
    ...over,
  };
}

interface Opts {
  state?: "on" | "off" | "unavailable";
  live?: boolean;
  liveForService?: boolean;
  unlock?: { id: string; workerId: string | null; status: string; grantedAt: Date | null } | null;
  held?: ContactReachCaseRow | undefined;
  locked?: ContactReachCaseRow | undefined;
  spent?: { lotId: string | null; credits: number; lotExpiresAt: Date | null }[];
  due?: string[];
  txError?: unknown;
}

function harness(opts: Opts = {}) {
  const tx = { tx: true };
  const repo = {
    withTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => {
      if (opts.txError) throw opts.txError;
      return work(tx);
    }),
    findOwnUnlock: vi.fn(async () =>
      opts.unlock === null
        ? undefined
        : (opts.unlock ?? {
            id: UNLOCK,
            workerId: WORKER,
            status: "granted",
            grantedAt: new Date("2026-11-15T06:00:00Z"),
          }),
    ),
    findCaseByUnlock: vi.fn(async () => opts.held),
    insertCase: vi.fn(async (_tx: unknown, r: { deadlineAt: Date }) =>
      caseRow({ deadlineAt: r.deadlineAt }),
    ),
    lockCase: vi.fn(async () => ("locked" in opts ? opts.locked : caseRow())),
    getCase: vi.fn(async () => opts.locked ?? caseRow()),
    listAttempts: vi.fn(async () => []),
    insertAttempt: vi.fn(async () => ({ id: "att-1" })),
    listCases: vi.fn(async () => []),
    dueCaseIds: vi.fn(async () => opts.due ?? []),
    spentFromLots: vi.fn(async () => opts.spent ?? []),
    returnCredits: vi.fn(async () => true),
    resolve: vi.fn(async (_tx: unknown, id: string, c: Record<string, unknown>) =>
      caseRow({
        id,
        status: c.status as ContactReachCaseRow["status"],
        creditsReturned: c.creditsReturned as number,
        resolvedAt: c.at as Date,
        resolvedBy: c.resolvedBy as "desk" | "deadline",
        resolvedByAdminId: c.adminId as string | null,
      }),
    ),
    audit: vi.fn(async () => undefined),
  };
  const creditRules = {
    get: vi.fn(async () => DEFAULT_CREDIT_RULES),
    assertLive: vi.fn(() => {
      if (opts.live === false) throw new NotFoundException();
    }),
  };
  const rollout = {
    stateFor: vi.fn(async () => opts.state ?? "on"),
    isLiveForServiceCaller: vi.fn(() => opts.liveForService ?? true),
  };
  const tenancy = { resolve: vi.fn(async () => ({ tenantKey: TENANT })) };
  const outcomes = { recordDeskOutcome: vi.fn(async () => null) };
  const events = { emit: vi.fn(async () => undefined) };
  const service = new ReachDeskService(
    repo as never,
    creditRules as never,
    rollout as never,
    tenancy as never,
    outcomes as never,
    events as never,
  );
  return { service, repo, events, outcomes, rollout, tx };
}

const eventNamed = (h: ReturnType<typeof harness>, name: string) =>
  h.events.emit.mock.calls
    .map((c) => (c as unknown[])[0] as Record<string, unknown>)
    .find((e) => e.event_name === name);

describe("the report window (B7-13)", () => {
  const rules = DEFAULT_CREDIT_RULES;
  const opened = new Date("2026-11-10T04:00:00Z"); // 09:30 IST on 10 Nov

  it("day 7 after the open (IST) is accepted, day 8 is refused", () => {
    expect(withinReportWindow(opened, new Date("2026-11-17T18:29:00Z"), rules)).toBe(true);
    expect(withinReportWindow(opened, new Date("2026-11-17T18:30:00Z"), rules)).toBe(false);
  });

  it("the same day and the next are accepted", () => {
    expect(withinReportWindow(opened, opened, rules)).toBe(true);
    expect(withinReportWindow(opened, new Date(opened.getTime() + DAY), rules)).toBe(true);
  });
});

describe("ReachDeskService.report — the company", () => {
  const now = new Date("2026-11-17T06:00:00Z");

  it("opens a case due 48 hours later, with its event on the same transaction", async () => {
    const h = harness();
    const out = await h.service.report(ACTOR, UNLOCK, CTX, now);
    expect(out).toMatchObject({
      case_id: CASE,
      unlock_id: UNLOCK,
      status: "open",
      deadline_at: "2026-11-19T06:00:00.000Z",
      credits_returned: 0,
    });
    expect(h.repo.insertCase).toHaveBeenCalledWith(h.tx, {
      unlockId: UNLOCK,
      tenant: TENANT,
      workerId: WORKER,
      reportedBy: ACTOR,
      deadlineAt: new Date("2026-11-19T06:00:00Z"),
    });
    expect(eventNamed(h, "payer.contact_reach_reported")).toMatchObject({
      actor: { actor_type: "payer", actor_id: ACTOR },
      payload: { case_id: CASE, unlock_id: UNLOCK, payer_id: TENANT },
      idempotencyKey: `payer.contact_reach_reported:${CASE}`,
      tx: h.tx,
    });
  });

  it("a second report answers the first case, nothing written", async () => {
    const h = harness({ held: caseRow() });
    expect(await h.service.report(ACTOR, UNLOCK, CTX, now)).toMatchObject({ case_id: CASE });
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("a report past the window is refused with REPORT_WINDOW_CLOSED, nothing written", async () => {
    const h = harness({
      unlock: { id: UNLOCK, workerId: WORKER, status: "granted", grantedAt: new Date(now.getTime() - 9 * DAY) },
    });
    await expect(h.service.report(ACTOR, UNLOCK, CTX, now)).rejects.toBeInstanceOf(
      ReportWindowClosedError,
    );
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["off for the company", { state: "off" as const }],
    ["a pilot list that cannot be read", { state: "unavailable" as const }],
    ["another company's open (or none)", { unlock: null }],
    ["a denied row, not a contact", { unlock: { id: UNLOCK, workerId: WORKER, status: "denied", grantedAt: null } }],
  ])("%s is the neutral 404", async (_label, o) => {
    const h = harness(o);
    await expect(h.service.report(ACTOR, UNLOCK, CTX, now)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("a missing table is a 503", async () => {
    const h = harness({ txError: Object.assign(new Error("no table"), { code: "42P01" }) });
    await expect(h.service.report(ACTOR, UNLOCK, CTX, now)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("the company reads its case; never reported is a 404", async () => {
    expect(await harness({ held: caseRow() }).service.getForPayer(ACTOR, UNLOCK)).toMatchObject({
      case_id: CASE,
    });
    await expect(harness().service.getForPayer(ACTOR, UNLOCK)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("ReachDeskService — the desk", () => {
  it("off everywhere: every desk call is a 404", async () => {
    const h = harness({ live: false });
    await expect(h.service.list({ status: "open", limit: 10 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(h.service.get(CASE)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.logAttempt(ADMIN, CASE, "no_answer")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      h.service.resolveByDesk(ADMIN, CASE, "not_reached", "reason", CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("logs an attempt with its audit row; a closed case takes none", async () => {
    const h = harness();
    await h.service.logAttempt(ADMIN, CASE, "switched_off");
    expect(h.repo.insertAttempt).toHaveBeenCalledWith(h.tx, {
      caseId: CASE,
      adminId: ADMIN,
      result: "switched_off",
    });
    expect(h.repo.audit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ action: "reach_case_attempt_logged", caseId: CASE }),
    );
    const closed = harness({ locked: caseRow({ status: "reached_declined" }) });
    await expect(closed.service.logAttempt(ADMIN, CASE, "busy")).rejects.toBeInstanceOf(
      CaseResolvedError,
    );
  });

  it.each(["reached_interested", "reached_declined"] as const)(
    "%s: closed by the desk, no credit back, no follow-up answer",
    async (outcome) => {
      const h = harness({ spent: [{ lotId: "lot-1", credits: 1, lotExpiresAt: null }] });
      await h.service.resolveByDesk(ADMIN, CASE, outcome, "Reached him on the second call", CTX);
      expect(h.repo.returnCredits).not.toHaveBeenCalled();
      expect(h.outcomes.recordDeskOutcome).not.toHaveBeenCalled();
      expect(h.repo.resolve).toHaveBeenCalledWith(
        h.tx,
        CASE,
        expect.objectContaining({ status: outcome, creditsReturned: 0, resolvedBy: "desk", adminId: ADMIN }),
      );
      expect(eventNamed(h, "payer.contact_reach_resolved")).toMatchObject({
        actor: { actor_type: "admin", actor_id: ADMIN },
        payload: { status: outcome, credits_returned: 0, resolved_by: "desk" },
      });
    },
  );

  it("not reached: each spent lot comes back with the right expiry, the follow-up says not_reached", async () => {
    const future = new Date(Date.now() + 20 * DAY);
    const past = new Date(Date.now() - DAY);
    const h = harness({
      spent: [
        { lotId: "lot-live", credits: 1, lotExpiresAt: future },
        { lotId: "lot-gone", credits: 1, lotExpiresAt: past },
        { lotId: "lot-forever", credits: 1, lotExpiresAt: null },
      ],
    });
    await h.service.resolveByDesk(ADMIN, CASE, "not_reached", "Number switched off all day", CTX);
    const calls = h.repo.returnCredits.mock.calls as unknown as [unknown, string, string, { lotId: string }, Date | null][];
    expect(calls.map((c) => [c[1], c[2], c[3].lotId])).toEqual([
      [TENANT, UNLOCK, "lot-live"],
      [TENANT, UNLOCK, "lot-gone"],
      [TENANT, UNLOCK, "lot-forever"],
    ]);
    // A live lot's own expiry; a gone lot's 30 days from now; a never-expiring lot never.
    expect(calls[0]![4]).toEqual(future);
    expect(Math.abs(calls[1]![4]!.getTime() - (Date.now() + 30 * DAY))).toBeLessThan(5_000);
    expect(calls[2]![4]).toBeNull();
    expect(h.outcomes.recordDeskOutcome).toHaveBeenCalledWith(
      UNLOCK,
      "not_reached",
      h.tx,
      expect.objectContaining({ actor: { actor_type: "admin", actor_id: ADMIN } }),
      expect.any(Date),
    );
    expect(eventNamed(h, "payer.contact_reach_resolved")).toMatchObject({
      payload: { status: "not_reached", credits_returned: 3, resolved_by: "desk" },
      idempotencyKey: `payer.contact_reach_resolved:${CASE}`,
    });
    expect(h.repo.audit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        action: "reach_case_resolved",
        metadata: expect.objectContaining({ outcome: "not_reached", credits_returned: 3 }),
      }),
    );
  });

  it("not reached on a free (waived) open returns nothing", async () => {
    const h = harness({ spent: [] });
    await h.service.resolveByDesk(ADMIN, CASE, "not_reached", "Number switched off all day", CTX);
    expect(h.repo.returnCredits).not.toHaveBeenCalled();
    expect(eventNamed(h, "payer.contact_reach_resolved")).toMatchObject({
      payload: { credits_returned: 0 },
    });
  });

  it("a closed case cannot be closed again: 409, nothing returned", async () => {
    const h = harness({ locked: caseRow({ status: "not_reached", resolvedAt: new Date(), resolvedBy: "deadline" }) });
    await expect(
      h.service.resolveByDesk(ADMIN, CASE, "not_reached", "Number switched off all day", CTX),
    ).rejects.toBeInstanceOf(CaseResolvedError);
    expect(h.repo.returnCredits).not.toHaveBeenCalled();
  });
});

describe("ReachDeskService.sweepDeadlines — nobody closed it in time", () => {
  const now = new Date("2026-11-20T06:00:00Z");

  it("off everywhere: reads nothing", async () => {
    const h = harness({ liveForService: false });
    expect(await h.service.sweepDeadlines(200, now)).toEqual({
      skipped: true,
      due: 0,
      closed: 0,
      failed: 0,
    });
    expect(h.repo.dueCaseIds).not.toHaveBeenCalled();
  });

  it("closes each due case as not reached by the deadline, credits back, as the system", async () => {
    const h = harness({ due: [CASE], spent: [{ lotId: "lot-1", credits: 2, lotExpiresAt: null }] });
    expect(await h.service.sweepDeadlines(200, now)).toEqual({
      skipped: false,
      due: 1,
      closed: 1,
      failed: 0,
    });
    expect(h.repo.resolve).toHaveBeenCalledWith(
      h.tx,
      CASE,
      expect.objectContaining({ status: "not_reached", resolvedBy: "deadline", adminId: null, creditsReturned: 2 }),
    );
    expect(eventNamed(h, "payer.contact_reach_resolved")).toMatchObject({
      actor: { actor_type: "system", actor_id: null },
      payload: { status: "not_reached", resolved_by: "deadline", credits_returned: 2 },
    });
  });

  it("a case closed meanwhile, or not yet due under the lock, is skipped", async () => {
    const h = harness({ due: [CASE], locked: caseRow({ deadlineAt: new Date(now.getTime() + 1000) }) });
    expect((await h.service.sweepDeadlines(200, now)).closed).toBe(0);
    expect(h.repo.resolve).not.toHaveBeenCalled();
  });

  it("one case failing is counted and the rest go on", async () => {
    const h = harness({ due: [CASE, "ca000000-0000-4000-8000-000000000002"] });
    h.repo.lockCase.mockRejectedValueOnce(new Error("deadlock")).mockResolvedValue(caseRow());
    expect(await h.service.sweepDeadlines(200, now)).toMatchObject({ due: 2, closed: 1, failed: 1 });
  });

  it("a missing table: logged, waited out", async () => {
    const h = harness();
    h.repo.dueCaseIds.mockRejectedValue(Object.assign(new Error("no table"), { code: "42P01" }));
    expect(await h.service.sweepDeadlines(200, now)).toMatchObject({ skipped: true });
  });
});

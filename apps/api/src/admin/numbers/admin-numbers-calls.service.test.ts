import { Logger } from "@nestjs/common";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import type { AdminEventsRepository } from "../admin-events.repository";
import type { AdminIdentityService } from "../admin-identity.service";
import type { RequestContext } from "../../common/request-context";
import type { EventsService } from "../../events/events.service";
import {
  AdminNumbersOutOfCreditsQuerySchema,
  AdminNumbersLogCreditCallSchema,
} from "./admin-numbers.dto";
import {
  AdminNumbersCallsService,
  CREDIT_CALL_KEY_REUSED,
  resetCallLogMissingWarningForTests,
} from "./admin-numbers-calls.service";
import type { LoggedCall, NumbersCallsRepository } from "./numbers-calls.repository";
import { callIdForKey, decodeOutOfCreditsCursor } from "./out-of-credits";

/**
 * #2755 item 8 — the call list and the call log over fakes: the list's order and paging, the
 * three facts beside each company, the name only through `AdminIdentityService` (absent without
 * it, the page clamped to 50 when it will carry names), no phone on any path, the missing call log
 * (`last_call: null` on the list, 503 on the POST), and the POST's idempotency, 404s and 409.
 */

afterEach(() => {
  vi.restoreAllMocks();
  resetCallLogMissingWarningForTests();
});

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const admin = (role: AuthenticatedAdmin["role"] = "ops_admin"): AuthenticatedAdmin => ({
  id: ADMIN_ID,
  role,
  sid: "s",
});
const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const query = (q: Record<string, unknown> = {}) => AdminNumbersOutOfCreditsQuerySchema.parse(q);

function setup(
  over: {
    zero?: Array<{ payerId: string; lastLotExpiryAt: Date | null }>;
    exhausted?: Map<string, Date>;
    permitted?: boolean;
    names?: Map<string, string | null> | null;
    calls?: Map<string, LoggedCall>;
    stored?: LoggedCall;
    countable?: boolean;
  } = {},
) {
  const repo = {
    zeroBalanceCompanies: vi.fn(async () => over.zero ?? []),
    lastPurchases: vi.fn(
      async (ids: readonly string[]) =>
        new Map(
          ids
            .slice(0, 1)
            .map((id) => [id, { at: new Date("2026-10-01T00:00:00Z"), packCode: "pack_50" }]),
        ),
    ),
    lastOpens: vi.fn(
      async (ids: readonly string[]) =>
        new Map(ids.slice(0, 1).map((id) => [id, new Date("2026-10-05T00:00:00Z")])),
    ),
    lastCalls: vi.fn(async () => over.calls ?? new Map()),
    countableCompanyExists: vi.fn(async () => over.countable ?? true),
    findCall: vi.fn(async () => over.stored),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ tx: true })),
    insertCall: vi.fn(
      async (
        _tx: unknown,
        input: { id: string; payerId: string; adminId: string; result: string },
      ) => ({
        id: input.id,
        payerId: input.payerId,
        calledByAdminId: input.adminId,
        calledAt: new Date("2026-11-17T10:00:00Z"),
        result: input.result,
      }),
    ),
  };
  const adminEvents = {
    latestPayerSubjectEventAt: vi.fn(async () => over.exhausted ?? new Map()),
  };
  const identity = {
    isPermitted: vi.fn(() => over.permitted ?? false),
    resolve: vi.fn(async () => (over.names === undefined ? null : over.names)),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const service = new AdminNumbersCallsService(
    repo as unknown as NumbersCallsRepository,
    adminEvents as unknown as AdminEventsRepository,
    identity as unknown as AdminIdentityService,
    events as unknown as EventsService,
  );
  return { repo, adminEvents, identity, events, service };
}

const ZERO = [
  { payerId: P(1), lastLotExpiryAt: null },
  { payerId: P(2), lastLotExpiryAt: new Date("2026-11-15T00:00:00Z") },
  { payerId: P(3), lastLotExpiryAt: null }, // never ran out
];
const EXHAUSTED = new Map([[P(1), new Date("2026-11-16T09:00:00Z")]]);

describe("GET /admin/numbers/out-of-credits", () => {
  it("lists the companies that ran out, newest first, each with its last purchase, open and call", async () => {
    const call: LoggedCall = {
      id: P(90),
      payerId: P(2),
      calledByAdminId: ADMIN_ID,
      calledAt: new Date("2026-11-16T12:00:00Z"),
      result: "no_answer",
    };
    const { service, adminEvents, repo } = setup({
      zero: ZERO,
      exhausted: EXHAUSTED,
      calls: new Map([[P(2), call]]),
    });
    const out = await service.outOfCredits(admin(), query(), CTX);
    expect(adminEvents.latestPayerSubjectEventAt).toHaveBeenCalledWith("payer.credits_exhausted", [
      P(1),
      P(2),
      P(3),
    ]);
    expect(out).toEqual({
      rows: [
        {
          payer_id: P(1),
          ran_out_at: "2026-11-16T09:00:00.000Z",
          last_purchase: { at: "2026-10-01T00:00:00.000Z", pack_code: "pack_50" },
          last_open_at: "2026-10-05T00:00:00.000Z",
          last_call: null,
        },
        {
          payer_id: P(2),
          ran_out_at: "2026-11-15T00:00:00.000Z",
          last_purchase: null,
          last_open_at: null,
          last_call: {
            called_at: "2026-11-16T12:00:00.000Z",
            result: "no_answer",
            admin_id: ADMIN_ID,
          },
        },
      ],
      next_cursor: null,
      accounts_link_hint: true,
    });
    // The page's facts are read for the page's companies only.
    expect(repo.lastPurchases).toHaveBeenCalledWith([P(1), P(2)]);
    expect(repo.lastCalls).toHaveBeenCalledWith([P(1), P(2)]);
  });

  it("NEVER carries a phone or any contact field, on any path", async () => {
    const { service } = setup({
      zero: ZERO,
      exhausted: EXHAUSTED,
      permitted: true,
      names: new Map([[P(1), "Acme Tools"]]),
    });
    const json = JSON.stringify(await service.outOfCredits(admin("super_admin"), query(), CTX));
    for (const field of ["phone", "email", "gstin", "address", "contact"]) {
      expect(json, field).not.toContain(field);
    }
  });

  it("pages by keyset: the cursor continues after the last row, and a malformed one is page one", async () => {
    const { service } = setup({ zero: ZERO, exhausted: EXHAUSTED });
    const first = await service.outOfCredits(admin(), query({ limit: "1" }), CTX);
    expect(first.rows.map((r) => r.payer_id)).toEqual([P(1)]);
    expect(decodeOutOfCreditsCursor(first.next_cursor!)).toEqual({
      ranOutAt: "2026-11-16T09:00:00.000Z",
      payerId: P(1),
    });
    const second = await service.outOfCredits(
      admin(),
      query({ limit: "1", cursor: first.next_cursor }),
      CTX,
    );
    expect(second.rows.map((r) => r.payer_id)).toEqual([P(2)]);
    expect(second.next_cursor).toBeNull();
    const garbage = await service.outOfCredits(admin(), query({ limit: "1", cursor: "x!" }), CTX);
    expect(garbage.rows.map((r) => r.payer_id)).toEqual([P(1)]);
  });

  describe("names (read_identity, through AdminIdentityService only)", () => {
    it("without read_identity: no org_name field at all, byte for byte faceless", async () => {
      const { service, identity } = setup({ zero: ZERO, exhausted: EXHAUSTED, names: null });
      const out = await service.outOfCredits(admin("ops_admin"), query(), CTX);
      for (const r of out.rows) expect(r).not.toHaveProperty("org_name");
      // The identity service is still the one that decides (it audits nothing for a refusal).
      expect(identity.resolve).toHaveBeenCalledWith(
        admin("ops_admin"),
        "payers",
        [P(1), P(2)],
        null,
        CTX,
      );
    });

    it("with it: each row's name from the audited read (null when none is on record)", async () => {
      const { service } = setup({
        zero: ZERO,
        exhausted: EXHAUSTED,
        permitted: true,
        names: new Map<string, string | null>([
          [P(1), "Acme Tools"],
          [P(2), null],
        ]),
      });
      const out = await service.outOfCredits(admin("super_admin"), query(), CTX);
      expect(out.rows.map((r) => [r.payer_id, r.org_name])).toEqual([
        [P(1), "Acme Tools"],
        [P(2), null],
      ]);
    });

    it("a page that will carry names is clamped to 50 BEFORE the read; a faceless one is not", async () => {
      const many = Array.from({ length: 80 }, (_, i) => ({
        payerId: P(i + 1),
        lastLotExpiryAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      }));
      const named = setup({ zero: many, permitted: true, names: new Map() });
      const page = await named.service.outOfCredits(
        admin("super_admin"),
        query({ limit: "100" }),
        CTX,
      );
      expect(page.rows).toHaveLength(50);
      expect(page.next_cursor).not.toBeNull();
      expect((named.identity.resolve.mock.calls[0] as unknown[])[2]).toHaveLength(50);
      const faceless = setup({ zero: many, permitted: false });
      const all = await faceless.service.outOfCredits(
        admin("ops_admin"),
        query({ limit: "100" }),
        CTX,
      );
      expect(all.rows).toHaveLength(80);
      expect(faceless.service.effectiveLimit(admin(), 30)).toBe(30);
    });

    it("an empty list asks for no names (nothing to disclose or audit)", async () => {
      const { service, identity } = setup({ zero: [], permitted: true });
      expect(await service.outOfCredits(admin("super_admin"), query(), CTX)).toEqual({
        rows: [],
        next_cursor: null,
        accounts_link_hint: true,
      });
      expect(identity.resolve).not.toHaveBeenCalled();
    });
  });

  it("the call log missing (42P01): every row last_call null, one warning per process, no 503", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, repo } = setup({ zero: ZERO, exhausted: EXHAUSTED });
    repo.lastCalls.mockRejectedValue(pgError("42P01"));
    const out = await service.outOfCredits(admin(), query(), CTX);
    expect(out.rows.map((r) => r.last_call)).toEqual([null, null]);
    await service.outOfCredits(admin(), query(), CTX);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("credit_call_log");
  });

  it("a missing SOURCE table (credit_lots) is a 503, and any other error is rethrown", async () => {
    const { service, repo } = setup();
    repo.zeroBalanceCompanies.mockRejectedValueOnce(pgError("42P01"));
    await expect(service.outOfCredits(admin(), query(), CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const boom = new Error("boom");
    repo.zeroBalanceCompanies.mockRejectedValueOnce(boom);
    await expect(service.outOfCredits(admin(), query(), CTX)).rejects.toBe(boom);
  });

  it("reads only: no insert, no event of its own", async () => {
    const { service, repo, events } = setup({ zero: ZERO, exhausted: EXHAUSTED });
    await service.outOfCredits(admin(), query(), CTX);
    expect(repo.insertCall).not.toHaveBeenCalled();
    expect(repo.withTransaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("POST /admin/numbers/out-of-credits/:payerId/calls", () => {
  const KEY = "call-key-0001";
  const dto = AdminNumbersLogCreditCallSchema.parse({ result: "reached_will_buy" });

  it("writes one row and, in its transaction, admin.credit_call_logged and admin.action_performed", async () => {
    const { service, repo, events } = setup();
    const out = await service.logCreditCall(admin(), P(1), dto, KEY, CTX);
    const id = callIdForKey(ADMIN_ID, KEY);
    expect(out).toEqual({
      call: {
        id,
        payer_id: P(1),
        called_at: "2026-11-17T10:00:00.000Z",
        result: "reached_will_buy",
        admin_id: ADMIN_ID,
      },
      created: true,
    });
    expect(repo.insertCall).toHaveBeenCalledWith(
      { tx: true },
      { id, payerId: P(1), adminId: ADMIN_ID, result: "reached_will_buy" },
    );
    const emitted = events.emit.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(emitted.map((e) => e.event_name)).toEqual([
      "admin.credit_call_logged",
      "admin.action_performed",
    ]);
    expect(emitted[0]).toMatchObject({
      payload: { payer_id: P(1), call_id: id, admin_id: ADMIN_ID, result: "reached_will_buy" },
      subject: { subject_type: "payer", subject_id: P(1) },
      idempotencyKey: `admin.credit_call_logged:${id}`,
      tx: { tx: true },
    });
    expect(emitted[1]).toMatchObject({
      payload: {
        admin_id: ADMIN_ID,
        action_code: "credit_call_logged",
        target_type: "payer",
        target_id: P(1),
      },
      tx: { tx: true },
    });
  });

  it("a RETRY with the same key is a replay: the stored row, created false, nothing written or emitted", async () => {
    const stored: LoggedCall = {
      id: callIdForKey(ADMIN_ID, KEY),
      payerId: P(1),
      calledByAdminId: ADMIN_ID,
      calledAt: new Date("2026-11-17T10:00:00Z"),
      result: "reached_will_buy",
    };
    const { service, repo, events } = setup({ stored });
    const out = await service.logCreditCall(admin(), P(1), dto, KEY, CTX);
    expect(out).toMatchObject({
      created: false,
      call: { id: stored.id, result: "reached_will_buy" },
    });
    expect(repo.insertCall).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("the same key for another company or another result is a 409, never a silent replay", async () => {
    const stored: LoggedCall = {
      id: callIdForKey(ADMIN_ID, KEY),
      payerId: P(1),
      calledByAdminId: ADMIN_ID,
      calledAt: new Date("2026-11-17T10:00:00Z"),
      result: "reached_will_buy",
    };
    for (const [payer, result] of [
      [P(2), "reached_will_buy"],
      [P(1), "no_answer"],
    ] as const) {
      const { service, repo } = setup({ stored });
      const err = await service
        .logCreditCall(admin(), payer, { result }, KEY, CTX)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        reason: CREDIT_CALL_KEY_REUSED,
      });
      expect(repo.insertCall).not.toHaveBeenCalled();
    }
  });

  it("a request racing its own retry answers as the replay once the other insert won", async () => {
    const { service, repo, events } = setup();
    const won: LoggedCall = {
      id: callIdForKey(ADMIN_ID, KEY),
      payerId: P(1),
      calledByAdminId: ADMIN_ID,
      calledAt: new Date("2026-11-17T10:00:00Z"),
      result: "reached_will_buy",
    };
    repo.findCall.mockResolvedValueOnce(undefined).mockResolvedValueOnce(won);
    repo.insertCall.mockResolvedValueOnce(undefined as never);
    expect(await service.logCreditCall(admin(), P(1), dto, KEY, CTX)).toMatchObject({
      created: false,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("an unknown, test or sample company is a 404 (nothing written)", async () => {
    const { service, repo } = setup({ countable: false });
    await expect(service.logCreditCall(admin(), P(1), dto, KEY, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.insertCall).not.toHaveBeenCalled();
  });

  it("a company deleted between the check and the insert (23503) is a 404", async () => {
    const { service, repo } = setup();
    repo.insertCall.mockRejectedValueOnce(pgError("23503"));
    await expect(service.logCreditCall(admin(), P(1), dto, KEY, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("the call log missing (42P01) is a 503: fail closed, nothing written", async () => {
    const { service, repo, events } = setup();
    repo.findCall.mockRejectedValueOnce(pgError("42P01"));
    await expect(service.logCreditCall(admin(), P(1), dto, KEY, CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(repo.insertCall).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("the body is STRICT and closed: one of the five codes, no free text", () => {
    for (const result of [
      "reached_will_buy",
      "reached_not_now",
      "reached_declined",
      "no_answer",
      "wrong_number",
    ]) {
      expect(AdminNumbersLogCreditCallSchema.safeParse({ result }).success, result).toBe(true);
    }
    for (const bad of [
      {},
      { result: "busy" },
      { result: "no_answer", note: "call back Monday" },
      { result: "no_answer", phone: "+919876543210" },
    ]) {
      expect(AdminNumbersLogCreditCallSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

describe("the list's query", () => {
  it("limit 1..100 (default 50), an opaque cursor, nothing else", () => {
    expect(AdminNumbersOutOfCreditsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(AdminNumbersOutOfCreditsQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    for (const bad of [{ limit: "0" }, { limit: "101" }, { limit: "x" }, { phone: "1" }]) {
      expect(AdminNumbersOutOfCreditsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});

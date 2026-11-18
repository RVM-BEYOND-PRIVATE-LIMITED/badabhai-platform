import { randomUUID } from "node:crypto";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { createEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../../common/request-context";
import { ADMIN_ACTION_CODES } from "../admin-action-codes";
import { ADMIN_FUNNEL_K_ANON_FLOOR } from "../admin-funnel.dto";
import type { TestAccountWrite } from "./admin-numbers.repository";
import { AdminNumbersService } from "./admin-numbers.service";
import { NUMBERS_METRIC_GROUPS } from "./definitions";
import { NUMBERS_DEFINITION_VERSION } from "./groups";

/**
 * #2755 — the numbers service with the database and the spine faked: the catalogue it serves, and
 * the mark / unmark contract (one transaction, one event per real change, nothing on a no-op, a
 * 404 for an unknown company, a 503 when the schema is behind).
 */

const TX = { tx: "the-one-transaction" } as never;
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `numbers-${randomUUID()}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };
const PAYER = randomUUID();
const KEY = "mark-key-0001";

function harness(
  write: TestAccountWrite | Error = "changed",
  config: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const repo = {
    withTransaction: vi.fn(async (work: (tx: never) => Promise<unknown>) => {
      calls.push("begin");
      const out = await work(TX);
      calls.push("commit");
      return out;
    }),
    setTestAccount: vi.fn(async (tx: unknown, _payerId: string, on: boolean) => {
      expect(tx).toBe(TX);
      calls.push(`set:${on}`);
      if (write instanceof Error) throw write;
      return write;
    }),
  };
  const emitted: Array<{
    event_name: string;
    payload: Record<string, unknown>;
    actor: Record<string, unknown>;
    tx: unknown;
    idempotencyKey?: string;
  }> = [];
  const events = {
    emit: vi.fn(
      async (params: {
        event_name: string;
        payload: Record<string, unknown>;
        actor: Record<string, unknown>;
        tx: unknown;
      }) => {
        calls.push(`emit:${params.event_name}`);
        emitted.push(params);
        // The real contract: the event is built and VALIDATED against the registry.
        return createEvent({
          event_name: params.event_name,
          actor: params.actor,
          subject: { subject_type: "payer", subject_id: PAYER },
          source: "api",
          correlation_id: CTX.correlationId,
          payload: params.payload,
          metadata: { environment: "test", service: "api" },
        } as never);
      },
    ),
  };
  const service = new AdminNumbersService(repo as never, events as never, config as never);
  return { service, repo, events, emitted, calls };
}

describe("definitions — the catalogue, as code holds it", () => {
  it("serves the version, the week rule, both group sets, the ten groups and the floor", () => {
    const { service, repo } = harness();
    const d = service.definitions();
    expect(d.definition_version).toBe(NUMBERS_DEFINITION_VERSION);
    expect(d.week).toMatchObject({
      time_zone: "Asia/Kolkata",
      utc_offset: "+05:30",
      starts_on: "monday",
    });
    expect(d.week.rule).toMatch(/Monday 00:00/);
    expect(d.cities.groups.map((g) => g.id)).toEqual([
      "all",
      "ncr",
      "pune",
      "ahmedabad",
      "other",
      "unknown",
    ]);
    expect(d.cities.groups.find((g) => g.id === "ncr")?.members).toContain("gurugram");
    expect(d.cities.groups.find((g) => g.id === "other")?.members).toEqual([]);
    expect(d.trades.groups.map((g) => g.id)).toEqual([
      "all",
      "cnc_operator",
      "cnc_cam_programmer",
      "sheet_metal",
      "cad_3d_designer",
      "other",
      "unknown",
    ]);
    expect(d.trades.groups.find((g) => g.id === "sheet_metal")).toMatchObject({
      role_kinds: ["sheet_metal_worker"],
      taxonomy_roles: [],
    });
    expect(d.metric_groups).toHaveLength(10);
    expect(d.metric_groups).toEqual(NUMBERS_METRIC_GROUPS);
    expect(d.small_cell_floor).toBe(ADMIN_FUNNEL_K_ANON_FLOOR);
    expect(d.exclusions.companies).toMatch(/is_test_account/);
    // A pure read of code: no table, no transaction.
    expect(repo.withTransaction).not.toHaveBeenCalled();
  });

  it("the payments posture travels in band: mock (with its reason) unless real payments are on", () => {
    expect(harness().service.definitions().payments).toEqual({
      mode: "mock",
      blocked_reason: "PAYMENTS_ENABLE_REAL is false",
    });
    // On but a secret missing is still mock, and says which name is missing (never a value).
    const half = harness("changed", { PAYMENTS_ENABLE_REAL: true }).service.definitions().payments;
    expect(half.mode).toBe("mock");
    expect(half.blocked_reason).toMatch(/is not set$/);
  });

  it("returns a copy: a caller mutating the answer cannot reach the constants", () => {
    const { service } = harness();
    const d = service.definitions();
    (d.metric_groups[0]!.metrics as unknown[]).length = 0;
    expect(NUMBERS_METRIC_GROUPS[0]!.metrics.length).toBeGreaterThan(0);
  });
});

describe("mark — PUT /admin/numbers/test-accounts/:payerId", () => {
  it("a real change: the row, the marked event and the admin action on ONE transaction", async () => {
    const { service, calls, emitted, repo } = harness("changed");
    const out = await service.markByAdmin(ADMIN, PAYER, { reason: "staff" }, KEY, CTX);
    expect(out).toEqual({ payer_id: PAYER, is_test_account: true, changed: true });
    expect(repo.setTestAccount).toHaveBeenCalledWith(TX, PAYER, true);
    expect(calls).toEqual([
      "begin",
      "set:true",
      "emit:admin.payer_test_account_marked",
      "emit:admin.action_performed",
      "commit",
    ]);
    expect(emitted[0]).toMatchObject({
      payload: { payer_id: PAYER, reason: "staff", admin_id: ADMIN.id },
      actor: { actor_type: "admin", actor_id: ADMIN.id },
      tx: TX,
      idempotencyKey: `admin.payer_test_account_marked:${PAYER}:${KEY}`,
    });
    expect(emitted[1]).toMatchObject({
      payload: {
        admin_id: ADMIN.id,
        action_code: ADMIN_ACTION_CODES.payer_test_account_marked,
        target_type: "payer",
        target_id: PAYER,
      },
      tx: TX,
    });
  });

  it("already marked: changed false, NOTHING emitted", async () => {
    const { service, emitted } = harness("unchanged");
    const out = await service.markByAdmin(ADMIN, PAYER, { reason: "rehearsal" }, KEY, CTX);
    expect(out).toEqual({ payer_id: PAYER, is_test_account: true, changed: false });
    expect(emitted).toEqual([]);
  });

  it("an unknown company is a 404, with nothing emitted", async () => {
    const { service, emitted } = harness("not_found");
    await expect(service.markByAdmin(ADMIN, PAYER, { reason: "staff" }, KEY, CTX)).rejects.toThrow(
      NotFoundException,
    );
    expect(emitted).toEqual([]);
  });

  it("the backfill marks with no admin: a system actor, admin_id null, no admin action", async () => {
    const { service, emitted } = harness("changed");
    const out = await service.mark(
      PAYER,
      "synthetic_sign_in",
      { kind: "backfill" },
      "run-key-1",
      CTX,
    );
    expect(out.changed).toBe(true);
    expect(emitted.map((e) => e.event_name)).toEqual(["admin.payer_test_account_marked"]);
    expect(emitted[0]).toMatchObject({
      payload: { payer_id: PAYER, reason: "synthetic_sign_in", admin_id: null },
      actor: { actor_type: "system", actor_id: null },
    });
  });

  it("a failing emit fails the write (the transaction rolls back with it)", async () => {
    const { service, events, calls } = harness("changed");
    events.emit.mockRejectedValueOnce(new Error("spine down"));
    await expect(service.markByAdmin(ADMIN, PAYER, { reason: "staff" }, KEY, CTX)).rejects.toThrow(
      "spine down",
    );
    expect(calls).not.toContain("commit");
  });

  it("FAILS CLOSED with a 503 when the schema is behind (42703 / 42P01), on err or err.cause", async () => {
    for (const code of ["42703", "42P01"]) {
      const direct = Object.assign(new Error("missing"), { code });
      await expect(
        harness(direct).service.markByAdmin(ADMIN, PAYER, { reason: "staff" }, KEY, CTX),
      ).rejects.toThrow(ServiceUnavailableException);
      const wrapped = Object.assign(new Error("query failed"), { cause: { code } });
      await expect(
        harness(wrapped).service.markByAdmin(ADMIN, PAYER, { reason: "staff" }, KEY, CTX),
      ).rejects.toThrow(ServiceUnavailableException);
    }
    // Any other failure is rethrown as it is.
    await expect(
      harness(new Error("boom")).service.markByAdmin(ADMIN, PAYER, { reason: "staff" }, KEY, CTX),
    ).rejects.toThrow("boom");
  });
});

describe("unmark — DELETE /admin/numbers/test-accounts/:payerId", () => {
  it("a real change: the row, the unmarked event and the admin action on ONE transaction", async () => {
    const { service, calls, emitted, repo } = harness("changed");
    const out = await service.unmarkByAdmin(ADMIN, PAYER, CTX);
    expect(out).toEqual({ payer_id: PAYER, is_test_account: false, changed: true });
    expect(repo.setTestAccount).toHaveBeenCalledWith(TX, PAYER, false);
    expect(calls).toEqual([
      "begin",
      "set:false",
      "emit:admin.payer_test_account_unmarked",
      "emit:admin.action_performed",
      "commit",
    ]);
    expect(emitted[0]!.payload).toEqual({ payer_id: PAYER, admin_id: ADMIN.id });
    expect(emitted[1]!.payload).toMatchObject({
      action_code: ADMIN_ACTION_CODES.payer_test_account_unmarked,
    });
  });

  it("not marked: changed false, nothing emitted; unknown company: 404", async () => {
    const quiet = harness("unchanged");
    expect(await quiet.service.unmarkByAdmin(ADMIN, PAYER, CTX)).toEqual({
      payer_id: PAYER,
      is_test_account: false,
      changed: false,
    });
    expect(quiet.emitted).toEqual([]);
    await expect(harness("not_found").service.unmarkByAdmin(ADMIN, PAYER, CTX)).rejects.toThrow(
      NotFoundException,
    );
  });
});

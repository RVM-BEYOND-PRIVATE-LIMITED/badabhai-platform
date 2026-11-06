import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import {
  AdminIdentityService,
  ADMIN_CANDIDATES_IDENTITY_MAX_SUBJECTS,
  ADMIN_IDENTITY_MAX_SUBJECTS,
} from "./admin-identity.service";
import type { AdminIdentityCapService } from "./admin-identity-cap.service";
import type { AdminCandidatesIdentityCapService } from "./admin-candidates-identity-cap.service";
import type { AdminIdentityRepository, AdminIdentityRow } from "./admin-identity.repository";

const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const W1 = "11111111-0000-4000-8000-000000000001";

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: ADMIN_ID, role, sid: "s" });

/** First positional arg of the first mock call, typed for assertions. */
function firstArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (mock.mock.calls[0] as unknown as Array<Record<string, unknown>>)[0]!;
}

/** Event names across all mock calls, typed for assertions. */
function eventNames(mock: { mock: { calls: unknown[][] } }): string[] {
  return (mock.mock.calls as unknown as Array<[{ event_name: string }]>).map((c) => c[0].event_name);
}

function harness(opts: {
  rows?: AdminIdentityRow[];
  entityCap?: { ok: true } | { ok: false; window: "hour" | "day" };
  candidatesCap?: { ok: true } | { ok: false; window: "hour" | "day" };
  dayUsage?: number | null;
  marked?: boolean;
} = {}) {
  const rows = opts.rows ?? [{ id: W1, nameCipher: "v1.cipher-a" }];
  const workerNames = vi.fn(async () => rows);
  const entityConsume = vi.fn(async () => opts.entityCap ?? { ok: true as const });
  const candidatesConsume = vi.fn(async () => opts.candidatesCap ?? { ok: true as const });
  const dayUsage = vi.fn(async () => opts.dayUsage ?? 0);
  const markBudgetAlerted = vi.fn(async () => opts.marked ?? false);
  const emit = vi.fn(async () => undefined);
  const decrypt = vi.fn((token: string) => `plain(${token})`);
  const config = {
    ADMIN_CANDIDATES_IDENTITY_MAX_PER_DAY: 10000,
  } as never;
  const svc = new AdminIdentityService(
    { workerNames } as unknown as AdminIdentityRepository,
    { consume: entityConsume } as unknown as AdminIdentityCapService,
    { decrypt } as unknown as PiiCryptoService,
    { emit } as unknown as EventsService,
    { consume: candidatesConsume, dayUsage, markBudgetAlerted } as unknown as AdminCandidatesIdentityCapService,
    config,
  );
  return { svc, emit, entityConsume, candidatesConsume, dayUsage, markBudgetAlerted, workerNames };
}

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `0000000${i}-0000-4000-8000-00000000000${i}`);
}

describe("candidates surface — own bound, own budget (ADR-0062 §3.7, #2559/B5)", () => {
  it("resolves names and charges the CANDIDATES cap, never the entity cap", async () => {
    const h = harness();
    const names = await h.svc.resolve(admin("support"), "candidates", [W1], null, CTX);
    expect(names?.get(W1)).toBe("plain(v1.cipher-a)");
    expect(h.candidatesConsume).toHaveBeenCalledTimes(1);
    expect(h.candidatesConsume).toHaveBeenCalledWith(ADMIN_ID, 1);
    expect(h.entityConsume).not.toHaveBeenCalled();
  });

  it("audits with surface=candidates", async () => {
    const h = harness();
    await h.svc.resolve(admin("support"), "candidates", [W1], null, CTX);
    expect(h.emit).toHaveBeenCalledTimes(1);
    const call = firstArg(h.emit) as { payload: Record<string, unknown> };
    expect(call.payload.surface).toBe("candidates");
  });

  it("allows 100 subjects but not 101 (per-surface bound, not the entity 50)", async () => {
    expect(ADMIN_CANDIDATES_IDENTITY_MAX_SUBJECTS).toBe(100);
    expect(ADMIN_IDENTITY_MAX_SUBJECTS).toBe(50);
    const ok = harness({ rows: [] });
    await expect(
      ok.svc.resolve(admin("support"), "candidates", ids(100), null, CTX),
    ).resolves.not.toBeNull();
    const over = harness({ rows: [] });
    await expect(
      over.svc.resolve(admin("support"), "candidates", ids(101), null, CTX),
    ).resolves.toBeNull();
    expect(over.candidatesConsume).not.toHaveBeenCalled();
    expect(over.emit).not.toHaveBeenCalled();
    // ...while the workers surface still stops at 50.
    const workers = harness({ rows: [] });
    await expect(
      workers.svc.resolve(admin("support"), "workers", ids(51), null, CTX),
    ).resolves.toBeNull();
  });

  it("DENIES analyst on candidates too — silently, spending neither budget", async () => {
    const h = harness();
    await expect(
      h.svc.resolve(admin("analyst"), "candidates", [W1], null, CTX),
    ).resolves.toBeNull();
    expect(h.workerNames).not.toHaveBeenCalled();
    expect(h.candidatesConsume).not.toHaveBeenCalled();
    expect(h.entityConsume).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("withholds names on a tripped Candidates budget (entity budget untouched)", async () => {
    const h = harness({ candidatesCap: { ok: false, window: "day" } });
    await expect(
      h.svc.resolve(admin("support"), "candidates", [W1], null, CTX),
    ).resolves.toBeNull();
    expect(h.entityConsume).not.toHaveBeenCalled();
  });
});

describe("candidates 50%-of-daily alert (ADR-0062 §3.7)", () => {
  it("emits admin.candidates_name_budget_alert once at ≥50% of the daily budget", async () => {
    const h = harness({ dayUsage: 5000, marked: true });
    await h.svc.resolve(admin("support"), "candidates", [W1], null, CTX);
    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(eventNames(h.emit)).toContain("admin.candidates_name_budget_alert");
    type EmitCall = { event_name: string; payload: Record<string, unknown> };
    const calls = h.emit.mock.calls as unknown as Array<[EmitCall]>;
    const call = calls.find((c) => c[0].event_name === "admin.candidates_name_budget_alert")![0];
    expect(call.payload).toMatchObject({ admin_id: ADMIN_ID, window: "day", threshold_percent: 50 });
  });

  it("stays silent below 50%, on repeat hits, and on unknown usage", async () => {
    const low = harness({ dayUsage: 4999, marked: true });
    await low.svc.resolve(admin("support"), "candidates", [W1], null, CTX);
    expect(eventNames(low.emit)).not.toContain("admin.candidates_name_budget_alert");

    const repeat = harness({ dayUsage: 9000, marked: false });
    await repeat.svc.resolve(admin("support"), "candidates", [W1], null, CTX);
    expect(eventNames(repeat.emit)).not.toContain("admin.candidates_name_budget_alert");

    const unknown = harness({ dayUsage: null, marked: true });
    await unknown.svc.resolve(admin("support"), "candidates", [W1], null, CTX);
    expect(eventNames(unknown.emit)).not.toContain("admin.candidates_name_budget_alert");
  });
});

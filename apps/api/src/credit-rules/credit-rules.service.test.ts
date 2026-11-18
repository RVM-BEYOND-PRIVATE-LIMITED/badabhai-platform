import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DEFAULT_CREDIT_RULES, type CreditRules } from "@badabhai/pricing";
import type { CreditRulesConfigRow } from "@badabhai/db";
import { CreditRulesService } from "./credit-rules.service";
import type { CreditRulesRepository } from "./credit-rules.repository";

const ctx = { correlationId: "c0000000-0000-4000-8000-000000000001", requestId: "r-1" } as never;
const ADMIN = "a0000000-0000-4000-8000-000000000001";
const ROW_ID = "f0000000-0000-4000-8000-000000000001";
const REASON = "Akshit set the higher cost to three credits for the pilot";

function row(rules: unknown, revision = 1): CreditRulesConfigRow {
  return {
    id: ROW_ID,
    rules,
    revision,
    isActive: true,
    updatedBy: ADMIN,
    createdAt: new Date("2026-11-17T08:00:00Z"),
  };
}

function pgError(code: string): Error {
  return Object.assign(new Error("db"), { code });
}

function harness(opts: { live?: boolean } = {}) {
  const repo = {
    getActive: vi.fn<CreditRulesRepository["getActive"]>(async () => undefined),
    publish: vi.fn<CreditRulesRepository["publish"]>(),
  };
  const emitted: unknown[] = [];
  const events = { emit: vi.fn(async (e: unknown) => emitted.push(e)) };
  const rollout = { isLiveForServiceCaller: vi.fn(() => opts.live ?? true) };
  const service = new CreditRulesService(repo as never, events as never, rollout as never);
  return { service, repo, events, emitted, rollout };
}

describe("reading the rules", () => {
  it("no row: the brief's defaults, revision 0, source default", async () => {
    const { service } = harness();
    expect(await service.getActive()).toEqual({
      rules: DEFAULT_CREDIT_RULES,
      revision: 0,
      source: "default",
      updatedAt: null,
    });
  });

  it("a valid row is served with its revision", async () => {
    const { service, repo } = harness();
    repo.getActive.mockResolvedValue(row({ ...DEFAULT_CREDIT_RULES, higherCost: 3 }, 4));
    const active = await service.getActive();
    expect(active.rules.higherCost).toBe(3);
    expect(active.revision).toBe(4);
    expect(active.source).toBe("db");
  });

  it("an invalid row fails closed WHOLE to the defaults, keeping its revision", async () => {
    const { service, repo } = harness();
    repo.getActive.mockResolvedValue(row({ ...DEFAULT_CREDIT_RULES, standardCost: 0 }, 2));
    const active = await service.getActive();
    expect(active.rules).toBe(DEFAULT_CREDIT_RULES);
    expect(active.source).toBe("default");
    expect(active.revision).toBe(2);
  });

  it("a missing table (switch ahead of the migration) reads as no row for a consumer", async () => {
    const { service, repo } = harness();
    repo.getActive.mockRejectedValue(pgError("42P01"));
    expect(await service.get()).toBe(DEFAULT_CREDIT_RULES);
  });

  it("any other read failure still serves the defaults to a consumer, never throws", async () => {
    const { service, repo } = harness();
    repo.getActive.mockRejectedValue(pgError("08006"));
    expect(await service.get()).toBe(DEFAULT_CREDIT_RULES);
  });

  it("caches a load, and invalidate() forces the next read", async () => {
    const { service, repo } = harness();
    await service.get();
    await service.get();
    expect(repo.getActive).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.get();
    expect(repo.getActive).toHaveBeenCalledTimes(2);
  });

  it("concurrent cold reads share one query", async () => {
    const { service, repo } = harness();
    await Promise.all([service.get(), service.get(), service.get()]);
    expect(repo.getActive).toHaveBeenCalledTimes(1);
  });

  it("the admin read is fresh (never the cache) and a missing table is a 503", async () => {
    const { service, repo } = harness();
    await service.get();
    await service.readForAdmin();
    expect(repo.getActive).toHaveBeenCalledTimes(2);
    repo.getActive.mockRejectedValue(pgError("42P01"));
    await expect(service.readForAdmin()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("the switch", () => {
  it("assertLive is a 404 while the credit_rules switch is off everywhere", () => {
    const { service, rollout } = harness({ live: false });
    expect(() => service.assertLive()).toThrow(NotFoundException);
    expect(rollout.isLiveForServiceCaller).toHaveBeenCalledWith("credit_rules");
  });

  it("passes in pilot or on", () => {
    const { service } = harness({ live: true });
    expect(() => service.assertLive()).not.toThrow();
  });
});

describe("editing the rules", () => {
  const edited: CreditRules = { ...DEFAULT_CREDIT_RULES, higherCost: 3, higherCostMinMonths: 48 };

  function publishes(h: ReturnType<typeof harness>, revision = 1) {
    h.repo.publish.mockImplementation(async (input, afterWrite) => {
      const written = row(input.rules, revision);
      await afterWrite({} as never, written);
      return { outcome: "published", row: written };
    });
  }

  it("writes revision 1 over the defaults, with the audit row and one value-free event", async () => {
    const h = harness();
    publishes(h);
    const result = await h.service.update(
      ADMIN,
      { rules: edited, expectedRevision: 0, reasonText: REASON },
      ctx,
    );
    expect(result.changed).toBe(true);
    expect(result.changedKeys).toEqual(["higherCost", "higherCostMinMonths"]);
    expect(result.revision).toBe(1);

    const input = h.repo.publish.mock.calls[0]![0];
    expect(input.expectedRevision).toBe(0);
    expect(input.adminId).toBe(ADMIN);
    expect(input.audit).toEqual({
      action: "credit_rules_changed",
      metadata: {
        revision: 1,
        changed_keys: ["higherCost", "higherCostMinMonths"],
        before: { higherCost: 2, higherCostMinMonths: 36 },
        after: { higherCost: 3, higherCostMinMonths: 48 },
        reason_text: REASON,
      },
    });

    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0] as Record<string, unknown>;
    expect(event.event_name).toBe("admin.action_performed");
    expect(event.payload).toEqual({
      admin_id: ADMIN,
      action_code: "credit_rules_changed",
      target_type: "credit_rules_config",
      target_id: ROW_ID,
    });
    expect(event.subject).toEqual({ subject_type: "credit_rules_config", subject_id: ROW_ID });
    // On the revision's transaction, so the event commits or rolls back with it.
    expect(event.tx).toBeDefined();
    // No value rides the spine.
    expect(JSON.stringify(event.payload)).not.toContain("48");
  });

  it("drops the cache, so the next read on this process sees the new revision", async () => {
    const h = harness();
    await h.service.get();
    publishes(h);
    await h.service.update(ADMIN, { rules: edited, expectedRevision: 0, reasonText: REASON }, ctx);
    h.repo.getActive.mockResolvedValue(row(edited, 1));
    expect((await h.service.get()).higherCost).toBe(3);
  });

  it("a stale expected_revision is 409 and nothing is written", async () => {
    const h = harness();
    h.repo.getActive.mockResolvedValue(row(DEFAULT_CREDIT_RULES, 3));
    await expect(
      h.service.update(ADMIN, { rules: edited, expectedRevision: 2, reasonText: REASON }, ctx),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.repo.publish).not.toHaveBeenCalled();
  });

  it("losing the race inside the transaction is the same 409", async () => {
    const h = harness();
    h.repo.publish.mockResolvedValue({ outcome: "stale" });
    await expect(
      h.service.update(ADMIN, { rules: edited, expectedRevision: 0, reasonText: REASON }, ctx),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("two saves of one revision: the revision index's 23505 is the same 409", async () => {
    const h = harness();
    h.repo.publish.mockRejectedValue(pgError("23505"));
    await expect(
      h.service.update(ADMIN, { rules: edited, expectedRevision: 0, reasonText: REASON }, ctx),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("an edit that changes nothing writes nothing", async () => {
    const h = harness();
    const result = await h.service.update(
      ADMIN,
      { rules: { ...DEFAULT_CREDIT_RULES }, expectedRevision: 0, reasonText: REASON },
      ctx,
    );
    expect(result.changed).toBe(false);
    expect(result.changedKeys).toEqual([]);
    expect(h.repo.publish).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it("a value the stored-row schema refuses is never written", async () => {
    const h = harness();
    await expect(
      h.service.update(
        ADMIN,
        {
          rules: { ...DEFAULT_CREDIT_RULES, standardCost: 3, higherCost: 2 },
          expectedRevision: 0,
          reasonText: REASON,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.repo.publish).not.toHaveBeenCalled();
  });

  it("a missing table on edit is a 503", async () => {
    const h = harness();
    h.repo.getActive.mockRejectedValue(pgError("42P01"));
    await expect(
      h.service.update(ADMIN, { rules: edited, expectedRevision: 0, reasonText: REASON }, ctx),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

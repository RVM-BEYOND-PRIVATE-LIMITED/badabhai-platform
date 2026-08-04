import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AdminEntitiesService } from "./admin-entities.service";
import type { AdminEntitiesRepository } from "./admin-entities.repository";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";

/**
 * The service owns exactly one thing — keyset paging — so that is what this file tests, hard.
 *
 * Paging bugs are the quiet kind: an off-by-one at a page boundary silently drops a row from
 * an operations list, and nothing anywhere reports an error. The operator just never sees that
 * worker.
 */

function repoStub(overrides: Partial<AdminEntitiesRepository> = {}): AdminEntitiesRepository {
  return {
    listWorkers: vi.fn(async () => []),
    findWorker: vi.fn(async () => undefined),
    listPayers: vi.fn(async () => []),
    findPayer: vi.fn(async () => undefined),
    listJobPostings: vi.fn(async () => []),
    findJobPosting: vi.fn(async () => undefined),
    listApplications: vi.fn(async () => []),
    getCreditBalance: vi.fn(async () => 0),
    listCreditLedger: vi.fn(async () => []),
    ...overrides,
  } as unknown as AdminEntitiesRepository;
}

/** `n` rows with strictly decreasing timestamps, newest first — the real list ordering. */
function rows(n: number, base = Date.parse("2026-08-04T12:00:00Z")) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    created_at: new Date(base - i * 1000),
  }));
}

describe("keyset paging — the page boundary", () => {
  it("over-fetches by exactly one: a page of N asks the repository for N+1", async () => {
    const listWorkers = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listWorkers } as never));
    await svc.listWorkers({ limit: 25 } as never);
    expect(listWorkers).toHaveBeenCalledWith(expect.anything(), null, 26);
  });

  it("returns exactly `limit` items and a cursor when a further row exists", async () => {
    const svc = new AdminEntitiesService(
      repoStub({ listWorkers: vi.fn(async () => rows(6)) } as never),
    );
    const page = await svc.listWorkers({ limit: 5 } as never);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    // The cursor points at the LAST RETURNED row (index 4), never at the peeked 6th — pointing
    // at the peeked row would skip it on the next page.
    expect(decodeEntityCursor(page.nextCursor!)).toEqual({
      createdAt: rows(6)[4]!.created_at.toISOString(),
      id: "id-4",
    });
  });

  it("a FULL last page reports nextCursor null — no phantom empty page", async () => {
    // The bug this pins: deriving "there is more" from `items.length === limit` shows a Next
    // button whenever the total is an exact multiple of the page size, and the operator lands
    // on an empty screen that reads like data loss.
    const svc = new AdminEntitiesService(
      repoStub({ listWorkers: vi.fn(async () => rows(5)) } as never),
    );
    const page = await svc.listWorkers({ limit: 5 } as never);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("an empty result is an empty page, not a cursor to nowhere", async () => {
    const svc = new AdminEntitiesService(repoStub());
    const page = await svc.listWorkers({ limit: 10 } as never);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("passes a decoded cursor through to the repository", async () => {
    const listPayers = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listPayers } as never));
    const cursor = encodeEntityCursor({ createdAt: "2026-08-04T12:00:00.000Z", id: "x" });
    await svc.listPayers({ limit: 10, cursor } as never);
    expect(listPayers).toHaveBeenCalledWith(
      expect.anything(),
      { createdAt: "2026-08-04T12:00:00.000Z", id: "x" },
      11,
    );
  });

  it("a GARBAGE cursor is treated as the first page, never as an error", async () => {
    const listPayers = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listPayers } as never));
    await svc.listPayers({ limit: 10, cursor: "not-a-real-cursor" } as never);
    expect(listPayers).toHaveBeenCalledWith(expect.anything(), null, 11);
  });
});

describe("filters reach the repository verbatim", () => {
  it("worker filters (status + pendingDeletion) are forwarded", async () => {
    const listWorkers = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listWorkers } as never));
    await svc.listWorkers({ limit: 10, status: "suspended", pendingDeletion: true } as never);
    expect(listWorkers).toHaveBeenCalledWith(
      { status: "suspended", pendingDeletion: true },
      null,
      11,
    );
  });

  it("payer role is forwarded — it is what splits Companies from Agencies", async () => {
    const listPayers = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listPayers } as never));
    await svc.listPayers({ limit: 10, role: "agent" } as never);
    expect(listPayers).toHaveBeenCalledWith({ role: "agent", status: undefined }, null, 11);
  });

  it("job-posting filters are forwarded", async () => {
    const listJobPostings = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listJobPostings } as never));
    await svc.listJobPostings({
      limit: 10,
      status: "open",
      verificationStatus: "unverified",
      payerId: "p1",
    } as never);
    expect(listJobPostings).toHaveBeenCalledWith(
      { status: "open", verificationStatus: "unverified", payerId: "p1" },
      null,
      11,
    );
  });
});

describe("a missing entity is 404, never an empty-shaped 200", () => {
  it("getWorker throws NotFound", async () => {
    const svc = new AdminEntitiesService(repoStub());
    await expect(svc.getWorker("missing")).rejects.toThrow(NotFoundException);
  });

  it("getPayer throws NotFound", async () => {
    const svc = new AdminEntitiesService(repoStub());
    await expect(svc.getPayer("missing")).rejects.toThrow(NotFoundException);
  });

  it("getJobPosting throws NotFound", async () => {
    const svc = new AdminEntitiesService(repoStub());
    await expect(svc.getJobPosting("missing")).rejects.toThrow(NotFoundException);
  });
});

describe("credits — balance and ledger travel together", () => {
  it("returns the balance alongside a paged ledger", async () => {
    const svc = new AdminEntitiesService(
      repoStub({
        getCreditBalance: vi.fn(async () => 42),
        listCreditLedger: vi.fn(async () => rows(3)),
      } as never),
    );
    const view = await svc.getCredits("payer-1", { limit: 10 } as never);
    expect(view).toMatchObject({ payer_id: "payer-1", balance: 42 });
    expect(view.ledger.items).toHaveLength(3);
    expect(view.ledger.nextCursor).toBeNull();
  });

  it("a payer with NO credits row reads 0 — a real zero, not an unavailable state", async () => {
    const svc = new AdminEntitiesService(repoStub());
    const view = await svc.getCredits("payer-1", { limit: 10 } as never);
    expect(view.balance).toBe(0);
  });

  it("the ledger page is scoped to the requested payer", async () => {
    const listCreditLedger = vi.fn(async () => []);
    const svc = new AdminEntitiesService(repoStub({ listCreditLedger } as never));
    await svc.getCredits("payer-9", { limit: 10 } as never);
    expect(listCreditLedger).toHaveBeenCalledWith("payer-9", null, 11);
  });
});

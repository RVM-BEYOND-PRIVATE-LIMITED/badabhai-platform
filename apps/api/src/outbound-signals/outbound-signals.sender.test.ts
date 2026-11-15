import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RvmStudentApiUnavailableError } from "../campus-link/rvm-student-api.client";
import {
  backoffMs,
  OUTBOUND_BATCH_LIMIT,
  OUTBOUND_LEASE_MS,
  OUTBOUND_MAX_ATTEMPTS,
  OutboundSignalsSender,
} from "./outbound-signals.sender";
import type { ClaimedSignal, SelectionSendContext } from "./outbound-signals.repository";

/**
 * #2747 item 8 — the sweep that sends each queued mark to RVM once, with back-off and a dead-letter
 * state. The repository is a fake (its SQL runs on Postgres in outbound-signals.db.test.ts); the
 * client is a fake (its HTTP contract is pinned in rvm-student-api.client.test.ts).
 */

const NOW = new Date("2026-11-15T10:00:00.000Z");
const SIGNAL = "7b0f4f64-8a2b-4e0c-9d2e-1f3a4b5c6d7e";
const WORKER = "33333333-3333-4333-8333-000000000001";
const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const STUDENT_REF = "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718";
const COMPANY = "Sharma Precision Works";

function claimed(over: Partial<ClaimedSignal> = {}): ClaimedSignal {
  return {
    id: SIGNAL,
    kind: "applicant_selected",
    workerId: WORKER,
    payload: {
      posting_kind: "company_posting",
      posting_id: POSTING,
      worker_id: WORKER,
      stage: "selected",
      marked_on: "2026-11-15",
    },
    attempts: 0,
    ...over,
  };
}

function make(
  over: {
    armed?: boolean;
    rows?: ClaimedSignal[];
    context?: Partial<SelectionSendContext>;
    post?: () => Promise<unknown>;
    decrypt?: (enc: string) => string;
  } = {},
) {
  const repo = {
    claimDue: vi.fn(async () => over.rows ?? [claimed()]),
    selectionContext: vi.fn(
      async (): Promise<SelectionSendContext> => ({
        studentRef: STUDENT_REF,
        jobTitle: "CNC Operator",
        companyNameEnc: "enc:company",
        ...over.context,
      }),
    ),
    markDelivered: vi.fn(async () => undefined),
    markRetry: vi.fn(async () => undefined),
    markFinal: vi.fn(async () => undefined),
  };
  const rvm = { postSelectionEvent: vi.fn(over.post ?? (async () => ({ kind: "accepted" }))) };
  const pii = { decrypt: vi.fn(over.decrypt ?? (() => COMPANY)) };
  const rollout = { isLiveForServiceCaller: vi.fn(() => over.armed ?? true) };
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
  const sender = new OutboundSignalsSender(
    repo as never,
    rvm as never,
    pii as never,
    rollout as never,
    queue as never,
    () => NOW,
  );
  return { sender, repo, rvm, pii, rollout, queue };
}

describe("the switch", () => {
  it("off everywhere: the tick claims nothing and sends nothing (queued rows wait)", async () => {
    const d = make({ armed: false });
    await expect(d.sender.process()).resolves.toMatchObject({ armed: false, claimed: 0 });
    expect(d.rollout.isLiveForServiceCaller).toHaveBeenCalledWith("outbound_signals");
    expect(d.repo.claimDue).not.toHaveBeenCalled();
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
  });

  it("registers one repeatable tick, idempotently, and a registration failure never fails boot", async () => {
    const d = make();
    await d.sender.onApplicationBootstrap();
    expect(d.queue.upsertJobScheduler).toHaveBeenCalledWith("outbound-signals-sweep", {
      every: 60_000,
    });
    d.queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(d.sender.onApplicationBootstrap()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("a claimed row", () => {
  it("claims a bounded batch with a lease, builds the body at send time and marks it delivered", async () => {
    const d = make();
    const out = await d.sender.process();
    expect(out).toEqual({
      armed: true,
      claimed: 1,
      delivered: 1,
      retried: 0,
      dead: 0,
      cancelled: 0,
    });
    expect(d.repo.claimDue).toHaveBeenCalledWith(
      NOW,
      new Date(NOW.getTime() + OUTBOUND_LEASE_MS),
      OUTBOUND_BATCH_LIMIT,
    );
    expect(d.repo.selectionContext).toHaveBeenCalledWith(WORKER, "company_posting", POSTING);
    expect(d.pii.decrypt).toHaveBeenCalledWith("enc:company");
    expect(d.rvm.postSelectionEvent).toHaveBeenCalledWith({
      event_id: SIGNAL,
      student_ref: STUDENT_REF,
      company: COMPANY,
      job_title: "CNC Operator",
      status: "selected",
      date: "2026-11-15",
    });
    expect(d.repo.markDelivered).toHaveBeenCalledWith(SIGNAL, NOW);
  });

  it("a hired mark says hired", async () => {
    const d = make({
      rows: [
        claimed({
          kind: "applicant_hired",
          payload: { ...(claimed().payload as object), stage: "hired" },
        }),
      ],
    });
    await d.sender.process();
    expect(d.rvm.postSelectionEvent.mock.calls[0]![0 as never]).toMatchObject({ status: "hired" });
  });

  it("his link ended before it went: cancelled, and NOTHING leaves", async () => {
    const d = make({ context: { studentRef: null } });
    await expect(d.sender.process()).resolves.toMatchObject({ cancelled: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
    expect(d.pii.decrypt).not.toHaveBeenCalled();
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "cancelled", "link_inactive", NOW, false);
  });

  it.each([
    ["the posting is gone", { jobTitle: null }],
    ["the owner company is gone", { companyNameEnc: null }],
    ["the title is blank", { jobTitle: "   " }],
  ])("%s: dead (context_missing), nothing sent", async (_c, context) => {
    const d = make({ context });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "context_missing", NOW, false);
  });

  it("the company name cannot be decrypted: dead, nothing sent", async () => {
    const d = make({
      decrypt: () => {
        throw new Error("bad token");
      },
    });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["an off-contract payload", claimed({ payload: { stage: "shortlist" } })],
    [
      "a payload naming another worker",
      claimed({ workerId: "33333333-3333-4333-8333-0000000000ff" }),
    ],
  ])("%s: dead (contract), never guessed at", async (_c, row) => {
    const d = make({ rows: [row] });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.selectionContext).not.toHaveBeenCalled();
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "contract", NOW, false);
  });

  it("long names are capped at the contract's 200 characters", async () => {
    const d = make({ context: { jobTitle: "T".repeat(500) }, decrypt: () => "C".repeat(500) });
    await d.sender.process();
    const body = d.rvm.postSelectionEvent.mock.calls[0]![0 as never] as unknown as {
      company: string;
      job_title: string;
    };
    expect(body.company).toHaveLength(200);
    expect(body.job_title).toHaveLength(200);
  });
});

describe("RVM's answer", () => {
  it("not_available (no consent, not linked on RVM's side): dead, one attempt counted", async () => {
    const d = make({ post: async () => ({ kind: "not_available" }) });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "not_available", NOW, true);
  });

  it("a refusal no retry can change: dead (rejected), logged with the signal id and status only", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const d = make({ post: async () => ({ kind: "rejected", status: 422 }) });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "rejected", NOW, true);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain(SIGNAL);
    expect(line).toContain("422");
    expect(line).not.toContain(COMPANY);
    expect(line).not.toContain(STUDENT_REF);
    expect(line).not.toContain(WORKER);
    warn.mockRestore();
  });

  it.each(["timeout", "network", "http_status", "not_configured"] as const)(
    "an outage (%s): retried after the back-off, the failure code recorded",
    async (failure) => {
      const d = make({
        post: async () => {
          throw new RvmStudentApiUnavailableError(failure);
        },
      });
      await expect(d.sender.process()).resolves.toMatchObject({ retried: 1 });
      expect(d.repo.markRetry).toHaveBeenCalledWith(
        SIGNAL,
        failure,
        new Date(NOW.getTime() + backoffMs(1)),
        NOW,
      );
    },
  );

  it("the last allowed attempt fails: dead, with the outage's code", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const d = make({
      rows: [claimed({ attempts: OUTBOUND_MAX_ATTEMPTS - 1 })],
      post: async () => {
        throw new RvmStudentApiUnavailableError("timeout");
      },
    });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "timeout", NOW, true);
    expect(d.repo.markRetry).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an unexpected error on one row is recorded on that row and the batch goes on", async () => {
    const second = "8c1f5f75-9b3c-4f1d-8e3f-2a4b5c6d7e8f";
    let calls = 0;
    const d = make({
      rows: [claimed(), claimed({ id: second })],
      post: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { kind: "accepted" };
      },
    });
    await expect(d.sender.process()).resolves.toMatchObject({
      claimed: 2,
      retried: 1,
      delivered: 1,
    });
    expect(d.repo.markRetry).toHaveBeenCalledWith(SIGNAL, "contract", expect.any(Date), NOW);
    expect(d.repo.markDelivered).toHaveBeenCalledWith(second, NOW);
  });
});

describe("backoffMs", () => {
  it("1, 2, 4 … minutes, capped at six hours", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(30)).toBe(6 * 3_600_000);
  });

  it("gives up after about a day and a half of waiting", () => {
    let total = 0;
    for (let a = 1; a < OUTBOUND_MAX_ATTEMPTS; a += 1) total += backoffMs(a);
    expect(total).toBeGreaterThan(24 * 3_600_000);
    expect(total).toBeLessThan(48 * 3_600_000);
  });
});

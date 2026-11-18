import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RvmStudentApiUnavailableError } from "../campus-link/rvm-student-api.client";
import {
  backoffMs,
  capped,
  leaseMs,
  OUTBOUND_BATCH_LIMIT,
  OUTBOUND_MAX_ATTEMPTS,
  OUTBOUND_MIN_LEASE_MS,
  OutboundSignalsSender,
} from "./outbound-signals.sender";
import type { ClaimedSignal, SelectionSendContext } from "./outbound-signals.repository";

/**
 * #2747 item 8 — the sweep that sends each queued mark to RVM once, with back-off and a dead-letter
 * state, and only while the mark is still true. The repository is a fake (its SQL runs on Postgres
 * in outbound-signals.db.test.ts); the client is a fake (its HTTP contract is pinned in
 * rvm-student-api.client.test.ts).
 */

const NOW = new Date("2026-11-15T10:00:00.000Z");
const SIGNAL = "7b0f4f64-8a2b-4e0c-9d2e-1f3a4b5c6d7e";
const WORKER = "33333333-3333-4333-8333-000000000001";
const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const STUDENT_REF = "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718";
const LABEL = "Sharma Precision Works";
const TIMEOUT_MS = 5_000;

/** A row as the claim returns it: the claim has already counted this attempt. */
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
    attempts: 1,
    ...over,
  };
}

function make(
  over: {
    armed?: boolean;
    configured?: boolean;
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
        companyLabel: LABEL,
        companyNameEnc: null,
        currentStage: "selected",
        workerActive: true,
        ...over.context,
      }),
    ),
    markDelivered: vi.fn(async () => undefined),
    markRetry: vi.fn(async () => undefined),
    markFinal: vi.fn(async () => undefined),
  };
  const rvm = {
    postSelectionEvent: vi.fn(
      over.post ?? (async (_body: Record<string, unknown>) => ({ kind: "accepted" })),
    ),
    isConfigured: vi.fn(() => over.configured ?? true),
    timeoutMs: TIMEOUT_MS,
  };
  const pii = { decrypt: vi.fn(over.decrypt ?? (() => "Agency Owner Pvt Ltd")) };
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
  const sent = () => rvm.postSelectionEvent.mock.calls.map((c) => c[0 as never] as unknown);
  return { sender, repo, rvm, pii, rollout, queue, sent };
}

describe("when it runs", () => {
  it("the switch off everywhere: claims nothing, sends nothing (queued rows wait)", async () => {
    const d = make({ armed: false });
    await expect(d.sender.process()).resolves.toMatchObject({ armed: false, claimed: 0 });
    expect(d.rollout.isLiveForServiceCaller).toHaveBeenCalledWith("outbound_signals");
    expect(d.repo.claimDue).not.toHaveBeenCalled();
  });

  it("RVM's settings missing: claims nothing, so no attempt is spent before they arrive", async () => {
    const d = make({ configured: false });
    await expect(d.sender.process()).resolves.toMatchObject({ configured: false, claimed: 0 });
    expect(d.repo.claimDue).not.toHaveBeenCalled();
  });

  it("registers one repeatable tick, idempotently; a registration failure never fails boot", async () => {
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

  it("claims a bounded batch with a lease that outlasts the slowest batch, and the attempt cap", async () => {
    const d = make();
    await d.sender.process();
    expect(d.repo.claimDue).toHaveBeenCalledWith(
      NOW,
      new Date(NOW.getTime() + leaseMs(TIMEOUT_MS)),
      OUTBOUND_BATCH_LIMIT,
      OUTBOUND_MAX_ATTEMPTS,
    );
  });
});

describe("a claimed row that is still true", () => {
  it("a company posting: sends its own label (the name Campus shows), no decrypt, and is delivered", async () => {
    const d = make();
    await expect(d.sender.process()).resolves.toEqual({
      armed: true,
      configured: true,
      claimed: 1,
      delivered: 1,
      retried: 0,
      dead: 0,
      cancelled: 0,
    });
    expect(d.repo.selectionContext).toHaveBeenCalledWith(WORKER, "company_posting", POSTING);
    expect(d.pii.decrypt).not.toHaveBeenCalled();
    expect(d.sent()).toEqual([
      {
        event_id: SIGNAL,
        student_ref: STUDENT_REF,
        company: LABEL,
        job_title: "CNC Operator",
        status: "selected",
        date: "2026-11-15",
      },
    ]);
    expect(d.repo.markDelivered).toHaveBeenCalledWith(SIGNAL, NOW);
  });

  it("an agency job: the owner account's name, decrypted only here", async () => {
    const d = make({ context: { companyLabel: null, companyNameEnc: "enc:owner" } });
    await d.sender.process();
    expect(d.pii.decrypt).toHaveBeenCalledWith("enc:owner");
    expect(d.sent()[0]).toMatchObject({ company: "Agency Owner Pvt Ltd" });
  });

  it("a hired mark says hired; a selected mark still goes when he has since been hired", async () => {
    const hired = make({
      rows: [
        claimed({
          kind: "applicant_hired",
          payload: { ...(claimed().payload as object), stage: "hired" },
        }),
      ],
      context: { currentStage: "hired" },
    });
    await hired.sender.process();
    expect(hired.sent()[0]).toMatchObject({ status: "hired" });

    const selected = make({ context: { currentStage: "hired" } });
    await expect(selected.sender.process()).resolves.toMatchObject({ delivered: 1 });
  });

  it("long names are capped at the contract's 200 UTF-16 units, never splitting a character", async () => {
    const d = make({ context: { jobTitle: "T".repeat(500), companyLabel: "😀".repeat(150) } });
    await expect(d.sender.process()).resolves.toMatchObject({ delivered: 1 });
    const body = d.sent()[0] as { company: string; job_title: string };
    expect(body.job_title).toHaveLength(200);
    expect(body.company).toHaveLength(200); // 100 emoji × 2 units
    expect(capped("a😀", 2)).toBe("a"); // the pair would not fit: dropped whole
  });
});

describe("a claimed row that is no longer true — nothing leaves", () => {
  it.each([
    ["the mark was undone (moved back to Shortlist)", { currentStage: "shortlist" }, "mark_undone"],
    ["the board row is gone (moved back to New)", { currentStage: null }, "mark_undone"],
    ["he is suspended or scheduled for deletion", { workerActive: false }, "worker_inactive"],
    ["his RVM link ended", { studentRef: null }, "link_inactive"],
  ] as const)("%s: cancelled (%s)", async (_c, context, failure) => {
    const d = make({ context });
    await expect(d.sender.process()).resolves.toMatchObject({ cancelled: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
    expect(d.pii.decrypt).not.toHaveBeenCalled();
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "cancelled", failure, NOW);
  });

  it("a hired mark undone to selected: the hired signal is cancelled", async () => {
    const d = make({
      rows: [claimed({ payload: { ...(claimed().payload as object), stage: "hired" } })],
      context: { currentStage: "selected" },
    });
    await expect(d.sender.process()).resolves.toMatchObject({ cancelled: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["the posting is gone", { jobTitle: null }],
    ["the company is gone", { companyLabel: null, companyNameEnc: null }],
    ["the title is blank", { jobTitle: "   " }],
  ])("%s: dead (context_missing)", async (_c, context) => {
    const d = make({ context });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "context_missing", NOW);
  });

  it("the agency owner's name cannot be decrypted: dead, nothing sent", async () => {
    const d = make({
      context: { companyLabel: null, companyNameEnc: "enc:broken" },
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
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "contract", NOW);
  });

  it("a body the contract refuses is dead at once (contract), not retried 14 times", async () => {
    const d = make({ context: { studentRef: "not-a-uuid" } });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.rvm.postSelectionEvent).not.toHaveBeenCalled();
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "contract", NOW);
  });
});

describe("RVM's answer", () => {
  it("not_available (RVM will not take it for this student): dead", async () => {
    const d = make({ post: async () => ({ kind: "not_available" }) });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "not_available", NOW);
  });

  it("a refusal no retry can change: dead (rejected), logged with the signal id and status only", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const d = make({ post: async () => ({ kind: "rejected", status: 422 }) });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "rejected", NOW);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain(SIGNAL);
    expect(line).toContain("422");
    for (const secret of [LABEL, STUDENT_REF, WORKER]) expect(line).not.toContain(secret);
    warn.mockRestore();
  });

  it.each(["timeout", "network", "http_status", "not_configured"] as const)(
    "an outage (%s): retried after the back-off for this attempt, the code recorded",
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
      rows: [claimed({ attempts: OUTBOUND_MAX_ATTEMPTS })],
      post: async () => {
        throw new RvmStudentApiUnavailableError("timeout");
      },
    });
    await expect(d.sender.process()).resolves.toMatchObject({ dead: 1 });
    expect(d.repo.markFinal).toHaveBeenCalledWith(SIGNAL, "dead", "timeout", NOW);
    expect(d.repo.markRetry).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a read failure while building: retried (network), logged by error class only", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const d = make();
    d.repo.selectionContext.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(d.sender.process()).resolves.toMatchObject({ retried: 1 });
    expect(d.repo.markRetry).toHaveBeenCalledWith(SIGNAL, "network", expect.any(Date), NOW);
    expect(String(warn.mock.calls[0]![0])).toContain("TypeError");
    expect(String(warn.mock.calls[0]![0])).not.toContain("connection reset");
    warn.mockRestore();
  });

  it("an unexpected send error on one row is recorded on that row and the batch goes on", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
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
    warn.mockRestore();
  });
});

describe("backoffMs and leaseMs", () => {
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

  it("the lease covers a whole batch timing out, and is never under five minutes", () => {
    expect(leaseMs(5_000)).toBe(OUTBOUND_MIN_LEASE_MS);
    expect(leaseMs(60_000)).toBe(OUTBOUND_BATCH_LIMIT * 60_000 + 60_000);
  });
});

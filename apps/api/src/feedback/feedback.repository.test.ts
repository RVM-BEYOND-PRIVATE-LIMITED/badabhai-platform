import { describe, it, expect, vi } from "vitest";
import { FeedbackRepository } from "./feedback.repository";
import { RedactedQueryError } from "../common/db-error";

/**
 * The worker's words, written the way a real complaint arrives: their own name, their own phone
 * number and their employer, because the product invites them to say anything.
 */
const MESSAGE = "Mera naam Ramesh Kumar hai, number 98765 43210, Acme Steel supervisor cuts wages";

/**
 * A `db` stub whose insert rejects the way drizzle really does — with the bound parameters inside
 * the error's own message. Reproducing that shape is the point of the test: a stub that threw a
 * clean `Error` would pass no matter what the repository did.
 */
function dbThatFailsInsert(cause?: unknown) {
  const query =
    'insert into "worker_feedback" ("worker_id","category","message","app_build") ' +
    "values ($1,$2,$3,$4) returning *";
  const params = ["worker-uuid", "problem", MESSAGE, "1.4.2+318"];
  const err = new Error(`Failed query: ${query}\nparams: ${params}`);
  Object.assign(err, { query, params, cause });
  return {
    insert: () => ({ values: () => ({ returning: () => Promise.reject(err) }) }),
  } as never;
}

const INPUT = {
  workerId: "worker-uuid",
  category: "problem" as const,
  message: MESSAGE,
  appBuild: "1.4.2+318",
};

describe("FeedbackRepository.insert — a failed write must not carry the words out", () => {
  it("redacts the bound parameters when the driver rejects", async () => {
    const repo = new FeedbackRepository(dbThatFailsInsert({ code: "57014" }));

    const err = await repo.insert(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedactedQueryError);
    const e = err as RedactedQueryError;
    // The whole point: neither the message nor the stack can reach a log with the words in it.
    // `AllExceptionsFilter` logs `exception.stack` verbatim for every 5xx.
    expect(e.message).not.toContain(MESSAGE);
    expect(e.stack ?? "").not.toContain(MESSAGE);
    expect(e.message).not.toContain("98765");
    expect(e.message).not.toContain("Ramesh");
    // …while still saying what failed and why.
    expect(e.message).toContain("worker feedback insert");
    expect(e.code).toBe("57014");
  });

  it("redacts on the apply-before-deploy failure too — the one that hits EVERY submission", async () => {
    // Migration 0079 is apply-before-deploy. Ship the API first and `worker_feedback` does not
    // exist, so every worker's message takes this path at once — the highest-volume version of
    // the leak, not an edge case.
    const repo = new FeedbackRepository(dbThatFailsInsert({ code: "42P01" }));

    const err = (await repo.insert(INPUT).catch((e: unknown) => e)) as RedactedQueryError;

    expect(err.code).toBe("42P01");
    expect(`${err.message}${err.stack ?? ""}`).not.toContain(MESSAGE);
  });

  it("still returns the stored row on the happy path", async () => {
    const row = { id: "fb-1", ...INPUT, createdAt: new Date() };
    const db = {
      insert: () => ({ values: () => ({ returning: async () => [row] }) }),
    } as never;

    await expect(new FeedbackRepository(db).insert(INPUT)).resolves.toBe(row);
  });

  it("treats an empty returning() as a programming error, not a redacted query error", async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
    } as never;

    const err = await new FeedbackRepository(db).insert(INPUT).catch((e: unknown) => e as Error);

    expect(err).not.toBeInstanceOf(RedactedQueryError);
    expect((err as Error).message).toBe("Failed to insert worker feedback");
  });

  it("passes the transaction executor through instead of the pooled connection", async () => {
    const pooled = { insert: vi.fn() } as never;
    const row = { id: "fb-2", ...INPUT, createdAt: new Date() };
    const txInsert = vi.fn(() => ({ values: () => ({ returning: async () => [row] }) }));
    const tx = { insert: txInsert } as never;

    await new FeedbackRepository(pooled).insert(INPUT, tx);

    expect(txInsert).toHaveBeenCalledOnce();
    expect(
      (pooled as unknown as { insert: ReturnType<typeof vi.fn> }).insert,
    ).not.toHaveBeenCalled();
  });
});

import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpStatus, Logger } from "@nestjs/common";
import {
  WorkerAccountDeletedException,
  WorkerAccountSuspendedException,
  WORKER_ACCOUNT_DELETED_CODE,
  WORKER_ACCOUNT_SUSPENDED_CODE,
  isWorkerSuspended,
  throwIfWorkerDeleted,
  type WorkerExistenceProbe,
  type WorkerStatusProbe,
} from "./worker-account-deleted.exception";

const WORKER_ID = "11111111-2222-3333-4444-555555555555";

function makeLogger() {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

function probe(result: boolean | { throws: Error }): WorkerExistenceProbe {
  return {
    existsById:
      typeof result === "boolean"
        ? vi.fn().mockResolvedValue(result)
        : vi.fn().mockRejectedValue(result.throws),
  };
}

function statusProbe(
  status: "pending" | "active" | "suspended" | { throws: Error },
): WorkerStatusProbe {
  return {
    findSelfView:
      typeof status === "string"
        ? vi.fn().mockResolvedValue({ status, deletionScheduledAt: null })
        : vi.fn().mockRejectedValue(status.throws),
  };
}

describe("WorkerAccountDeletedException", () => {
  it("is a 410 carrying the reserved machine-readable code", () => {
    const err = new WorkerAccountDeletedException();
    expect(err.getStatus()).toBe(HttpStatus.GONE);
    expect(err.getResponse()).toEqual({
      code: WORKER_ACCOUNT_DELETED_CODE,
      message: expect.any(String),
    });
  });

  // The client keys on this exact literal to hard-logout; changing it silently breaks the app.
  it("pins the wire code literal", () => {
    expect(WORKER_ACCOUNT_DELETED_CODE).toBe("WORKER_ACCOUNT_DELETED");
  });

  it("carries no PII in its message (§2) — no id, phone, or name", () => {
    const body = new WorkerAccountDeletedException().getResponse() as { message: string };
    expect(body.message).not.toMatch(/\d{10}|\+91|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe("throwIfWorkerDeleted", () => {
  it("row PRESENT ⇒ resolves, throws nothing", async () => {
    const { logger, warn } = makeLogger();
    await expect(throwIfWorkerDeleted(probe(true), WORKER_ID, logger)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("row DEFINITIVELY absent ⇒ throws the reserved 410", async () => {
    const { logger, warn } = makeLogger();
    const err = await throwIfWorkerDeleted(probe(false), WORKER_ID, logger).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkerAccountDeletedException);
    expect((err as WorkerAccountDeletedException).getStatus()).toBe(HttpStatus.GONE);
    // An absent row is a definitive answer, not a degradation — nothing to warn about.
    expect(warn).not.toHaveBeenCalled();
  });

  // The whole point of the fail-safe: a Postgres incident must not 410-storm every worker route.
  it("probe ERROR ⇒ treated as PRESENT, resolves instead of throwing", async () => {
    const { logger } = makeLogger();
    await expect(
      throwIfWorkerDeleted(probe({ throws: new Error("pg down") }), WORKER_ID, logger),
    ).resolves.toBeUndefined();
  });

  it("probe ERROR is LOGGED, so a persistently failing probe is never silent", async () => {
    const { logger, warn } = makeLogger();
    await throwIfWorkerDeleted(probe({ throws: new TypeError("boom") }), WORKER_ID, logger);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("TypeError");
  });

  // §2: the degraded-path log runs on the hot auth path — it must never leak the worker id or
  // the driver message (which can carry query text and bound parameter values).
  it("the degraded-path log leaks NO PII — error name only, never the id or message", async () => {
    const { logger, warn } = makeLogger();
    const secret = "SELECT * FROM workers WHERE phone='+919876543210'";
    await throwIfWorkerDeleted(probe({ throws: new Error(secret) }), WORKER_ID, logger);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).not.toContain(WORKER_ID);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("9876543210");
    expect(line).toContain("Error");
  });

  it("a non-Error rejection still degrades safely and logs", async () => {
    const { logger, warn } = makeLogger();
    const weird = { existsById: vi.fn().mockRejectedValue("just a string") };
    await expect(throwIfWorkerDeleted(weird, WORKER_ID, logger)).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain("unknown error");
  });
});

describe("#2562 WorkerAccountSuspendedException", () => {
  it("is a 403 carrying the closed machine-readable code", () => {
    const err = new WorkerAccountSuspendedException();
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toEqual({
      code: WORKER_ACCOUNT_SUSPENDED_CODE,
      message: expect.any(String),
    });
    expect(WORKER_ACCOUNT_SUSPENDED_CODE).toBe("WORKER_ACCOUNT_SUSPENDED");
  });

  it("carries no PII in its message (§2)", () => {
    const body = new WorkerAccountSuspendedException().getResponse() as { message: string };
    expect(body.message).not.toMatch(/\d{10}|\+91|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe("#2562 isWorkerSuspended", () => {
  it("active/pending are NOT suspended", async () => {
    const { logger } = makeLogger();
    expect(await isWorkerSuspended(statusProbe("active"), WORKER_ID, logger)).toBe(false);
    expect(await isWorkerSuspended(statusProbe("pending"), WORKER_ID, logger)).toBe(false);
  });

  it("suspended IS suspended", async () => {
    const { logger } = makeLogger();
    expect(await isWorkerSuspended(statusProbe("suspended"), WORKER_ID, logger)).toBe(true);
  });

  it("probe ERROR fails OPEN and logs the error NAME only", async () => {
    const { logger, warn } = makeLogger();
    const secret = "SELECT * FROM workers WHERE phone='+919876543210'";
    expect(
      await isWorkerSuspended(statusProbe({ throws: new Error(secret) }), WORKER_ID, logger),
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("Error");
    expect(line).not.toContain(WORKER_ID);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("9876543210");
  });
});

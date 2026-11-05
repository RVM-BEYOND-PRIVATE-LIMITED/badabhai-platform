import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { HttpStatus } from "@nestjs/common";
import {
  WorkerAccountDeletedException,
  WorkerAccountSuspendedException,
  WORKER_ACCOUNT_DELETED_CODE,
  WORKER_ACCOUNT_SUSPENDED_CODE,
} from "./worker-account-deleted.exception";

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

  it("adds the restricted DPDP token to the SAME 403 body when one is issued", () => {
    const err = new WorkerAccountSuspendedException({
      token: "restricted.jwt",
      expiresInSeconds: 900,
    });
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.getResponse()).toEqual({
      code: WORKER_ACCOUNT_SUSPENDED_CODE,
      message: expect.any(String),
      restricted_token: "restricted.jwt",
      restricted_expires_in_seconds: 900,
    });
  });
});

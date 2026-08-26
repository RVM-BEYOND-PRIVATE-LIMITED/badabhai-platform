import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { HttpStatus } from "@nestjs/common";
import {
  PayerAccountDeletedException,
  PAYER_ACCOUNT_DELETED_CODE,
} from "./payer-account-deleted.exception";

describe("PayerAccountDeletedException", () => {
  it("is a 410 carrying the reserved machine-readable code", () => {
    const err = new PayerAccountDeletedException();
    expect(err.getStatus()).toBe(HttpStatus.GONE);
    expect(err.getResponse()).toEqual({
      code: PAYER_ACCOUNT_DELETED_CODE,
      message: expect.any(String),
    });
  });

  // The SHIPPED payer client keys on this exact literal to wipe storage and hard-logout
  // (`apps/payer-app/lib/core/auth/payer_account_deleted_signal.dart`
  // `kPayerAccountDeletedCode`). Changing it silently turns every real deletion back into the
  // 401 re-auth loop this exception exists to end, with nothing failing anywhere.
  it("pins the wire code literal", () => {
    expect(PAYER_ACCOUNT_DELETED_CODE).toBe("PAYER_ACCOUNT_DELETED");
  });

  // Distinct from the worker code ON PURPOSE — a payer token and a worker token are different
  // principals (different Redis namespace, different JWT `typ`), and each app hard-logs-out on
  // its own signal only. One shared literal would let either client act on the other's event.
  it("does NOT collide with the worker-side code", () => {
    expect(PAYER_ACCOUNT_DELETED_CODE).not.toBe("WORKER_ACCOUNT_DELETED");
  });

  it("carries no PII in its message (§2) — no email, phone, org name, or id", () => {
    const body = new PayerAccountDeletedException().getResponse() as { message: string };
    expect(body.message).not.toMatch(/\d{10}|\+91|@|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  // The envelope the client parses is produced by `AllExceptionsFilter`, which nests
  // `getResponse()` under `error` verbatim. Asserting the payload is a PLAIN OBJECT with
  // exactly these two keys is what makes `body.error.code` reachable on the real wire — a
  // string payload would be re-wrapped as `{ message }` and lose the code entirely.
  it("exposes the payload as a plain {code, message} object the filter can nest", () => {
    const payload = new PayerAccountDeletedException().getResponse();
    expect(typeof payload).toBe("object");
    expect(Object.keys(payload as object).sort()).toEqual(["code", "message"]);
  });
});

import { describe, it, expect } from "vitest";
import { RedactedQueryError, redactQueryParams } from "./db-error";

/**
 * The exact shape `drizzle-orm` throws: a `DrizzleQueryError` whose own message embeds the bound
 * parameters. Reproduced rather than imported, because the class is not on drizzle's public export
 * surface — and reproducing it is what proves the duck-typed match in `db-error.ts` still fires.
 */
function drizzleQueryError(query: string, params: unknown[], cause?: unknown): Error {
  const err = new Error(`Failed query: ${query}\nparams: ${params}`);
  Object.assign(err, { query, params, cause });
  return err;
}

const MESSAGE = "My name is Ramesh Kumar, my number is 98765 43210, my supervisor skims wages";
const QUERY =
  'insert into "worker_feedback" ("worker_id","category","message","app_build") ' +
  "values ($1,$2,$3,$4) returning *";

describe("redactQueryParams — the bound-parameter privacy boundary", () => {
  it("removes the worker's words from the message AND the stack", () => {
    const raw = drizzleQueryError(QUERY, ["w-1", "problem", MESSAGE, "1.4.2+318"], {
      code: "57014",
    });
    // Guard: the assertion below is only meaningful because the raw error DOES leak.
    expect(raw.message).toContain(MESSAGE);

    const safe = redactQueryParams(raw, "worker feedback insert") as Error;

    expect(safe.message).not.toContain(MESSAGE);
    expect(safe.stack ?? "").not.toContain(MESSAGE);
    // …and nothing else from the row rides along either.
    expect(safe.message).not.toContain("98765");
    expect(safe.message).not.toContain("1.4.2+318");
  });

  it("keeps what an operator actually debugs with: the operation, the SQL and the driver code", () => {
    const safe = redactQueryParams(
      drizzleQueryError(QUERY, [MESSAGE], { code: "42P01" }),
      "worker feedback insert",
    ) as RedactedQueryError;

    expect(safe).toBeInstanceOf(RedactedQueryError);
    expect(safe.message).toContain("worker feedback insert");
    expect(safe.message).toContain('insert into "worker_feedback"');
    expect(safe.code).toBe("42P01");
    // The cause chain survives, so the driver's own stack is still reachable.
    expect(safe.cause).toEqual({ code: "42P01" });
  });

  it("passes through anything that is not a parameter-carrying query error, unchanged", () => {
    // A NotFoundException must keep its identity, or the 404 becomes a 500.
    const plain = new Error("Worker not found");
    expect(redactQueryParams(plain, "op")).toBe(plain);

    // A query error with no params array is not the shape we redact.
    const notQuery = Object.assign(new Error("boom"), { query: "select 1" });
    expect(redactQueryParams(notQuery, "op")).toBe(notQuery);

    // Non-Errors are returned as-is rather than wrapped into something with a fake stack.
    expect(redactQueryParams("a string", "op")).toBe("a string");
  });

  it("tolerates a cause with no SQLSTATE without inventing one", () => {
    const safe = redactQueryParams(
      drizzleQueryError(QUERY, [MESSAGE], new Error("socket hang up")),
      "worker feedback insert",
    ) as RedactedQueryError;
    expect(safe.code).toBeUndefined();
    expect(safe.message).not.toContain("code undefined");
    expect(safe.message).not.toContain(MESSAGE);
  });
});

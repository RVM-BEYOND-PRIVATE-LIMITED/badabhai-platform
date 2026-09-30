import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import {
  RedactedQueryError,
  isUniqueViolation,
  logSafeReason,
  redactQueryParams,
  sqlStateOf,
} from "./db-error";

/**
 * What `drizzle-orm` actually throws for a failed query: its own `DrizzleQueryError`, whose message
 * embeds the bound parameters and whose `cause` is the driver error. The real class, so a drizzle
 * bump that reshapes it fails here rather than in production.
 */
function drizzleQueryError(query: string, params: unknown[], cause?: unknown): Error {
  return new DrizzleQueryError(query, params, cause as Error);
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

describe("logSafeReason — a failure reason that never carries row data", () => {
  it("a query error: the operation, the SQL and the driver code, never the parameters", () => {
    const reason = logSafeReason(
      drizzleQueryError(QUERY, ["w-1", MESSAGE], { code: "57014" }),
      "confirm-time interview close",
    );
    expect(reason).toContain("confirm-time interview close");
    expect(reason).toContain("57014");
    expect(reason).not.toContain("Ramesh");
    expect(reason).not.toContain("98765");
  });

  it("any other error: its class name only — an arbitrary message is not trusted", () => {
    // A JSON parse error quotes the text it choked on; so can a validation error.
    const parse = new SyntaxError(`Unexpected token 'M', "${MESSAGE}" is not valid JSON`);
    expect(logSafeReason(parse, "op")).toBe("SyntaxError");
  });

  it("keeps a driver code on a non-query error, but only a code-shaped one", () => {
    expect(logSafeReason(Object.assign(new Error("x"), { code: "ECONNRESET" }), "op")).toBe(
      "Error (code ECONNRESET)",
    );
    expect(logSafeReason(Object.assign(new Error("x"), { code: MESSAGE }), "op")).toBe("Error");
  });

  it("a thrown non-Error is named by its type", () => {
    expect(logSafeReason(MESSAGE, "op")).toBe("string");
    expect(logSafeReason(null, "op")).toBe("object");
  });
});

describe("sqlStateOf / isUniqueViolation — the SQLSTATE sits on the cause (#1811)", () => {
  const unique = () => drizzleQueryError(QUERY, [], Object.assign(new Error("dup"), { code: "23505" }));

  it("reads the SQLSTATE through drizzle's wrapper, which has no code of its own", () => {
    const err = unique();
    // The defect: every pre-#1811 check read this and never matched.
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(sqlStateOf(err)).toBe("23505");
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("still classifies an unwrapped driver error", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  it("any other SQLSTATE, a cause with no code, or a non-error is not a unique violation", () => {
    const check = drizzleQueryError(QUERY, [], Object.assign(new Error("chk"), { code: "23514" }));
    expect(sqlStateOf(check)).toBe("23514");
    expect(isUniqueViolation(check)).toBe(false);
    expect(isUniqueViolation(drizzleQueryError(QUERY, [], new Error("socket hang up")))).toBe(false);
    expect(sqlStateOf(null)).toBeUndefined();
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

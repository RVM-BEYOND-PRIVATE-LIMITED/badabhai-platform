import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerApplicantInboxController } from "./payer-applicant-inbox.controller";
import {
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  PayerApplicantInboxQuerySchema,
} from "./payer-applicant-inbox.dto";
import {
  decodeInboxCursor,
  encodeInboxCursor,
  INBOX_CURSOR_MAX_LENGTH,
} from "./payer-applicant-inbox.cursor";

const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const KEY = {
  appliedKey: "2026-10-01T10:00:00.123456Z",
  applicationId: "4444abcd-4444-4444-8444-00000000000a",
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const PAYER: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const parse = (q: Record<string, unknown>) => PayerApplicantInboxQuerySchema.safeParse(q);

describe("PayerApplicantInboxQuerySchema — the query boundary", () => {
  it("an empty query is the first page of everything, 20 rows", () => {
    expect(parse({})).toEqual({
      success: true,
      data: { limit: INBOX_DEFAULT_LIMIT, postingId: undefined, cursor: undefined },
    });
    expect(INBOX_DEFAULT_LIMIT).toBe(20);
  });

  it("limit is bounded 1..50 and coerced from the query string", () => {
    expect(INBOX_MAX_LIMIT).toBe(50);
    expect(parse({ limit: "50" }).data?.limit).toBe(50);
    expect(parse({ limit: "1" }).data?.limit).toBe(1);
    for (const bad of ["0", "51", "-1", "2.5", "abc", "1000000"]) {
      expect(parse({ limit: bad }).success, `limit=${bad}`).toBe(false);
    }
  });

  it("postingId must be a uuid", () => {
    expect(parse({ postingId: POSTING }).data?.postingId).toBe(POSTING);
    for (const bad of ["x", "1", "' OR 1=1 --", POSTING + "0"]) {
      expect(parse({ postingId: bad }).success, bad).toBe(false);
    }
  });

  it("a repeated param (an array) is a 400, never a silent first-wins", () => {
    expect(parse({ postingId: [POSTING, POSTING] }).success).toBe(false);
    expect(parse({ cursor: [encodeInboxCursor(KEY), encodeInboxCursor(KEY)] }).success).toBe(false);
  });

  it("there is no payer slot: payer_id / payerId are rejected, not ignored (XB-A)", () => {
    expect(parse({ payer_id: "aaaaaaaa-0000-4000-8000-00000000000a" }).success).toBe(false);
    expect(parse({ payerId: "aaaaaaaa-0000-4000-8000-00000000000a" }).success).toBe(false);
  });

  it("there is no stage filter: ?stage= is a 400, not a filter that silently does nothing", () => {
    for (const stage of ["new", "shortlist", "passed", ""]) {
      expect(parse({ stage }).success, `stage=${stage}`).toBe(false);
    }
  });

  it("a minted cursor round-trips to its position; an empty cursor is the first page", () => {
    expect(parse({ cursor: encodeInboxCursor(KEY) }).data?.cursor).toEqual(KEY);
    expect(parse({ cursor: "" }).data?.cursor).toBeUndefined();
  });

  it("a cursor the server did not mint is a 400 at the boundary", () => {
    const bad = [
      "not base64!",
      b64({ v: 2, t: KEY.appliedKey, id: KEY.applicationId }), // another version
      b64({ v: 1, t: KEY.appliedKey }), // missing key
      b64({ v: 1, t: KEY.appliedKey, id: KEY.applicationId, p: "x" }), // extra key
      b64({ v: 1, t: "2026-10-01T10:00:00.123Z", id: KEY.applicationId }), // millisecond, not µs
      b64({ v: 1, t: KEY.appliedKey, id: KEY.applicationId.toUpperCase() }), // not the minted form
      b64({ v: 1, t: KEY.appliedKey, id: "x" }),
      b64("just a string"),
      "x".repeat(INBOX_CURSOR_MAX_LENGTH + 1),
    ];
    for (const cursor of bad) expect(parse({ cursor }).success, cursor.slice(0, 40)).toBe(false);
  });
});

describe("inbox cursor codec", () => {
  it("is base64url JSON of {v, t, id} and nothing else", () => {
    const raw = encodeInboxCursor(KEY);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))).toEqual({
      v: 1,
      t: KEY.appliedKey,
      id: KEY.applicationId,
    });
    expect(raw.length).toBeLessThan(INBOX_CURSOR_MAX_LENGTH);
  });

  it("decode never throws — garbage is null", () => {
    for (const raw of ["", "%%%", "e30", b64(null), b64([1, 2])]) {
      expect(() => decodeInboxCursor(raw)).not.toThrow();
      expect(decodeInboxCursor(raw)).toBeNull();
    }
  });
});

/**
 * L1 (security review, PR #2116) — an impossible calendar date in a forged cursor used to pass
 * `Date.parse` (30 February rolls to 2 March; year 0000 parses) and then fail at the Postgres
 * bind (22008) inside the page read: a 500. It must be a 400 at the DTO, before the reach cap and
 * before any read.
 */
describe("inbox cursor — an impossible calendar date is a 400 and nothing is read (L1)", () => {
  const ID = "4444abcd-4444-4444-8444-00000000000a";
  const forged = (t: string) => b64({ v: 1, t, id: ID });

  function listThroughThePipe(query: Record<string, unknown>) {
    const list = vi.fn(async () => ({ applicants: [], nextCursor: null }));
    const assertWithinHourlyCap = vi.fn(async () => undefined);
    const ctrl = new PayerApplicantInboxController(
      { list } as never,
      { assertWithinHourlyCap } as never,
      { PAYER_REACH_MAX_PER_HOUR: 60 } as unknown as ServerConfig,
    );
    const pipe = new ZodValidationPipe(PayerApplicantInboxQuerySchema);
    let thrown: unknown;
    try {
      // Nest's order: the @Query pipe runs, THEN the handler. A pipe throw means no handler.
      void ctrl.list(pipe.transform(query), PAYER, CTX);
    } catch (e) {
      thrown = e;
    }
    return { thrown, list, assertWithinHourlyCap };
  }

  it.each([
    "2026-02-30T00:00:00.000000Z", // 30 February (Date.parse rolls it to 2 March)
    "0000-01-01T00:00:00.000000Z", // year zero (Date.parse accepts it; Postgres does not)
    "2026-13-01T00:00:00.000000Z", // month 13
  ])("%s → decode null, 400 naming `cursor`, no cap charge and no read", (t) => {
    expect(decodeInboxCursor(forged(t))).toBeNull();
    const { thrown, list, assertWithinHourlyCap } = listThroughThePipe({ cursor: forged(t) });
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getStatus()).toBe(400);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      issues: [{ path: "cursor", message: "cursor is malformed" }],
    });
    expect(assertWithinHourlyCap).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    "2024-02-29T23:59:59.999999Z", // a real leap day
    "0001-01-01T00:00:00.000000Z", // the smallest year Postgres takes
    "9999-12-31T23:59:59.999999Z",
  ])("CONTROL: a real instant %s still decodes and reaches the read", async (t) => {
    expect(decodeInboxCursor(forged(t))).toEqual({ appliedKey: t, applicationId: ID });
    const { thrown, list } = listThroughThePipe({ cursor: forged(t) });
    expect(thrown).toBeUndefined();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  });
});

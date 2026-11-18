import { describe, expect, it } from "vitest";
import {
  callIdForKey,
  compareRanOut,
  decodeOutOfCreditsCursor,
  encodeOutOfCreditsCursor,
  isAfterCursor,
  pageOutOfCredits,
  rankOutOfCredits,
  ranOutAt,
  type RanOutCompany,
} from "./out-of-credits";

/**
 * #2755 item 8 — the call list's pure rules: when a company ran out (the later of its last spend
 * and its last expiry), the order (newest first, then the id), the keyset cursor (malformed is the
 * first page) and the paging (no phantom next page), and the call row's derived id.
 */

const P = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t = (iso: string) => new Date(iso);

describe("ranOutAt", () => {
  it("is the later of the last spend and the last expiry; either alone; null with neither", () => {
    const spend = t("2026-11-10T10:00:00Z");
    const expiry = t("2026-11-12T00:00:00Z");
    expect(ranOutAt(spend, expiry)).toEqual(expiry);
    expect(ranOutAt(expiry, spend)).toEqual(expiry);
    expect(ranOutAt(spend, null)).toEqual(spend);
    expect(ranOutAt(null, expiry)).toEqual(expiry);
    expect(ranOutAt(null, null)).toBeNull();
  });
});

describe("rankOutOfCredits", () => {
  it("keeps the companies that ran out, newest first, ties broken by the id descending", () => {
    const listed = rankOutOfCredits(
      [
        { payerId: P(1), lastLotExpiryAt: null }, // ran out by spending (below)
        { payerId: P(2), lastLotExpiryAt: t("2026-11-15T00:00:00Z") }, // by expiry, newest
        { payerId: P(3), lastLotExpiryAt: null }, // never held a credit: not on the list
        { payerId: P(4), lastLotExpiryAt: t("2026-11-01T00:00:00Z") }, // spent later than expiry
        { payerId: P(5), lastLotExpiryAt: null }, // same instant as P(1)
      ],
      new Map([
        [P(1), t("2026-11-10T10:00:00Z")],
        [P(4), t("2026-11-11T00:00:00Z")],
        [P(5), t("2026-11-10T10:00:00Z")],
        [P(9), t("2026-11-16T00:00:00Z")], // an event for a company not at zero: ignored
      ]),
    );
    expect(listed.map((r) => [r.payerId, r.ranOutAt.toISOString()])).toEqual([
      [P(2), "2026-11-15T00:00:00.000Z"],
      [P(4), "2026-11-11T00:00:00.000Z"],
      [P(5), "2026-11-10T10:00:00.000Z"],
      [P(1), "2026-11-10T10:00:00.000Z"],
    ]);
  });

  it("a company that spends its last credit NOW is at the top", () => {
    const listed = rankOutOfCredits(
      [
        { payerId: P(1), lastLotExpiryAt: t("2026-11-15T00:00:00Z") },
        { payerId: P(2), lastLotExpiryAt: null },
      ],
      new Map([[P(2), t("2026-11-17T09:00:00Z")]]),
    );
    expect(listed[0]!.payerId).toBe(P(2));
  });
});

describe("the keyset cursor", () => {
  const row: RanOutCompany = { payerId: P(7), ranOutAt: t("2026-11-10T10:00:00.123Z") };

  it("round-trips the last row's ran-out time and id", () => {
    expect(decodeOutOfCreditsCursor(encodeOutOfCreditsCursor(row))).toEqual({
      ranOutAt: "2026-11-10T10:00:00.123Z",
      payerId: P(7),
    });
  });

  it("decodes anything malformed to null (the first page), never a throw", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    for (const bad of [
      undefined,
      "",
      "%%%",
      "bm90IGpzb24",
      enc({ r: "2026-11-10T10:00:00Z" }),
      enc({ r: "not a time", p: P(1) }),
      enc({ r: "2026-11-10T10:00:00Z", p: "x" }),
      enc({ r: 5, p: P(1) }),
    ]) {
      expect(decodeOutOfCreditsCursor(bad as string | undefined), String(bad)).toBeNull();
    }
  });

  it("an upper-case id is read in lower case (the order compares the text Postgres prints)", () => {
    const enc = Buffer.from(
      JSON.stringify({ r: "2026-11-10T10:00:00Z", p: P(7).toUpperCase() }),
      "utf8",
    ).toString("base64url");
    expect(decodeOutOfCreditsCursor(enc)?.payerId).toBe(P(7));
  });

  it("'after' is strictly later in the order: older, or the same instant with a smaller id", () => {
    const c = { ranOutAt: "2026-11-10T10:00:00.000Z", payerId: P(5) };
    expect(isAfterCursor({ payerId: P(9), ranOutAt: t("2026-11-09T00:00:00Z") }, c)).toBe(true);
    expect(isAfterCursor({ payerId: P(4), ranOutAt: t("2026-11-10T10:00:00Z") }, c)).toBe(true);
    expect(isAfterCursor({ payerId: P(5), ranOutAt: t("2026-11-10T10:00:00Z") }, c)).toBe(false);
    expect(isAfterCursor({ payerId: P(6), ranOutAt: t("2026-11-10T10:00:00Z") }, c)).toBe(false);
    expect(isAfterCursor({ payerId: P(1), ranOutAt: t("2026-11-11T00:00:00Z") }, c)).toBe(false);
  });
});

describe("pageOutOfCredits", () => {
  const listed = [5, 4, 3, 2, 1]
    .map((n) => ({ payerId: P(n), ranOutAt: t(`2026-11-0${n}T00:00:00Z`) }))
    .sort(compareRanOut);

  it("walks the whole list in order, page by page, with no repeat and no gap", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = pageOutOfCredits(listed, decodeOutOfCreditsCursor(cursor ?? undefined), 2);
      seen.push(...page.rows.map((r) => r.payerId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(listed.map((r) => r.payerId));
    expect(pages).toBe(3);
  });

  it("a list that ends exactly on a page boundary offers no empty next page", () => {
    const page = pageOutOfCredits(listed.slice(0, 4), null, 2);
    const second = pageOutOfCredits(
      listed.slice(0, 4),
      decodeOutOfCreditsCursor(page.nextCursor!),
      2,
    );
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("a malformed cursor is the first page", () => {
    expect(pageOutOfCredits(listed, decodeOutOfCreditsCursor("garbage"), 2).rows[0]).toEqual(
      listed[0],
    );
  });
});

describe("callIdForKey", () => {
  const ADMIN = "22222222-2222-4222-8222-222222222222";
  const OTHER = "33333333-3333-4333-8333-333333333333";

  it("is a stable uuid per admin and key; another key or another admin is another row", () => {
    const id = callIdForKey(ADMIN, "call-key-0001");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(callIdForKey(ADMIN, "call-key-0001")).toBe(id);
    expect(callIdForKey(ADMIN, "call-key-0002")).not.toBe(id);
    expect(callIdForKey(OTHER, "call-key-0001")).not.toBe(id);
  });
});

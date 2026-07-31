import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import { FreeTierService } from "./free-tier.service";

/**
 * B6 / ADR-0036 §8 — the free-tier grant.
 *
 * ONE property matters here and it is worth money: the grant is EXACTLY ONCE. A signup
 * that retries, a redelivered request, or the `db:grant:free-tier` backfill running
 * alongside signup must all leave the payer with 50 credits, not 100. The database
 * enforces it via `credit_ledger_idempotency_key_uq`; what this service must get right
 * is the CONSEQUENCE of that constraint — the balance is bumped only when the ledger
 * insert actually inserted, read from `RETURNING`.
 *
 * WHAT THESE TESTS CANNOT PROVE (stated plainly rather than faked): the unique
 * constraint itself, and the transaction's atomicity, are properties of Postgres. Here
 * the constraint is SIMULATED — the fake tx returns no rows for the second insert, the
 * way a real `ON CONFLICT DO NOTHING ... RETURNING` would. What IS proven from real
 * values is that the service does the right thing with that answer, that both writes go
 * to the same `tx`, and that the idempotency key it writes is byte-for-byte the key the
 * D6 backfill uses (a mismatch there would double every payer's credits silently).
 */

const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";

/** One executed statement, flattened out of the drizzle SQL template. */
interface Executed {
  text: string;
  params: unknown[];
}

/** Render a drizzle `sql` template into text + ordered params, without a database. */
function renderSql(query: unknown): Executed {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  const params: unknown[] = [];
  let text = "";
  for (const chunk of chunks) {
    const asChunk = chunk as { value?: unknown };
    if (chunk !== null && typeof chunk === "object" && Array.isArray(asChunk.value)) {
      text += (asChunk.value as string[]).join("");
    } else {
      params.push(chunk);
      text += `$${params.length}`;
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), params };
}

/**
 * @param ledgerInserts one entry per `grantForPayer` call: `true` = the ledger insert
 *   won the race and RETURNED a row, `false` = the unique key already existed.
 */
function setup(ledgerInserts: boolean[], cfg: Partial<MatchConfig> = {}) {
  const statements: Executed[] = [];
  let call = 0;

  const tx = {
    execute: vi.fn(async (query: unknown) => {
      const rendered = renderSql(query);
      statements.push(rendered);
      if (rendered.text.includes("credit_ledger")) {
        const won = ledgerInserts[call++] ?? true;
        return won ? [{ id: "ledger-row" }] : [];
      }
      return [];
    }),
  };
  const db = {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<number>) => fn(tx)),
    execute: vi.fn(async () => []),
  };
  const config = { get: vi.fn(async () => ({ ...DEFAULT_MATCH_CONFIG, ...cfg })) };

  const svc = new FreeTierService(db as never, config as never);
  const ledgerWrites = () => statements.filter((s) => s.text.includes("INSERT INTO credit_ledger"));
  const balanceWrites = () =>
    statements.filter((s) => s.text.includes("INSERT INTO payer_credits"));
  return { svc, db, tx, config, statements, ledgerWrites, balanceWrites };
}

describe("FreeTierService — the grant is IDEMPOTENT (the money property)", () => {
  it("grants the configured credits on the first call", async () => {
    const { svc } = setup([true]);
    expect(await svc.grantForPayer(PAYER)).toBe(50);
  });

  it("a SECOND grant returns 0 and does NOT touch the balance", async () => {
    // Two calls, one winning insert: the retry (or the concurrent D6 backfill) must
    // leave the payer on 50. If the balance write ran unconditionally he would have 100
    // and nothing anywhere would look broken.
    const { svc, balanceWrites } = setup([true, false]);

    expect(await svc.grantForPayer(PAYER)).toBe(50);
    expect(await svc.grantForPayer(PAYER)).toBe(0);

    expect(balanceWrites()).toHaveLength(1);
  });

  it("attempts the ledger BEFORE the balance, so a conflict is known before crediting", async () => {
    const { svc, statements } = setup([true]);
    await svc.grantForPayer(PAYER);

    // Order is the whole mechanism: bumping the balance first and discovering the
    // ledger row afterwards would double a payer's credits on every retry.
    expect(statements).toHaveLength(2);
    expect(statements[0]!.text).toContain("INSERT INTO credit_ledger");
    expect(statements[1]!.text).toContain("INSERT INTO payer_credits");
  });

  it("writes the EXACT key the D6 backfill uses, with ON CONFLICT DO NOTHING + RETURNING", async () => {
    const { svc, ledgerWrites } = setup([true]);
    await svc.grantForPayer(PAYER);

    const ledger = ledgerWrites()[0]!;
    // `db:grant:free-tier` keys existing payers identically. If these two strings ever
    // diverge, signup and the backfill stop deduplicating each other and every
    // backfilled payer gets a second 50.
    expect(ledger.params).toContain(`free_tier_grant:${PAYER}`);
    expect(ledger.text).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(ledger.text).toContain("RETURNING id");
  });

  it("keeps both writes inside the SAME transaction (never on the bare connection)", async () => {
    const { svc, db, tx } = setup([true]);
    await svc.grantForPayer(PAYER);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.execute).toHaveBeenCalledTimes(2);
    // A balance bump outside the tx could survive a rolled-back ledger insert — credits
    // with no audit row, which is the one thing the ledger exists to prevent.
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("FreeTierService — the amount is CONFIG, never a constant", () => {
  it("grants what match_config says, and writes that same number to both rows", async () => {
    const { svc, ledgerWrites, balanceWrites } = setup([true], { freeUnlockCredits: 25 });

    expect(await svc.grantForPayer(PAYER)).toBe(25);
    // The delta and the balance must be the same number: a hard-coded 50 on either side
    // would silently desync the ledger from the balance it is supposed to explain.
    expect(ledgerWrites()[0]!.params).toContain(25);
    expect(balanceWrites()[0]!.params).toContain(25);
  });

  it("a zero (or disabled) grant writes NOTHING AT ALL — no empty ledger row", async () => {
    const { svc, db } = setup([true], { freeUnlockCredits: 0 });

    expect(await svc.grantForPayer(PAYER)).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("FreeTierService — a failed grant must never cost a signup", () => {
  it("grantQuietly swallows what grantForPayer throws (same failure, two contracts)", async () => {
    const { svc, db } = setup([true]);
    db.transaction.mockRejectedValue(new Error("deadlock detected"));

    // The differential IS the test: the strict path still surfaces the failure, so the
    // quiet path is a deliberate wrapper and not a service that cannot fail.
    await expect(svc.grantForPayer(PAYER)).rejects.toThrow("deadlock detected");
    await expect(svc.grantQuietly(PAYER)).resolves.toBeUndefined();
  });

  it("swallows a NON-Error rejection too (a thrown string must not escape signup)", async () => {
    const { svc, db } = setup([true]);
    // A driver that rejects with a string would sail past an `instanceof Error` handler
    // written the obvious way, and the payer's signup would 500 on a credit grant.
    db.transaction.mockRejectedValue("connection terminated unexpectedly");
    await expect(svc.grantQuietly(PAYER)).resolves.toBeUndefined();
  });

  it("grantQuietly still performs the grant on the happy path", async () => {
    const { svc, balanceWrites } = setup([true]);
    await svc.grantQuietly(PAYER);
    expect(balanceWrites()).toHaveLength(1);
  });
});

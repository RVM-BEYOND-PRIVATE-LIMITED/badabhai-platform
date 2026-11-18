import { describe, expect, it, vi } from "vitest";
import type { TestAccountWrite, UnmarkedPayerWithEmail } from "./admin-numbers.repository";
import {
  markSyntheticTestPayers,
  type MarkSyntheticTestPayersDeps,
} from "./mark-synthetic-test-payers";
import {
  buildPiiDecrypter,
  parseMarkSyntheticTestPayersArgs,
} from "./mark-synthetic-test-payers.cli";

/**
 * #2755 item 2 — the synthetic-sign-in backfill against a fake database. The two properties that
 * matter: a DRY RUN WRITES NOTHING, and NO EMAIL EVER REACHES A LOG LINE.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A fake `payers` table: ciphertext is `enc:<email>`; a `bad:` token will not decrypt. */
function fakeDb(rows: Array<{ id: string; email: string | null; marked?: boolean }>) {
  const state = rows.map((r) => ({ ...r, marked: r.marked ?? false }));
  const writes: string[] = [];
  const lines: string[] = [];
  const deps: MarkSyntheticTestPayersDeps = {
    listUnmarked: vi.fn(async (afterId: string | null, limit: number) =>
      state
        .filter((r) => !r.marked && r.email !== null && (afterId === null || r.id > afterId))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((r): UnmarkedPayerWithEmail => ({ id: r.id, emailEnc: `enc:${r.email}` })),
    ),
    decrypt: (token: string) => {
      if (token.startsWith("enc:bad:")) throw new Error("bad tag");
      return token.slice("enc:".length);
    },
    mark: vi.fn(async (payerId: string): Promise<TestAccountWrite> => {
      writes.push(payerId);
      const row = state.find((r) => r.id === payerId);
      if (!row) return "not_found";
      if (row.marked) return "unchanged";
      row.marked = true;
      return "changed";
    }),
    log: (line: string) => lines.push(line),
  };
  return { deps, state, writes, lines };
}

const ROWS = [
  { id: id(1), email: "owner@acme.example" },
  { id: id(2), email: "qa-1@e2e.badabhai.invalid" },
  { id: id(3), email: null },
  { id: id(4), email: "QA-2@E2E.BADABHAI.INVALID " },
  { id: id(5), email: "bad:token" },
  { id: id(6), email: "someone@badabhai.invalid" },
  { id: id(7), email: "already@e2e.badabhai.invalid", marked: true },
];

describe("markSyntheticTestPayers — dry run", () => {
  it("writes NOTHING and reports the synthetic sign-ins it would mark, by id", async () => {
    const db = fakeDb(ROWS);
    const out = await markSyntheticTestPayers(db.deps, { apply: false, batchSize: 2 });
    expect(db.deps.mark).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
    expect(db.state.filter((r) => r.marked).map((r) => r.id)).toEqual([id(7)]);
    expect(out).toEqual({
      apply: false,
      scanned: 5, // unmarked with an email: 1, 2, 4, 5, 6
      synthetic: 2,
      marked: 2,
      alreadyMarked: 0,
      failed: 1,
      ids: [id(2), id(4)],
    });
    expect(db.lines.at(-1)).toMatch(/DRY RUN .* would_mark=2 .*nothing written/);
  });
});

describe("markSyntheticTestPayers — apply", () => {
  it("marks exactly the reserved-domain sign-ins, across pages, and is idempotent", async () => {
    const db = fakeDb(ROWS);
    const out = await markSyntheticTestPayers(db.deps, { apply: true, batchSize: 2 });
    expect(out.ids).toEqual([id(2), id(4)]);
    expect(out).toMatchObject({ scanned: 5, synthetic: 2, marked: 2, failed: 1 });
    expect(db.writes).toEqual([id(2), id(4)]);
    // A look-alike domain ("@badabhai.invalid" without e2e.) is a real-looking address: not marked.
    expect(db.state.find((r) => r.id === id(6))?.marked).toBe(false);
    expect(db.state.find((r) => r.id === id(1))?.marked).toBe(false);

    // A second run finds nothing left to mark.
    const again = await markSyntheticTestPayers(db.deps, { apply: true, batchSize: 2 });
    expect(again).toMatchObject({ synthetic: 0, marked: 0 });
  });

  it("counts a company marked in between as already marked, a vanished one as failed", async () => {
    const db = fakeDb(ROWS);
    db.deps.mark = vi.fn(async (payerId: string) =>
      payerId === id(2) ? ("unchanged" as const) : ("not_found" as const),
    );
    const out = await markSyntheticTestPayers(db.deps, { apply: true, batchSize: 10 });
    expect(out).toMatchObject({ marked: 0, alreadyMarked: 1, failed: 2 });
  });

  it("a failed mark is counted and the run goes on", async () => {
    const db = fakeDb(ROWS);
    db.deps.mark = vi.fn(async (payerId: string) => {
      if (payerId === id(2)) throw new Error("connection reset");
      return "changed" as const;
    });
    const out = await markSyntheticTestPayers(db.deps, { apply: true, batchSize: 10 });
    expect(out.ids).toEqual([id(4)]);
    expect(out.failed).toBe(2); // the bad token and the failed mark
  });
});

describe("markSyntheticTestPayers — no email in any output", () => {
  it("never logs an email, a ciphertext or a domain, in either mode", async () => {
    for (const apply of [false, true]) {
      const db = fakeDb(ROWS);
      await markSyntheticTestPayers(db.deps, { apply, batchSize: 3 });
      const text = db.lines.join("\n");
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/enc:/);
      expect(text).not.toMatch(/invalid|acme|owner|qa-/i);
      for (const line of db.lines) {
        expect(line).toMatch(/^ {2}(summary:|[0-9a-f-]{36} )/);
      }
    }
  });

  it("refuses a batch size that is not a positive integer", async () => {
    const db = fakeDb(ROWS);
    await expect(markSyntheticTestPayers(db.deps, { apply: false, batchSize: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("the CLI's argument contract and decrypter", () => {
  it("is a dry run unless --apply; refuses unknown flags, positionals and a bad batch size", () => {
    expect(parseMarkSyntheticTestPayersArgs([])).toEqual({ apply: false, batchSize: 500 });
    expect(parseMarkSyntheticTestPayersArgs(["--apply", "--batch-size=50"])).toEqual({
      apply: true,
      batchSize: 50,
    });
    expect(() => parseMarkSyntheticTestPayersArgs(["--force"])).toThrow();
    expect(() => parseMarkSyntheticTestPayersArgs(["stray"])).toThrow();
    expect(() => parseMarkSyntheticTestPayersArgs(["--batch-size=0"])).toThrow(/batch-size/);
    expect(() =>
      parseMarkSyntheticTestPayersArgs(["--apply", "--i-am-authorised-to-write-to-production"]),
    ).not.toThrow();
  });

  it("the decrypter refuses to start with no key, or half a keyring", () => {
    expect(() => buildPiiDecrypter({})).toThrow(/nothing to decrypt with/);
    expect(() => buildPiiDecrypter({ PII_ENCRYPTION_KEYS: "{}" })).toThrow(/together/);
    expect(typeof buildPiiDecrypter({ PII_ENCRYPTION_KEY: "k".repeat(64) })).toBe("function");
  });
});

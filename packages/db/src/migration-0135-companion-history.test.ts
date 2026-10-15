/**
 * Migration 0135 — `companion_messages` + `companion_conversation_summaries`, the Bada Bhai chat's
 * 7-day conversation and its rolling summary (#2297, owner rulings 2026-10-15, ADR-0056).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What they do NOT see, and
 * what this file pins, is the half that lives in the hand-edits and the contract:
 *
 *   1. ADDITIVE — two new tables. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the eight REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE ROLE VOCABULARY — the CHECK is exactly `COMPANION_MESSAGE_ROLES`.
 *   4. ERASURE — both tables cascade on the worker's delete (account deletion hard-deletes).
 *   5. REPLAY — one worker line and one reply per submission (the partial unique index).
 *   6. THE HEADER — deploy order (any time after the deploy, no flag) and rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPANION_MESSAGE_ROLES } from "@badabhai/types";

const TAG = "0135_companion_history";
const MESSAGES = "companion_messages";
const SUMMARIES = "companion_conversation_summaries";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates both tables", () => {
    expect(FLAT).toContain(`CREATE TABLE "${MESSAGES}"`);
    expect(FLAT).toContain(`CREATE TABLE "${SUMMARIES}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY AFTER THE DEPLOY");
    expect(DDL).not.toContain("APPLY AFTER THE DEPLOY");
  });
});

describe("0135 is additive", () => {
  it("creates exactly two tables and three indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(3);
  });

  it("alters only the new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered).toHaveLength(6); // per table: ENABLE, the FK, FORCE
    for (const statement of altered) {
      expect(statement).toMatch(
        /^(companion_messages|companion_conversation_summaries) (ENABLE|FORCE|ADD CONSTRAINT)/,
      );
    }
  });

  it("drops nothing, truncates nothing, deletes nothing, writes no rows", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "DROP INDEX",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "', // an UPDATE statement — not the FK's `ON UPDATE no action`
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("never touches the migration ledger", () => {
    expect(FLAT).not.toContain("__drizzle_migrations");
  });
});

describe("companion_messages", () => {
  it("role admits exactly COMPANION_MESSAGE_ROLES — no more, no fewer", () => {
    const head = `CONSTRAINT "companion_messages_role_chk" CHECK ("${MESSAGES}"."role" IN (`;
    const start = FLAT.indexOf(head);
    expect(start).toBeGreaterThan(0);
    const values = FLAT.slice(start + head.length, FLAT.indexOf("))", start))
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""));
    expect(values).toEqual([...COMPANION_MESSAGE_ROLES]);
  });

  it("every line names its worker, its role, its text and its time; the reply fields are optional", () => {
    for (const column of [
      '"worker_id" uuid NOT NULL',
      '"role" text NOT NULL',
      '"body_text" text NOT NULL',
      '"created_at" timestamp with time zone DEFAULT now() NOT NULL',
      '"model_context" boolean DEFAULT false NOT NULL',
      '"tts_text" text,',
      '"read_aloud" boolean,',
      '"suggested_options" jsonb,',
      '"suggested_followups" jsonb,',
      '"news_links" jsonb,',
      '"submission_id" uuid,',
    ]) {
      expect(FLAT).toContain(column);
    }
  });

  it("a later model call reads a line only when it is marked — the default is NOT", () => {
    // ADR-0055 F3/F4: a distress turn or a trash verdict is never replayed to a model, so an
    // unmarked row must default to invisible, never the other way round.
    expect(FLAT).toContain('"model_context" boolean DEFAULT false NOT NULL');
  });

  it("serves the history read from one index: (worker_id, created_at DESC NULLS FIRST)", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "companion_messages_worker_created_idx" ON "${MESSAGES}" USING btree ("worker_id","created_at" DESC NULLS FIRST)`,
    );
  });

  it("serves the daily retention sweep from its own index: (created_at)", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "companion_messages_created_at_idx" ON "${MESSAGES}" USING btree ("created_at")`,
    );
  });

  it("a replayed submission inserts nothing: unique (worker, submission, role) where submitted", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "companion_messages_submission_uq" ON "${MESSAGES}" USING btree ("worker_id","submission_id","role") WHERE "${MESSAGES}"."submission_id" IS NOT NULL`,
    );
  });
});

describe("companion_conversation_summaries", () => {
  it("one row per worker; the watermark is required, the text may be a watermark-only null", () => {
    expect(FLAT).toContain('"worker_id" uuid PRIMARY KEY NOT NULL');
    expect(FLAT).toContain('"summary" text,');
    expect(FLAT).toContain('"folded_through" timestamp with time zone NOT NULL');
  });
});

describe("erasure — the account-deletion hard delete removes both", () => {
  it.each([MESSAGES, SUMMARIES])("%s cascades on the worker's delete", (table) => {
    expect(FLAT).toContain(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade`,
    );
  });

  it("references nothing else", () => {
    expect([...FLAT.matchAll(/FOREIGN KEY/g)]).toHaveLength(2);
  });
});

describe("both tables are locked (RLS tail is hand-appended)", () => {
  it.each([MESSAGES, SUMMARIES])("%s enables and FORCES row level security", (table) => {
    expect(FLAT).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(
    [MESSAGES, SUMMARIES].flatMap((table) =>
      ["PUBLIC", "anon", "authenticated", "service_role"].map((role) => [table, role]),
    ),
  )("%s revokes everything from %s", (table, role) => {
    expect(FLAT).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role}`);
  });

  it("declares no policy — deny by default", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the header's rollback is executable as written", () => {
  it("drops both tables and the ledger row in ONE locked transaction", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG)!;
    const rollback = RAW.slice(RAW.indexOf("ROLLBACK."));
    const steps = [
      "BEGIN;",
      "SET LOCAL lock_timeout = '3s';",
      `DROP TABLE "${MESSAGES}";`,
      `DROP TABLE "${SUMMARIES}";`,
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when};`,
      "COMMIT;",
    ].map((step) => rollback.indexOf(step));
    expect(steps.every((at) => at > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps); // in that order
  });

  it("states the deploy order: no flag, the API tolerates the missing tables", () => {
    expect(RAW).toContain("NO FLAG");
    expect(RAW).toContain("42P01");
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0135 at idx 135, with a `when` above its predecessor's (the skip watermark)", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(135);
    expect(previous.tag).toBe("0134_payer_applicant_stages");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});

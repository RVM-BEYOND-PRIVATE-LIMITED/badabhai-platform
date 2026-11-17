import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, createDbClient, creditRulesConfig, type DbClient } from "@badabhai/db";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { isUniqueViolation } from "../common/db-error";
import { CreditRulesRepository } from "./credit-rules.repository";

/**
 * #2750 item 1 — the credit rules' revisions against real Postgres.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test credit-rules.db
 *
 * What only a real database proves: a revision is written with its audit row in one transaction;
 * the old row stops being active; a stale `expectedRevision` writes nothing; and two admins saving
 * the SAME revision at once never both commit (`credit_rules_config_revision_uq` refuses one, or
 * the second reads the first's row and answers stale). After every write exactly one row is active.
 *
 * The table is global, so the test starts from whatever revision is stored, deletes only the rows
 * it wrote, and puts the previously active row back.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const ADMIN = "a2750000-0000-4000-8000-000000000001";

describe.skipIf(!RUN)("credit rules revisions — against real Postgres", () => {
  let client: DbClient;
  let repo: CreditRulesRepository;
  let startRevision: number;
  let previouslyActive: string | null;
  const written: string[] = [];

  const publish = (expectedRevision: number, higherCost: number) =>
    repo.publish(
      {
        rules: { ...DEFAULT_CREDIT_RULES, higherCost },
        expectedRevision,
        adminId: ADMIN,
        audit: { action: "credit_rules_changed", metadata: { test: "2750" } },
      },
      async () => undefined,
    );

  const activeRows = () =>
    client.db
      .select({ id: creditRulesConfig.id, revision: creditRulesConfig.revision })
      .from(creditRulesConfig)
      .where(eq(creditRulesConfig.isActive, true));

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    repo = new CreditRulesRepository(client.db);
    const [latest] = await client.sql<{ max: number | null }[]>`
      SELECT max(revision)::int AS max FROM credit_rules_config`;
    startRevision = latest?.max ?? 0;
    previouslyActive = (await repo.getActive())?.id ?? null;
  });

  afterAll(async () => {
    if (written.length > 0) {
      await client.db
        .delete(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "credit_rules_config"),
            inArray(auditLogs.entityId, written),
          ),
        );
      await client.db.delete(creditRulesConfig).where(inArray(creditRulesConfig.id, written));
    }
    if (previouslyActive !== null) {
      await client.db
        .update(creditRulesConfig)
        .set({ isActive: true })
        .where(eq(creditRulesConfig.id, previouslyActive));
    }
    await client.sql.end();
  });

  it("writes the next revision with its audit row, and it becomes the only active row", async () => {
    const result = await publish(startRevision, 3);
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;
    written.push(result.row.id);
    expect(result.row.revision).toBe(startRevision + 1);

    const active = await activeRows();
    expect(active).toEqual([{ id: result.row.id, revision: startRevision + 1 }]);
    expect((await repo.getActive())?.rules).toMatchObject({ higherCost: 3 });

    const audit = await client.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.entityType, "credit_rules_config"), eq(auditLogs.entityId, result.row.id)),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "admin",
      actorId: ADMIN,
      action: "credit_rules_changed",
    });
  });

  it("a stale expectedRevision writes nothing", async () => {
    const before = await activeRows();
    expect(await publish(startRevision, 4)).toEqual({ outcome: "stale" });
    expect(await activeRows()).toEqual(before);
  });

  it("an afterWrite that throws rolls the revision and its audit row back", async () => {
    const before = await activeRows();
    await expect(
      repo.publish(
        {
          rules: DEFAULT_CREDIT_RULES,
          expectedRevision: startRevision + 1,
          adminId: ADMIN,
          audit: { action: "credit_rules_changed", metadata: {} },
        },
        async () => {
          throw new Error("event failed");
        },
      ),
    ).rejects.toThrow("event failed");
    expect(await activeRows()).toEqual(before);
  });

  it("two saves of the same revision at once: exactly one commits", async () => {
    const expected = startRevision + 1;
    const settled = await Promise.allSettled([publish(expected, 5), publish(expected, 6)]);
    const published = settled.flatMap((s) =>
      s.status === "fulfilled" && s.value.outcome === "published" ? [s.value.row] : [],
    );
    for (const row of published) written.push(row.id);
    expect(published).toHaveLength(1);
    // The loser either read the winner's row (stale) or hit the revision index (23505).
    for (const s of settled) {
      if (s.status === "rejected") expect(isUniqueViolation(s.reason)).toBe(true);
    }
    const active = await activeRows();
    expect(active).toEqual([{ id: published[0]!.id, revision: expected + 1 }]);
  });
});

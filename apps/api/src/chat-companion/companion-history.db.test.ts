import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { CompanionHistoryRepository } from "./companion-history.repository";
import { CompanionHistoryService } from "./companion-history.service";
import { v2CareerAnswerTurn, v2CopyTurn } from "./v2/companion-v2-compose";
import { V2_CLARIFY } from "./companion-replies";

/**
 * #2297 (ADR-0056) — THE BADA BHAI CHAT'S STORED CONVERSATION AGAINST A REAL POSTGRES (migration
 * 0135 applied). The unit suite proves the policy over a faked repository; only a database proves
 * the statements evaluate that way:
 *  - the window: the last 7 days only, the NEWEST 200 when there are more, oldest first;
 *  - replay: the same submission inserts nothing (the partial unique index, ON CONFLICT DO NOTHING);
 *  - the recap is stored only while the worker has no line in the window;
 *  - the model lines: only `model_context` rows, the newest N;
 *  - the summary: live only while a line lies in the window before the turn; monotonic upsert;
 *  - the sweep: lines past 7 days and summaries with no live line, nothing else;
 *  - erasure: deleting the worker removes his lines and his summary (the FK cascade);
 *  - the plan: the history read is ONE index scan, no separate sort.
 *
 * Fixtures carry no PII: synthetic `enc:`/`hash:` markers, ids fresh per run, all deleted after.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 E2E_DATABASE_URL=<a local, migrated database> \
 *     pnpm --filter @badabhai/api exec vitest run companion-history.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const NOW = new Date("2026-10-15T10:00:00.000Z");
const DAY_MS = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe.skipIf(!RUN)("companion history — against Postgres (migration 0135)", () => {
  let client!: DbClient;
  let repo!: CompanionHistoryRepository;
  let history!: CompanionHistoryService;
  const workers: string[] = [];

  async function newWorker(): Promise<string> {
    const id = randomUUID();
    workers.push(id);
    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:companion-${TAG}-${workers.length}`},
              ${`hash:companion-${TAG}-${workers.length}`}, 'active')`;
    return id;
  }

  async function line(
    workerId: string,
    at: Date,
    over: { role?: "worker" | "bada_bhai"; text?: string; modelContext?: boolean } = {},
  ): Promise<void> {
    await repo.append([
      {
        workerId,
        role: over.role ?? "worker",
        bodyText: over.text ?? `line at ${at.toISOString()}`,
        modelContext: over.modelContext ?? false,
        createdAt: at,
      },
    ]);
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    repo = new CompanionHistoryRepository(client.db);
    history = new CompanionHistoryService(repo);
  });

  afterAll(async () => {
    if (!client) return;
    for (const id of workers) await client.sql`DELETE FROM workers WHERE id = ${id}::uuid`;
    await client.sql.end({ timeout: 5 });
  });

  let worker!: string;
  beforeEach(async () => {
    worker = await newWorker();
  });

  it("stores a turn and reads it back, oldest first, exactly as served", async () => {
    const answer = {
      ...v2CareerAnswerTurn(["Welding mein ₹18,000 se shuru."], ["Aur batao"]),
      news_links: [{ title: "Story", url: "https://example.com/a", site: "example.com" }],
    };
    history.keepTurn({
      workerId: worker,
      workerText: "welding mein kitna milta hai",
      submissionId: randomUUID(),
      turn: answer,
      modelContext: true,
      at: ago(60_000),
    });
    await history.idle();
    const read = await history.window(worker, NOW);
    if (!read.ok) throw new Error("expected a readable store");
    expect(read.value.map((item) => [item.role, item.text])).toEqual([
      ["worker", "welding mein kitna milta hai"],
      ["bada_bhai", answer.reply],
    ]);
    expect(read.value[1]).toMatchObject({
      read_aloud: false,
      suggested_followups: ["Aur batao"],
      news_links: answer.news_links,
    });
    expect(read.value[1]).not.toHaveProperty("tts_text");
  });

  it("a REPLAYED submission inserts nothing", async () => {
    const submission = randomUUID();
    const kept = {
      workerId: worker,
      workerText: "x",
      submissionId: submission,
      turn: v2CopyTurn(V2_CLARIFY),
      modelContext: false,
      at: ago(60_000),
    };
    history.keepTurn(kept);
    history.keepTurn({ ...kept, at: ago(30_000) });
    await history.idle();
    const [{ n } = { n: -1 }] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM companion_messages WHERE worker_id = ${worker}::uuid`;
    expect(n).toBe(2);
  });

  it("the window is the last 7 days only", async () => {
    await line(worker, ago(8 * DAY_MS), { text: "too old" });
    await line(worker, ago(7 * DAY_MS - 60_000), { text: "just inside" });
    const read = await history.window(worker, NOW);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.map((item) => item.text)).toEqual(["just inside"]);
  });

  it("caps at the NEWEST 200 lines, still oldest first", async () => {
    for (let i = 0; i < 205; i++) await line(worker, ago((205 - i) * 1_000), { text: `n${i}` });
    const read = await history.window(worker, NOW);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value).toHaveLength(200);
    expect(read.value[0]!.text).toBe("n5");
    expect(read.value.at(-1)!.text).toBe("n204");
  });

  it("the recap is stored only while the worker has no line in the window", async () => {
    history.keepRecap(worker, v2CopyTurn(V2_CLARIFY), ago(10_000));
    await history.idle();
    history.keepRecap(worker, v2CopyTurn(V2_CLARIFY), ago(5_000));
    await history.idle();
    const read = await history.window(worker, NOW);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value).toHaveLength(1);
    expect(read.value[0]).toMatchObject({ role: "bada_bhai", tts_text: V2_CLARIFY.dev });
  });

  it("model lines: only `model_context` rows, the newest N, oldest first", async () => {
    await line(worker, ago(50_000), { text: "a", modelContext: true });
    await line(worker, ago(40_000), { text: "distress", modelContext: false });
    await line(worker, ago(30_000), { text: "b", modelContext: true, role: "bada_bhai" });
    await line(worker, ago(20_000), { text: "c", modelContext: true });
    const read = await history.modelLines(worker, NOW, 2);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.map((l) => [l.role, l.text])).toEqual([
      ["bada_bhai", "b"],
      ["worker", "c"],
    ]);
  });

  it("the summary is live only while a line lies in the 7 days before the turn; upserts are monotonic", async () => {
    expect(
      await history.storeSummary(worker, { summary: "- a", foldedThrough: ago(DAY_MS) }, false),
    ).toBe(true);
    // No line at all → not live.
    expect(await history.liveSummary(worker, NOW)).toEqual({ ok: true, value: undefined });
    await line(worker, ago(2 * DAY_MS));
    expect(await history.liveSummary(worker, NOW)).toEqual({
      ok: true,
      value: { summary: "- a", foldedThrough: ago(DAY_MS) },
    });
    // An older watermark never overwrites a newer one; a newer one does.
    expect(
      await history.storeSummary(
        worker,
        { summary: "- old", foldedThrough: ago(3 * DAY_MS) },
        false,
      ),
    ).toBe(false);
    expect(
      await history.storeSummary(worker, { summary: "- new", foldedThrough: ago(1_000) }, false),
    ).toBe(true);
    // An expired record is replaced whatever its watermark says.
    expect(
      await history.storeSummary(worker, { summary: null, foldedThrough: ago(5 * DAY_MS) }, true),
    ).toBe(true);
    const live = await history.liveSummary(worker, NOW);
    expect(live).toEqual({ ok: true, value: { summary: null, foldedThrough: ago(5 * DAY_MS) } });
    // Judged as of a turn 9 days later, the conversation has expired.
    expect(await history.liveSummary(worker, new Date(NOW.getTime() + 9 * DAY_MS))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("the sweep deletes lines past 7 days and summaries with no live line — nothing else", async () => {
    const quiet = await newWorker();
    await line(worker, ago(10 * DAY_MS), { text: "old" });
    await line(worker, ago(DAY_MS), { text: "fresh" });
    await line(quiet, ago(9 * DAY_MS), { text: "old only" });
    await history.storeSummary(worker, { summary: "- kept", foldedThrough: ago(DAY_MS) }, true);
    await history.storeSummary(
      quiet,
      { summary: "- expired", foldedThrough: ago(9 * DAY_MS) },
      true,
    );
    const result = await history.sweep(NOW);
    expect(result.tablesMissing).toBe(false);
    expect(result.linesDeleted).toBeGreaterThanOrEqual(2);
    const left = await client.sql<{ body_text: string }[]>`
      SELECT body_text FROM companion_messages
      WHERE worker_id IN (${worker}::uuid, ${quiet}::uuid) ORDER BY created_at`;
    expect(left.map((r) => r.body_text)).toEqual(["fresh"]);
    const summaries = await client.sql<{ worker_id: string }[]>`
      SELECT worker_id FROM companion_conversation_summaries
      WHERE worker_id IN (${worker}::uuid, ${quiet}::uuid)`;
    expect(summaries.map((r) => r.worker_id)).toEqual([worker]);
  });

  it("erasure: deleting the worker removes his lines and his summary (ON DELETE CASCADE)", async () => {
    await line(worker, ago(1_000));
    await history.storeSummary(worker, { summary: "- x", foldedThrough: ago(1_000) }, true);
    await client.sql`DELETE FROM workers WHERE id = ${worker}::uuid`;
    const [{ lines } = { lines: -1 }] = await client.sql<{ lines: number }[]>`
      SELECT count(*)::int AS lines FROM companion_messages WHERE worker_id = ${worker}::uuid`;
    const [{ notes } = { notes: -1 }] = await client.sql<{ notes: number }[]>`
      SELECT count(*)::int AS notes FROM companion_conversation_summaries
      WHERE worker_id = ${worker}::uuid`;
    expect([lines, notes]).toEqual([0, 0]);
  });

  it("the history read is one index scan of companion_messages_worker_created_idx, with no sort", async () => {
    for (let i = 0; i < 30; i++) await line(worker, ago(i * 1_000));
    await client.sql`ANALYZE companion_messages`;
    // ONE connection for the settings and the EXPLAIN (the client is a pool). Seq and bitmap scans
    // are switched off so the plan is the index's: were its order not the query's (the NULLS
    // FIRST lesson of chat_messages_session_created_idx), a Sort node would still appear.
    const text = await client.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      const plan = await tx<{ "QUERY PLAN": string }[]>`
        EXPLAIN SELECT id FROM companion_messages
        WHERE worker_id = ${worker}::uuid AND created_at > ${ago(7 * DAY_MS).toISOString()}::timestamptz
        ORDER BY created_at DESC LIMIT 200`;
      return plan.map((r) => r["QUERY PLAN"]).join(" | ");
    });
    expect(text).toContain("Index Scan using companion_messages_worker_created_idx");
    expect(text).not.toContain("Sort");
  });
});

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { payerJobPostingChatSessions, type Database } from "@badabhai/db";
import {
  JOB_POSTING_CHAT_LIVE_STATUSES,
  JobPostingChatRepository,
} from "./job-posting-chat.repository";

/**
 * STRUCTURAL pins for the two guarded writes behind #1922 (R52).
 *
 * A message turn reads the session as live, then waits seconds on the ai-service; a publish
 * can claim the session in that window. Two predicates keep that race from reopening a
 * published session and duplicating its posting:
 *
 *   - `saveTurn` writes only while the status is still live, so the late turn stores nothing;
 *   - `claimForPublish` also requires `published_job_posting_id IS NULL`, so a session bound
 *     to a posting can never be claimed a second time.
 *
 * Both read the one `JOB_POSTING_CHAT_LIVE_STATUSES` list the service's 409 checks read.
 *
 * The service suite fakes this repository, so both claims live only in these WHERE clauses.
 * Same capture-and-compile pattern as `chat.repository.test.ts`; that the predicates EVALUATE
 * as claimed under an interleaved claim and turn is `job-posting-chat.repository.db.test.ts`.
 */

const dialect = new PgDialect();

const SESSION = "cccccccc-0000-4000-8000-000000000003";
const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";

function makeUpdateDb(returned: unknown[]) {
  const captured: { table?: unknown; set?: Record<string, unknown>; where?: unknown } = {};
  const db = {
    update: (table: unknown) => {
      captured.table = table;
      return {
        set: (patch: Record<string, unknown>) => {
          captured.set = patch;
          return {
            where: (predicate: unknown) => {
              captured.where = predicate;
              return { returning: () => Promise.resolve(returned) };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { db, captured };
}

const render = (predicate: unknown) => dialect.sqlToQuery(predicate as SQL);

describe("JobPostingChatRepository.saveTurn — only a live session takes the write (#1922)", () => {
  const turnPatches = {
    "a state-carrying turn": {
      conversationState: { turn_count: 3 },
      draft: { role_title: "CNC Operator" },
      status: "active" as const,
      lastMessageAt: new Date("2026-10-03T00:00:00.000Z"),
    },
    "a blocked turn (activity clock only)": {
      lastMessageAt: new Date("2026-10-03T00:00:00.000Z"),
    },
  };

  for (const [label, patch] of Object.entries(turnPatches)) {
    it(`${label}: scoped to id + owner + a live status, binding exactly those values`, async () => {
      const { db, captured } = makeUpdateDb([{ id: SESSION }]);
      await new JobPostingChatRepository(db).saveTurn(SESSION, PAYER, patch);

      expect(captured.table).toBe(payerJobPostingChatSessions);
      const q = render(captured.where);
      expect(q.sql).toBe(
        '("payer_job_posting_chat_sessions"."id" = $1 and ' +
          '"payer_job_posting_chat_sessions"."payer_id" = $2 and ' +
          '"payer_job_posting_chat_sessions"."status" in ($3, $4))',
      );
      // `published` and `abandoned` are not in the list, so a turn can revive neither.
      expect(q.params).toEqual([SESSION, PAYER, "active", "draft_ready"]);
    });
  }

  it("the live list is exactly the two statuses a turn may write into", () => {
    expect([...JOB_POSTING_CHAT_LIVE_STATUSES]).toEqual(["active", "draft_ready"]);
  });

  it("reports TRUE when the guarded UPDATE wrote the row", async () => {
    const { db } = makeUpdateDb([{ id: SESSION }]);
    await expect(
      new JobPostingChatRepository(db).saveTurn(SESSION, PAYER, { lastMessageAt: new Date() }),
    ).resolves.toBe(true);
  });

  it("reports FALSE when it matched nothing — the turn that lost the race to a publish", async () => {
    // Without `.returning()` there is no way to tell a write from a no-op, and the service
    // would answer a turn whose state never landed as if it had.
    const { db } = makeUpdateDb([]);
    await expect(
      new JobPostingChatRepository(db).saveTurn(SESSION, PAYER, { lastMessageAt: new Date() }),
    ).resolves.toBe(false);
  });
});

describe("JobPostingChatRepository.claimForPublish — a session bound to a posting is never claimed again (#1922)", () => {
  it("requires a live status AND no bound posting, under the owner scope", async () => {
    const at = new Date("2026-10-03T00:00:00.000Z");
    const { db, captured } = makeUpdateDb([{ id: SESSION }]);
    await new JobPostingChatRepository(db).claimForPublish(SESSION, PAYER, at);

    expect(captured.table).toBe(payerJobPostingChatSessions);
    expect(captured.set).toEqual({ status: "published", endedAt: at });
    const q = render(captured.where);
    expect(q.sql).toBe(
      '("payer_job_posting_chat_sessions"."id" = $1 and ' +
        '"payer_job_posting_chat_sessions"."payer_id" = $2 and ' +
        '"payer_job_posting_chat_sessions"."status" in ($3, $4) and ' +
        '"payer_job_posting_chat_sessions"."published_job_posting_id" is null)',
    );
    // The same live list as `saveTurn` and the service's read-time check: neither a
    // `published` nor an `abandoned` session can be claimed.
    expect(q.params).toEqual([SESSION, PAYER, "active", "draft_ready"]);
  });

  it("the loser of the claim gets undefined — the service's 409, having created nothing", async () => {
    const { db } = makeUpdateDb([]);
    await expect(
      new JobPostingChatRepository(db).claimForPublish(SESSION, PAYER, new Date()),
    ).resolves.toBeUndefined();
  });
});

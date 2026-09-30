import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

import { GeneralRoadRepository } from "./general-road.repository";

/**
 * Statement facts for the general road's two provenance reads (ADR-0045 Phase 5) — what the
 * repository BUILDS, not what Postgres does with it (the `chat-companion.repository.test.ts`
 * pattern).
 *
 * THE PROPERTY THAT MATTERS is that every table the walk touches is scoped to the résumé's
 * worker: the résumé row, the profile, the extraction job's own `input_ref->>'worker_id'` and
 * the session. A foreign profile, job or session must never be able to answer for this résumé.
 */
const dialect = new PgDialect();
const compile = (node: unknown) => {
  const c = dialect.sqlToQuery(sql`${node}` as SQL);
  return { sql: c.sql.replace(/\s+/g, " "), params: c.params };
};

const RESUME = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

interface Captured {
  selection?: Record<string, unknown>;
  joins: unknown[];
  where?: unknown;
  limit?: number;
}

function makeDb(rows: unknown[]) {
  const q: Captured = { joins: [] };
  const node: Record<string, unknown> = {
    from: () => node,
    innerJoin: (_table: unknown, on: unknown) => {
      q.joins.push(on);
      return node;
    },
    where: (c: unknown) => {
      q.where = c;
      return node;
    },
    limit: (n: number) => {
      q.limit = n;
      return Promise.resolve(rows);
    },
  };
  const db = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      q.selection = selection;
      return node;
    }),
  };
  return { repo: new GeneralRoadRepository(db as never), q, db };
}

describe("findResumeExtractionSessionId — the résumé → profile → extraction job walk", () => {
  it("joins on the two provenance links and scopes EVERY table to the worker, one row", async () => {
    const { repo, q } = makeDb([{ sessionId: SESSION }]);
    expect(await repo.findResumeExtractionSessionId(RESUME, WORKER)).toBe(SESSION);

    // The links, and only these: the résumé's profile, then that profile's own job.
    expect(q.joins.map((j) => compile(j).sql)).toEqual([
      '"worker_profiles"."id" = "generated_resumes"."profile_id"',
      '"ai_jobs"."id" = "worker_profiles"."ai_job_id"',
    ]);

    const { sql: text, params } = compile(q.where);
    // A CONJUNCTION — an `or` anywhere at the top would let another worker's row answer.
    expect(text).not.toMatch(/ or /i);
    expect(text).toContain('"generated_resumes"."id" = $1');
    expect(text).toContain('"generated_resumes"."worker_id" = $2');
    expect(text).toContain('"worker_profiles"."worker_id" = $3');
    expect(text).toContain('"ai_jobs"."job_type" = $4');
    expect(text).toContain(`"ai_jobs"."input_ref"->>'worker_id' = $5`);
    expect(params).toEqual([RESUME, WORKER, WORKER, "profile_extraction", WORKER]);
    expect(q.limit).toBe(1);

    // It SELECTS the job's session id and nothing else — no worker text crosses this read.
    expect(Object.keys(q.selection ?? {})).toEqual(["sessionId"]);
    expect(compile(q.selection!.sessionId).sql).toBe(`"ai_jobs"."input_ref"->>'session_id'`);
  });

  it("no such résumé, a profile with no job, or a job with no session → null", async () => {
    expect(await makeDb([]).repo.findResumeExtractionSessionId(RESUME, WORKER)).toBeNull();
    expect(
      await makeDb([{ sessionId: null }]).repo.findResumeExtractionSessionId(RESUME, WORKER),
    ).toBeNull();
  });
});

describe("findSessionGeneralRoad — the session's stamp, and only the stamp", () => {
  it("reads THIS worker's session by id, selecting the general_road key alone", async () => {
    const stamp = { v: 1, handed_over: true };
    const { repo, q } = makeDb([{ generalRoad: stamp }]);
    expect(await repo.findSessionGeneralRoad(SESSION, WORKER)).toEqual({ generalRoad: stamp });

    const { sql: text, params } = compile(q.where);
    expect(text).toBe('("chat_sessions"."id" = $1 and "chat_sessions"."worker_id" = $2)');
    expect(params).toEqual([SESSION, WORKER]);
    expect(q.limit).toBe(1);
    // NOT the whole `conversation_state`: the rest of it is the answer map — worker text this
    // read has no use for.
    expect(Object.keys(q.selection ?? {})).toEqual(["generalRoad"]);
    expect(compile(q.selection!.generalRoad).sql).toBe(
      `"chat_sessions"."conversation_state"->'general_road'`,
    );
  });

  it("another worker's session, or none, is undefined", async () => {
    expect(await makeDb([]).repo.findSessionGeneralRoad(SESSION, WORKER)).toBeUndefined();
  });
});

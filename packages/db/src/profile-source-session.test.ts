import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { CURRENT_PROFILE_ORDER, PROFILE_SOURCE_SESSION_ANSWERS } from "./current-profile";
import { workerProfiles } from "./schema";

/**
 * #2075 — `PROFILE_SOURCE_SESSION_ANSWERS` as BOTH writers actually compose it: inside the select
 * list of a single-table `worker_profiles` read. Drizzle renders a column object interpolated into
 * such a fragment UNQUALIFIED, which once shipped as `"worker_id" = "worker_id"` and
 * `"id" = "ai_job_id"` and failed in Postgres. This pins the rendered text of the real query.
 */
function renderedProfileRead(): string {
  return new QueryBuilder()
    .select({
      canonicalRoleId: workerProfiles.canonicalRoleId,
      sourceSession: PROFILE_SOURCE_SESSION_ANSWERS,
    })
    .from(workerProfiles)
    .orderBy(...CURRENT_PROFILE_ORDER)
    .limit(1)
    .toSQL().sql;
}

describe("PROFILE_SOURCE_SESSION_ANSWERS renders fully qualified inside a profile read", () => {
  const text = renderedProfileRead();
  const subquery = text.slice(text.indexOf("select jsonb_build_object"));

  it("aliases the subquery's own tables", () => {
    expect(subquery).toContain('from "ai_jobs" as "src_aj"');
    expect(subquery).toContain('inner join "chat_sessions" as "src_cs"');
  });

  it("correlates to the OUTER worker_profiles row by its table name", () => {
    expect(subquery).toContain('"src_cs"."worker_id" = "worker_profiles"."worker_id"');
    expect(subquery).toContain('"src_aj"."id" = "worker_profiles"."ai_job_id"');
  });

  it("joins the job to its session by text, and filters to extraction jobs", () => {
    expect(subquery).toContain(`"src_cs"."id"::text = "src_aj"."input_ref" ->> 'session_id'`);
    expect(subquery).toContain(`"src_aj"."job_type" = 'profile_extraction'`);
  });

  it("reads exactly four state keys off the aliased session", () => {
    for (const key of ["pack_id", "answer_map", "llm_led_turns", "llm_draft_settled"]) {
      expect(subquery).toContain(`'${key}', "src_cs"."conversation_state" -> '${key}'`);
    }
    expect(subquery.match(/conversation_state/g)).toHaveLength(4);
  });

  it("has no bare (unqualified) column reference anywhere in the subquery", () => {
    const end = subquery.indexOf("limit 1");
    const body = subquery.slice(0, end);
    // Every quoted identifier is a table/alias followed by `.`, or a column preceded by `.`.
    const bare = [...body.matchAll(/(?<![.\w])"([a-z_]+)"(?!\.)/g)]
      .map((m) => m[1])
      .filter((name) => !["ai_jobs", "chat_sessions", "src_aj", "src_cs"].includes(name!));
    expect(bare).toEqual([]);
  });
});

import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as dsql } from "drizzle-orm";
import { createDbClient, type DbClient } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { MatchFeedService } from "./match-feed.service";

/**
 * THE MATCHING V1 DEMO SEED, AGAINST A REAL POSTGRES AND THE REAL FEED.
 *
 * Runs the actual CLI (`packages/db/src/seed-demo-matching.ts`) at a small profile — 5 personas,
 * 60 postings — so the ops guard, the publish-rule reach resolution and D5's own
 * `materializePostingReach` are all exercised as shipped. Then, per persona, through the SHIPPED
 * `MatchFeedRepository` / `MatchFeedService`:
 *
 *   1. every visible posting's stored reach set intersects a skill the persona wants;
 *   2. no demo posting outside the persona's reach is visible, and every one inside it is;
 *   3. a related-only posting (names no wanted skill) carries tier 2 / `via_related`;
 *   4. THE ANSWER KEY'S TOP 10 IS THE REAL FEED'S TOP 10. The seed computes its key with a
 *      mirror of `listFeed`'s ORDER BY + the interleave; this pins the mirror to the service, so
 *      a change to the V1 feed order fails HERE until the seed follows.
 *
 * The events sink is a no-op: this proves ordering and membership, and `feed.shown_v2` emission
 * is covered by the service's own tests.
 *
 * LOCAL DATABASES ONLY — the seed refuses a production-like target without explicit signals, and
 * this file refuses one outright. Cleans up with the seed's own `--unseed`.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test demo-matching-seed.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml` (after `db:seed:match:vocabulary`).
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const REPO_ROOT = resolve(__dirname, "../../../..");
const CTX: RequestContext = {
  correlationId: "00000000-0000-4000-8000-0000de300001",
  requestId: "demo-seed-db",
};
const NO_EVENTS = { emitMany: async () => undefined } as unknown as EventsService;

interface KeyCard {
  jobPostingId: string;
  tier: 1 | 2;
}
interface KeyPersona {
  key: string;
  workerId: string;
  skills: Array<{ skillId: string }>;
  visible: number;
  direct: number;
  related: number;
  hidden: number;
  top10: KeyCard[];
}

function isLocal(url: string): boolean {
  try {
    return /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function runSeed(args: string[]): string {
  return execFileSync(
    "pnpm",
    ["--filter", "@badabhai/db", "exec", "tsx", "src/seed-demo-matching.ts", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL,
        // Synthetic test crypto when the job supplies none (CI: NODE_ENV=test, no real secrets).
        PII_ENCRYPTION_KEY:
          process.env.PII_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64"),
        PII_HASH_PEPPER: process.env.PII_HASH_PEPPER ?? "demo-matching-db-test-pepper",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
}

describe.skipIf(!RUN)("demo matching seed — reach + real feed order (DB)", () => {
  let client: DbClient;
  let feed: MatchFeedService;
  let repo: MatchFeedRepository;
  let personas: KeyPersona[];
  let postings: Map<string, { match: string[]; reach: string[] }>;
  let workDir: string;

  beforeAll(async () => {
    if (!isLocal(DATABASE_URL))
      throw new Error("demo-matching-seed.db refuses a non-local DATABASE_URL");
    workDir = mkdtempSync(join(tmpdir(), "demo-seed-"));
    const keyPath = join(workDir, "key.json");
    runSeed(["--apply", "--personas=5", "--postings=60", `--answer-key=${keyPath}`]);
    personas = (JSON.parse(readFileSync(keyPath, "utf8")) as { personas: KeyPersona[] }).personas;

    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new MatchFeedRepository(client.db);
    feed = new MatchFeedService(
      repo,
      new MatchConfigService(new MatchConfigRepository(client.db)),
      NO_EVENTS,
    );

    const rows = (await client.db.execute(dsql`
      SELECT id::text AS id, match_skill_ids AS m, reach_skill_ids AS r FROM job_postings
      WHERE id::text LIKE 'de303000-0000-4000-8000-%' AND status = 'open'`)) as unknown as Array<{
      id: string;
      m: string[];
      r: string[];
    }>;
    postings = new Map(rows.map((r) => [r.id, { match: r.m, reach: r.r }]));
  }, 180_000);

  afterAll(async () => {
    try {
      if (RUN && isLocal(DATABASE_URL)) runSeed(["--unseed", "--apply"]);
    } finally {
      await client?.sql.end({ timeout: 5 });
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("seeded the small profile: 5 personas, 60 open demo postings", () => {
    expect(personas).toHaveLength(5);
    expect(postings.size).toBe(60);
  });

  it("membership: exactly the persona's reach is visible, with the right tier", async () => {
    for (const p of personas) {
      const wants = new Set(p.skills.map((s) => s.skillId));
      // The real repository, wide enough to hold the whole set (60 postings < 300).
      const rows = await repo.listFeed(p.workerId, 300, {});
      const visible = new Map(
        rows.filter((r) => postings.has(r.jobPostingId)).map((r) => [r.jobPostingId, r]),
      );

      for (const [id, row] of visible) {
        const posting = postings.get(id)!;
        expect(
          posting.reach.some((s) => wants.has(s)),
          `${p.key}: ${id} visible outside reach`,
        ).toBe(true);
        const direct = posting.match.some((s) => wants.has(s));
        expect(row.matchTier, `${p.key}: ${id} tier`).toBe(direct ? 1 : 2);
      }
      for (const [id, posting] of postings) {
        if (posting.reach.some((s) => wants.has(s))) {
          expect(visible.has(id), `${p.key}: ${id} in reach but not visible`).toBe(true);
        }
      }
      const tier2 = [...visible.values()].filter((r) => r.matchTier === 2).length;
      expect(tier2, `${p.key}: related-only set`).toBeGreaterThan(0);
      expect(visible.size - tier2, `${p.key}: direct set`).toBeGreaterThan(0);
      expect(postings.size - visible.size, `${p.key}: hidden set`).toBeGreaterThan(0);
      // The answer key's counts agree with the real read.
      expect(p.visible).toBe(rows.length);
      expect(p.direct + p.related).toBe(rows.length);
      expect(p.hidden).toBe(postings.size - visible.size);
    }
  });

  it("order: the answer key's top 10 is what the real MatchFeedService serves", async () => {
    for (const p of personas) {
      const { jobs } = await feed.getFeed(p.workerId, 50, {}, CTX);
      expect(
        jobs.slice(0, 10).map((j) => [j.job_id, j.via_related ? 2 : 1]),
        `${p.key}: answer-key order drifted from the V1 feed — update feedOrderSql in packages/db/src/seed-demo-matching.ts`,
      ).toEqual(p.top10.map((c) => [c.jobPostingId, c.tier]));
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, events, skills, workerSkills, type DbClient } from "@badabhai/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * E4 CLEAR-ALL — THE `cleared` COUNT, OVER REAL SQL (#1850)
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `POST /workers/me/match-skills/clear-all` answers `{ ok: true, cleared: N }`. The contract
 * (controller, service and repository docstrings; #1828/#1831) is that N is honest and a repeat
 * tap reports 0. Before #1850 the repository returned `RETURNING skill_id`.length of an UPDATE
 * that — deliberately — has no `wants = true` predicate (already-declined rows must be
 * re-stamped `source='interview'` so the coarse re-derivation cannot overwrite them). So N was
 * EVERY row the worker held, including rows already off and rows outside the closed `mskill_*`
 * vocabulary the page never lists, and the repeat call reported the same N.
 *
 * THE UNIT SUITE COULD NOT SEE IT. The repository test stubbed the UPDATE's result rows
 * (`updateRows: [[]]` for the "second call clears 0" case) — a shape real Postgres never
 * returns for a worker who holds rows. Only executing the statement settles what RETURNING
 * returns, so this file drives the real route against the real database.
 *
 * WHAT `cleared` MEANS (backend decision recorded on #1850): the number of the worker's MATCH
 * SKILLS (`isMatchSkillId`, the closed set `GET /workers/me/match-skills` lists and the
 * worker-app counts) that were ON before the call and are OFF after it. Out-of-vocabulary rows
 * are still re-stamped but never counted.
 *
 * THE FIXTURE, chosen so every wrong answer is a DIFFERENT number:
 *
 *   | skill                    | wants before | counted? | why it is here                     |
 *   | ------------------------ | ------------ | -------- | ---------------------------------- |
 *   | mskill_cnc_turner        | true         | yes      | an ON match skill                  |
 *   | mskill_vmc_operator      | true         | yes      | an ON match skill                  |
 *   | mskill_hmc_operator      | false        | no       | already off — re-stamped only      |
 *   | skill_e2e_1850_oov_*     | true         | no       | outside the closed set — never a   |
 *   |                          |              |          | match skill, never listed          |
 *
 *   honest = 2 · every row = 4 · every wanted row = 3 · every match skill = 3 · repeat = 0.
 *
 * Plus a BYSTANDER worker holding one wanted match skill: proves the consent gate refuses an
 * unconsented caller with nothing written, and that one worker's exit never touches (or counts)
 * another worker's rows — the predicate a `SELECT ... FOR UPDATE` count could silently drop.
 *
 * Opt-in, same lane as the rest of this suite (the route is NOT behind MATCH_V1_ENABLED —
 * `MatchModule` registers `WorkerMatchSkillsController` unconditionally):
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate && pnpm --filter @badabhai/db db:seed:match:vocabulary --apply
 *   3. TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars> pnpm --filter @badabhai/api start
 *   4. RUN_E2E=1 TEST_LOGIN_TOKEN=<same> pnpm --filter @badabhai/e2e test
 */

const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
// Without the token there is no way to authenticate a worker (OTP is real-provider-only), so
// the suite would fail rather than test anything — skip honestly instead.
const RUN = process.env.RUN_E2E === "1" && TEST_LOGIN_TOKEN.length > 0;
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** Must match the API's CURRENT consent version — the gate compares against it. */
const CONSENT_VERSION = "2026-06-01";
const PURPOSES = ["profiling", "resume_generation"] as const;

const INDUSTRY = "ind_industrial_manufacturing";
const WANTS_EVENT = "worker.match_skill_wants_set";

// Closed-vocabulary ids from `MATCH_SKILLS` (@badabhai/taxonomy, packages/taxonomy/src/
// match-skills.ts) — the set `isMatchSkillId` checks. Hard-coded rather than imported because
// this package does not depend on @badabhai/taxonomy; the GET before the exit proves at runtime
// that the API treats all three as match skills (it lists only closed-set rows).
const ON_SKILLS = ["mskill_cnc_turner", "mskill_vmc_operator"] as const;
const OFF_SKILL = "mskill_hmc_operator";
const VOCABULARY: ReadonlyArray<{ skillId: string; labelEn: string }> = [
  { skillId: "mskill_cnc_turner", labelEn: "CNC Turner" },
  { skillId: "mskill_vmc_operator", labelEn: "VMC Operator" },
  { skillId: "mskill_hmc_operator", labelEn: "HMC Operator" },
];

/**
 * A REAL `skill` row (the `worker_skill.skill_id` FK demands one) that is not a match skill.
 * Unique per run so a crashed run's leftovers can never collide with this one, and deleted in
 * `afterAll`.
 */
const OOV_SKILL = `skill_e2e_1850_oov_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

const SEEDED_AT = new Date("2020-01-01T00:00:00.000Z");
const MATCH_SKILL_IDS = [...ON_SKILLS, OFF_SKILL].sort();
const ALL_SEEDED_SKILL_IDS = [...ON_SKILLS, OFF_SKILL, OOV_SKILL];

interface Resp {
  status: number;
  body: any;
}

interface MintedWorker {
  workerId: string;
  token: string;
}

interface MatchSkillView {
  skill_id: string;
  label: string;
  wants: boolean;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; testLogin?: boolean } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.testLogin) headers["x-test-login-token"] = TEST_LOGIN_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

/** A phone inside the reserved synthetic block the test-login seam serves: `+9100000#####`. */
const syntheticPhone = (): string =>
  `+9100000${String(Math.floor(Math.random() * 100_000)).padStart(5, "0")}`;

/**
 * Mint a BRAND-NEW worker through the D-3 seam. The mint find-or-creates by phone hash, so a
 * random phone could land on a worker an earlier run left behind — holding consent or
 * `worker_skill` rows that would silently change every count below. `is_new_worker` is the
 * server's own answer to "is this a clean slate", so retry until it says yes.
 */
async function mintFreshWorker(): Promise<MintedWorker> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await call("POST", "/auth/test-login", {
      body: { phone: syntheticPhone() },
      testLogin: true,
    });
    expect(
      r.status,
      "POST /auth/test-login must be armed: TEST_LOGIN_ENABLED=true and a >=32-char " +
        "TEST_LOGIN_TOKEN on BOTH the API process and this runner",
    ).toBe(200);
    if (r.body.is_new_worker === true) {
      return { workerId: r.body.worker_id as string, token: r.body.access_token as string };
    }
  }
  throw new Error("could not mint a NEW synthetic worker in 10 attempts");
}

async function acceptConsent(token: string): Promise<void> {
  const r = await call("POST", "/consent/accept", {
    token,
    body: { consent_version: CONSENT_VERSION, purposes: PURPOSES },
  });
  expect(r.status, `POST /consent/accept -> ${JSON.stringify(r.body)}`).toBe(201);
}

describe.skipIf(!RUN)("E4 clear-all — honest `cleared` count over real SQL (#1850)", () => {
  let client!: DbClient;
  let worker!: MintedWorker;
  /** Holds one wanted match skill and NEVER consents. */
  let bystander!: MintedWorker;
  /** The bystander's row as seeded, compared field-for-field after the worker's exit. */
  let bystanderBefore!: WorkerSkillState[];

  type WorkerSkillState = Awaited<ReturnType<typeof rowsFor>>[number];

  async function rowsFor(workerId: string) {
    return client.db
      .select({
        skillId: workerSkills.skillId,
        wants: workerSkills.wants,
        source: workerSkills.source,
        updatedAt: workerSkills.updatedAt,
      })
      .from(workerSkills)
      .where(eq(workerSkills.workerId, workerId))
      .orderBy(workerSkills.skillId);
  }

  async function clearAll(token: string): Promise<Resp> {
    return call("POST", "/workers/me/match-skills/clear-all", { token });
  }

  async function listMatchSkills(token: string): Promise<MatchSkillView[]> {
    const r = await call("GET", "/workers/me/match-skills", { token });
    expect(r.status, `GET /workers/me/match-skills -> ${JSON.stringify(r.body)}`).toBe(200);
    return r.body.skills as MatchSkillView[];
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);

    // The D1 seed (`db:seed:match:vocabulary --apply`) already wrote these in CI; ON CONFLICT
    // DO NOTHING makes the suite self-sufficient on a migrated-only database without ever
    // rewriting a vocabulary row. Never deleted: they are the real vocabulary, not fixtures.
    await client.db
      .insert(skills)
      .values(
        VOCABULARY.map((v) => ({
          ...v,
          source: "rvm" as const,
          status: "active" as const,
          kind: "match_skill" as const,
          industryId: INDUSTRY,
        })),
      )
      .onConflictDoNothing();
    // The out-of-vocabulary row: a real `skill` row of kind 'attribute', so the FK holds, but
    // not an `mskill_*` id — exactly what `isMatchSkillId` rejects.
    await client.db.insert(skills).values({
      skillId: OOV_SKILL,
      labelEn: "E2E #1850 out-of-vocabulary skill",
      source: "rvm",
      status: "provisional",
      kind: "attribute",
      industryId: INDUSTRY,
    });

    worker = await mintFreshWorker();
    await acceptConsent(worker.token);
    bystander = await mintFreshWorker();

    // Every row starts `derived_coarse` with an old stamp, so "re-stamped" is observable on
    // EVERY row, including the two the count must ignore.
    const seed = (skillId: string, wants: boolean) => ({
      workerId: worker.workerId,
      skillId,
      industryId: INDUSTRY,
      monthsBucketed: 36,
      wants,
      source: "derived_coarse" as const,
      updatedAt: SEEDED_AT,
    });
    await client.db
      .insert(workerSkills)
      .values([
        seed(ON_SKILLS[0], true),
        seed(ON_SKILLS[1], true),
        seed(OFF_SKILL, false),
        seed(OOV_SKILL, true),
      ]);
    await client.db.insert(workerSkills).values({
      workerId: bystander.workerId,
      skillId: ON_SKILLS[1],
      industryId: INDUSTRY,
      monthsBucketed: 24,
      wants: true,
      source: "derived_coarse",
      updatedAt: SEEDED_AT,
    });
    bystanderBefore = await rowsFor(bystander.workerId);
  });

  afterAll(async () => {
    if (!client) return;
    // CHILDREN BEFORE PARENTS: the worker_skill rows reference the OOV skill row. The minted
    // workers themselves stay, like every other seam suite (synthetic-range phones only).
    const workerIds = [worker?.workerId, bystander?.workerId].filter(
      (id): id is string => typeof id === "string",
    );
    if (workerIds.length > 0) {
      await client.db.delete(workerSkills).where(inArray(workerSkills.workerId, workerIds));
    }
    await client.db.delete(skills).where(eq(skills.skillId, OOV_SKILL));
    await client.sql.end({ timeout: 5 });
  });

  it("the page lists the three closed-set rows as seeded, and never the out-of-vocabulary one", async () => {
    // Proves the fixture means what the table above says, from the API's own perspective:
    // all three `mskill_*` ids are match skills to it, and the OOV id is not.
    const listed = await listMatchSkills(worker.token);
    expect(listed.map((s) => [s.skill_id, s.wants])).toEqual([
      ["mskill_cnc_turner", true],
      ["mskill_hmc_operator", false],
      ["mskill_vmc_operator", true],
    ]);
    expect(listed.map((s) => s.skill_id)).not.toContain(OOV_SKILL);
  });

  it("an UNCONSENTED caller is refused and nothing of his moves", async () => {
    const r = await clearAll(bystander.token);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await rowsFor(bystander.workerId)).toEqual(bystanderBefore);
  });

  it("the FIRST call reports exactly the match skills it switched off: 2", async () => {
    const r = await clearAll(worker.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 4 = every row (the #1850 defect), 3 = every wanted row (counts the OOV row) or every
    // match skill (counts the already-off one). Only 2 is the honest answer.
    expect(r.body).toEqual({ ok: true, cleared: 2 });
  });

  it("EVERY row is re-stamped off and interview-owned — the already-off and the OOV row too", async () => {
    // The count is the only thing #1850 changes. The re-stamp of rows the count ignores is
    // what keeps the exit durable (a `derived_coarse` row is re-derivable; `interview` is not),
    // so a fix that narrowed the UPDATE to `wants = true` would fail here, not above.
    const rows = await rowsFor(worker.workerId);
    expect(rows.map((r) => r.skillId).sort()).toEqual([...ALL_SEEDED_SKILL_IDS].sort());
    for (const row of rows) {
      expect(row.wants, `${row.skillId} wants`).toBe(false);
      expect(row.source, `${row.skillId} source`).toBe("interview");
      expect(row.updatedAt.getTime(), `${row.skillId} updated_at`).toBeGreaterThan(
        SEEDED_AT.getTime(),
      );
    }
  });

  it("another worker's rows are neither touched nor counted", async () => {
    expect(await rowsFor(bystander.workerId)).toEqual(bystanderBefore);
  });

  it("a REPEAT call reports 0 and leaves every row off", async () => {
    const r = await clearAll(worker.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, cleared: 0 });

    const rows = await rowsFor(worker.workerId);
    expect(rows).toHaveLength(ALL_SEEDED_SKILL_IDS.length);
    for (const row of rows) {
      expect(row.wants, `${row.skillId} wants`).toBe(false);
      expect(row.source, `${row.skillId} source`).toBe("interview");
    }
  });

  it("the page now lists every match skill OFF, and still never the out-of-vocabulary one", async () => {
    const listed = await listMatchSkills(worker.token);
    expect(listed.map((s) => s.skill_id)).toEqual(MATCH_SKILL_IDS);
    for (const s of listed) {
      expect(s.wants, `${s.skill_id} wants`).toBe(false);
      expect(s.label, `${s.skill_id} label`).toBeTruthy();
    }
    expect(listed.map((s) => s.skill_id)).not.toContain(OOV_SKILL);
  });

  it("each call emits ONE worker.match_skill_wants_set carrying no count; the refusal emits none", async () => {
    const mine = await client.db
      .select()
      .from(events)
      .where(and(eq(events.eventName, WANTS_EVENT), eq(events.subjectId, worker.workerId)));
    expect(mine, "one event per clear-all call (two calls)").toHaveLength(2);
    for (const e of mine) {
      expect(e.eventVersion).toBe(1);
      expect(e.actorType).toBe("worker");
      expect(e.actorId).toBe(worker.workerId);
      // EXACT equality: the payload schema is `.strict()`, and a `cleared`/count key here
      // would be supply breadth on the spine that no reader asked for.
      expect(e.payload).toEqual({ worker_id: worker.workerId, skill_id: null, wants: false });
    }

    const refused = await client.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.eventName, WANTS_EVENT), eq(events.subjectId, bystander.workerId)));
    expect(refused, "a consent-refused call reached no service code").toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import {
  createDbClient,
  type Database,
  type DbClient,
  profileCorrections,
  skills,
  workerProfiles,
  workerProfileSkills,
  workers,
} from "@badabhai/db";

import { ProfileCorrectionsRepository } from "./profile-corrections.repository";
import { ProfilesRepository } from "./profiles.repository";
import { ProfileSkillsRepository } from "./profile-skills.repository";

/**
 * #1311 backend half — the SQL truth behind the correction contract, against a real
 * Postgres (gated: RUN_DB_TESTS=1 + a migrated database, same convention as
 * `turner-reach.db.test.ts`).
 *
 * WHAT THIS PROVES (and the mocked service suite cannot): the check constraint holds
 * bad fields, the FK cascades, authored rows land `worker_confirmed` with NULL
 * confidence, display columns + raw profile move together, the experience merge
 * preserves sibling keys, and — the corrected-wins acceptance — the exact parse
 * `resume.service.ts` performs on the row (`DraftProfileSchema.parse(rawProfile)`)
 * yields the corrected values.
 *
 * Run: RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test extracted-corrections.db
 * (locally: E2E_DATABASE_URL=postgresql://badabhai:badabhai@127.0.0.1:5432/badabhai).
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0x1c01);
const PROFILE = uuid(0x1c02);
const SESSION = uuid(0x1c03);
// Real canonical ids (taxonomy SKILLS), so the FK and the DTO closed set agree.
const SKILL_A = "skill_fanuc";
const SKILL_B = "skill_gdt_reading";

describe.skipIf(!RUN)("extracted corrections — SQL truth", () => {
  let client: DbClient;
  let db: Database;
  let corrections: ProfileCorrectionsRepository;
  let profiles: ProfilesRepository;
  let profileSkills: ProfileSkillsRepository;
  // Skill ids this file inserted (not pre-seeded) — the only ones cleanup may delete.
  const ownedSkillIds: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    db = client.db;
    corrections = new ProfileCorrectionsRepository(db);
    profiles = new ProfilesRepository(db);
    profileSkills = new ProfileSkillsRepository(db);

    await db.delete(workers).where(eq(workers.id, WORKER));
    await db.insert(workers).values({
      id: WORKER,
      phoneE164: "v1.corrections-db-test",
      phoneHash: `corrections-db-test-${WORKER}`,
      status: "active" as const,
    });
    await db.insert(workerProfiles).values({
      id: PROFILE,
      workerId: WORKER,
      source: "chat",
      skills: ["skill_stale"],
      machines: ["mach_stale"],
      experience: { total_years: 5, summary: "old summary" },
      rawProfile: {
        skills: ["skill_stale"],
        machines: ["mach_stale"],
        experience: { total_years: 5, summary: "old summary" },
      },
    });
    for (const [skillId, labelEn] of [
      [SKILL_A, "Fanuc control operation"],
      [SKILL_B, "GD&T / drawing reading"],
    ] as const) {
      const existing = await db.select().from(skills).where(eq(skills.skillId, skillId));
      if (existing.length === 0) {
        await db.insert(skills).values({ skillId, labelEn, source: "rvm" as const });
        ownedSkillIds.push(skillId);
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await db.delete(workers).where(eq(workers.id, WORKER));
      for (const skillId of ownedSkillIds) {
        await db.delete(skills).where(eq(skills.skillId, skillId));
      }
      await client.sql.end();
    }
  });

  it("records one audit row per correction and counts the cap off them", async () => {
    const row = await corrections.insertCorrection({
      profileId: PROFILE,
      sessionId: SESSION,
      field: "skills",
    });
    expect(row.profileId).toBe(PROFILE);
    expect(row.sessionId).toBe(SESSION);
    expect(row.field).toBe("skills");
    expect(await corrections.countByProfile(PROFILE)).toBe(1);
  });

  it("refuses a sixth field at the database, not just the DTO", async () => {
    // postgres.js surfaces constraint violations as a failed query (the CHECK name
    // rides `cause`, not the message) — so this asserts refusal + an unchanged count,
    // with the profile/session FKs valid so only `pc_field_chk` can be the refuser.
    await expect(
      db.insert(profileCorrections).values({
        profileId: PROFILE,
        sessionId: SESSION,
        field: "salary",
      }),
    ).rejects.toThrow(/profile_correction/);
    expect(await corrections.countByProfile(PROFILE)).toBe(1);
  });

  it("skills replace writes worker_confirmed rows (NULL confidence) and moves display + snapshot together", async () => {
    const evidence = uuid(0x1c04);
    const { skillsWritten } = await profileSkills.replaceForProfile(
      PROFILE,
      [SKILL_A, SKILL_B],
      evidence,
    );
    expect(skillsWritten).toBe(2);
    const authored = await db
      .select()
      .from(workerProfileSkills)
      .where(eq(workerProfileSkills.workerProfileId, PROFILE));
    expect(authored.map((r) => r.skillId).sort()).toEqual([SKILL_A, SKILL_B]);
    for (const r of authored) {
      expect(r.source).toBe("worker_confirmed");
      expect(r.confidence).toBeNull();
      expect(r.evidenceRef).toBe(evidence);
    }

    await profiles.setSkillLists(PROFILE, [SKILL_A, SKILL_B]);
    const row = await profiles.findById(PROFILE);
    expect(row?.skills).toEqual([SKILL_A, SKILL_B]);
    // CORRECTED-WINS, exactly as generate reads it: the snapshot parses and yields them.
    const draft = DraftProfileSchema.parse(row?.rawProfile);
    expect(draft.skills).toEqual([SKILL_A, SKILL_B]);
  });

  it("skills re-replace drops removed ids (no linger beside the kept ones)", async () => {
    await profileSkills.replaceForProfile(PROFILE, [SKILL_A], uuid(0x1c05));
    const authored = await db
      .select()
      .from(workerProfileSkills)
      .where(eq(workerProfileSkills.workerProfileId, PROFILE));
    expect(authored.map((r) => r.skillId)).toEqual([SKILL_A]);
  });

  it("machines move display + snapshot together, verbatim", async () => {
    await profiles.setMachineLists(PROFILE, ["mach_cnc_lathe"]);
    const row = await profiles.findById(PROFILE);
    expect(row?.machines).toEqual(["mach_cnc_lathe"]);
    expect(DraftProfileSchema.parse(row?.rawProfile).machines).toEqual(["mach_cnc_lathe"]);
  });

  it("experience patches total_years and preserves sibling keys, on the column and the snapshot", async () => {
    await profiles.setExperienceTotal(PROFILE, 8);
    const row = await profiles.findById(PROFILE);
    expect(row?.experience).toMatchObject({ total_years: 8, summary: "old summary" });
    const draft = DraftProfileSchema.parse(row?.rawProfile);
    expect(draft.experience.total_years).toBe(8);
    expect(draft.experience.summary).toBe("old summary");
  });

  it("fails closed on a raw profile the schema cannot parse", async () => {
    // Corrupt an UNRELATED key: the patch always writes valid skills, so only a
    // mistyped sibling proves the shape guard runs. Stamping corrected values onto an
    // unreadable draft would fork the readers (generate parses this same column).
    // Sentinel first so this test does not depend on earlier tests' leftovers.
    await profiles.setSkillLists(PROFILE, ["skill_stale"]);
    await db
      .update(workerProfiles)
      .set({ rawProfile: { skills: ["skill_stale"], experience: "not-an-object" } })
      .where(eq(workerProfiles.id, PROFILE));
    await expect(profiles.setSkillLists(PROFILE, [SKILL_A])).rejects.toThrow();
    // …and the display column was not half-written either (read-then-validate-then-write).
    expect((await profiles.findById(PROFILE))?.skills).toEqual(["skill_stale"]);
  });
});

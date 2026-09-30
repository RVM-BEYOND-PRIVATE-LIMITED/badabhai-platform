import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import {
  type Database,
  workerProfiles,
  type WorkerProfile,
  type NewWorkerProfile,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

@Injectable()
export class ProfilesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Create a worker profile, idempotent per `ai_job_id` (TD14).
   *
   * The extraction processor creates the profile and THEN marks the ai_job
   * completed. If it dies in between (or a stalled job is redelivered), a naive
   * insert would orphan a second profile for the same job. With the unique
   * `ai_job_id`, the re-create hits `ON CONFLICT DO NOTHING` and we return the
   * already-stored profile instead — so a partial-success retry converges on one
   * row. Profiles with no `ai_job_id` (legacy/non-extraction) always insert,
   * since Postgres treats NULL keys as distinct.
   */
  async create(input: NewWorkerProfile): Promise<WorkerProfile> {
    const inserted = await this.db
      .insert(workerProfiles)
      .values(input)
      .onConflictDoNothing({ target: workerProfiles.aiJobId })
      .returning();
    const row = inserted[0];
    if (row) return row;

    // Conflict: a profile for this ai_job already exists (partial-success retry).
    // Return it so the caller proceeds idempotently with the canonical profile.
    if (input.aiJobId) {
      const existing = await this.findByAiJobId(input.aiJobId);
      if (existing) return existing;
    }
    throw new Error("Failed to create worker profile");
  }

  async findById(id: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.id, id))
      .limit(1);
    return rows[0];
  }

  /** The profile produced by a given extraction job, if any (TD14 idempotency). */
  async findByAiJobId(aiJobId: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.aiJobId, aiJobId))
      .limit(1);
    return rows[0];
  }

  async confirm(id: string, confirmedAt: Date): Promise<void> {
    await this.db
      .update(workerProfiles)
      .set({ profileStatus: "confirmed", confirmedAt, updatedAt: confirmedAt })
      .where(eq(workerProfiles.id, id));
  }

  /**
   * Apply a worker's corrected skill list (#1311 backend half).
   *
   * THREE STORES, ONE CALL, because three readers must agree: `worker_profiles.skills`
   * (the display source of record), `raw_profile.skills` (the generate snapshot —
   * this is what makes confirm render corrected), and the authored rows (written by
   * the caller through `ProfileSkillsRepository`, not here). The lists are verbatim —
   * validated closed ids in, same ids out, no derivation — so there is nothing here
   * for the fabrication gate to object to.
   *
   * The raw profile is re-validated through `DraftProfileSchema` after the merge (fail
   * closed on a row the schema cannot parse — that row is corrupt and stamping
   * corrected values onto an unreadable draft would fork the readers).
   */
  async setSkillLists(profileId: string, skillIds: readonly string[]): Promise<void> {
    const profile = await this.findById(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    const draft = DraftProfileSchema.parse({
      ...(typeof profile.rawProfile === "object" && profile.rawProfile !== null
        ? profile.rawProfile
        : {}),
      skills: [...skillIds],
    });
    await this.db
      .update(workerProfiles)
      .set({
        skills: [...skillIds],
        rawProfile: draft,
        updatedAt: new Date(),
      })
      .where(eq(workerProfiles.id, profileId));
  }

  /**
   * ADR-0046 T7 — the companion's RÉSUMÉ-ONLY skill labels (owner ruling 2026-09-28).
   *
   * WHAT IT WRITES, AND WHAT IT MUST NEVER WRITE. The résumé prints skills from the raw-profile
   * snapshot — the container's `resume_profile.skills` when it carries values, else the draft's
   * `skills` (canonical ids) and `skill_labels` (the worker's own words). This method replaces
   * whichever of those lists it is given, and touches NOTHING else: not the
   * `worker_profiles.skills` COLUMN (matching derives from it), not `worker_skill`, not
   * `job_reach`. A chat edit changes what the sheet says, never who the worker is matched to.
   *
   * It re-validates the merged draft through `DraftProfileSchema` before writing (fail closed on
   * a corrupt row), exactly as {@link setSkillLists} does.
   */
  async setResumeSkillLabels(
    profileId: string,
    next: {
      /** The container's own free-text list. */
      resumeProfileSkills?: readonly string[];
      /** The draft's canonical ids. */
      skills?: readonly string[];
      /** The draft's worker-typed labels. */
      skillLabels?: readonly string[];
    },
    tx?: Database,
  ): Promise<void> {
    const executor = tx ?? this.db;
    const rows = await executor
      .select({ rawProfile: workerProfiles.rawProfile })
      .from(workerProfiles)
      .where(eq(workerProfiles.id, profileId))
      .limit(1);
    const current = rows[0];
    if (!current) throw new Error(`Profile ${profileId} not found`);

    const base =
      typeof current.rawProfile === "object" && current.rawProfile !== null
        ? (current.rawProfile as Record<string, unknown>)
        : {};
    const draft = DraftProfileSchema.parse({
      ...base,
      ...(next.skills === undefined ? {} : { skills: [...next.skills] }),
      ...(next.skillLabels === undefined ? {} : { skill_labels: [...next.skillLabels] }),
      ...(next.resumeProfileSkills === undefined
        ? {}
        : {
            resume_profile: {
              ...(typeof base.resume_profile === "object" && base.resume_profile !== null
                ? (base.resume_profile as Record<string, unknown>)
                : {}),
              skills: [...next.resumeProfileSkills],
            },
          }),
    });
    await executor
      .update(workerProfiles)
      .set({ rawProfile: draft, updatedAt: new Date() })
      .where(eq(workerProfiles.id, profileId));
  }

  /**
   * Apply a worker's corrected machine list (#1311 backend half). Same triple-store
   * rule as {@link setSkillLists}: the profile columns ARE the machines store (no
   * authored relation exists), so the display column and the snapshot move together,
   * verbatim.
   */
  async setMachineLists(profileId: string, machineIds: readonly string[]): Promise<void> {
    const profile = await this.findById(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    const draft = DraftProfileSchema.parse({
      ...(typeof profile.rawProfile === "object" && profile.rawProfile !== null
        ? profile.rawProfile
        : {}),
      machines: [...machineIds],
    });
    await this.db
      .update(workerProfiles)
      .set({
        machines: [...machineIds],
        rawProfile: draft,
        updatedAt: new Date(),
      })
      .where(eq(workerProfiles.id, profileId));
  }

  /**
   * Apply a worker's restated total years (#1311 backend half).
   *
   * SURGICAL KEY PATCH, not a replace: `experience` carries sibling keys (notably the
   * narrative `summary`) that a total-years correction must not clobber — on the
   * column AND on the raw profile, which get the same merge. A non-object legacy
   * value degrades to `{}` rather than throwing the worker's correction away.
   */
  async setExperienceTotal(profileId: string, totalYears: number): Promise<void> {
    const profile = await this.findById(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    const mergeTotal = (value: unknown): Record<string, unknown> => ({
      ...(typeof value === "object" && value !== null ? value : {}),
      total_years: totalYears,
    });
    const draft = DraftProfileSchema.parse({
      ...(typeof profile.rawProfile === "object" && profile.rawProfile !== null
        ? profile.rawProfile
        : {}),
      experience: mergeTotal(
        (profile.rawProfile as Record<string, unknown> | null)?.["experience"] ?? null,
      ),
    });
    await this.db
      .update(workerProfiles)
      .set({
        experience: mergeTotal(profile.experience),
        rawProfile: draft,
        updatedAt: new Date(),
      })
      .where(eq(workerProfiles.id, profileId));
  }
}

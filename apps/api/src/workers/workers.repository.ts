import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  type Database,
  workers,
  workerProfiles,
  workerCredentials,
  workerDevices,
  generatedResumes,
  voiceNotes,
  type Worker,
  type NewWorker,
  type WorkerProfile,
  type GeneratedResume,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Ops-console list row. PII (phone/full name) is intentionally excluded. */
export interface WorkerListItem {
  id: string;
  status: Worker["status"];
  preferred_language: Worker["preferredLanguage"];
  created_at: Date;
  profile_status: WorkerProfile["profileStatus"] | null;
  canonical_role_id: string | null;
  canonical_trade_id: string | null;
}

@Injectable()
export class WorkersRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * List workers (newest first) with their latest profile summary, for the ops
   * console. Two queries (workers, then their profiles) — no PII is returned.
   */
  async list(limit = 100): Promise<WorkerListItem[]> {
    const workerRows = await this.db
      .select()
      .from(workers)
      .orderBy(desc(workers.createdAt))
      .limit(limit);
    if (workerRows.length === 0) return [];

    const ids = workerRows.map((w) => w.id);
    const profileRows = await this.db
      .select()
      .from(workerProfiles)
      .where(inArray(workerProfiles.workerId, ids))
      .orderBy(desc(workerProfiles.createdAt));

    // First row per worker is the latest (rows are ordered created_at desc).
    const latestByWorker = new Map<string, WorkerProfile>();
    for (const p of profileRows) {
      if (!latestByWorker.has(p.workerId)) latestByWorker.set(p.workerId, p);
    }

    return workerRows.map((w) => {
      const p = latestByWorker.get(w.id);
      return {
        id: w.id,
        status: w.status,
        preferred_language: w.preferredLanguage,
        created_at: w.createdAt,
        profile_status: p?.profileStatus ?? null,
        canonical_role_id: p?.canonicalRoleId ?? null,
        canonical_trade_id: p?.canonicalTradeId ?? null,
      };
    });
  }

  async findById(id: string): Promise<Worker | undefined> {
    const rows = await this.db.select().from(workers).where(eq(workers.id, id)).limit(1);
    return rows[0];
  }

  async findByPhoneHash(phoneHash: string): Promise<Worker | undefined> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(eq(workers.phoneHash, phoneHash))
      .limit(1);
    return rows[0];
  }

  async create(input: NewWorker): Promise<Worker> {
    const inserted = await this.db.insert(workers).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create worker");
    return row;
  }

  /**
   * Atomically insert a worker, or return the existing row when a concurrent
   * caller already inserted the same `phone_hash`. Closes TD23: the verify-OTP
   * path was check-then-insert, so two simultaneous first-time logins could both
   * miss the SELECT and the second INSERT would violate `workers_phone_hash_uq`
   * (Postgres 23505 → 500). `on conflict do nothing` makes the losing insert a
   * no-op; we then re-read to hand back the winner's row.
   *
   * `created` is true only when THIS call inserted the row — the caller uses it
   * to gate the one-time `worker.created` event so a race can't double-emit it.
   */
  async createOrGetByPhoneHash(input: NewWorker): Promise<{ worker: Worker; created: boolean }> {
    const inserted = await this.db
      .insert(workers)
      .values(input)
      .onConflictDoNothing({ target: workers.phoneHash })
      .returning();
    if (inserted[0]) return { worker: inserted[0], created: true };

    // Lost the insert race — the concurrent winner's row is now committed.
    const existing = await this.findByPhoneHash(input.phoneHash);
    if (!existing) throw new Error("worker insert hit a conflict but no row was found");
    return { worker: existing, created: false };
  }

  /**
   * Set the worker's full name. The caller passes an ALREADY-ENCRYPTED token
   * (`encryptPii` / `PiiCryptoService.encrypt`) — this repository never stores a
   * plaintext name (see the `full_name` note in schema.ts). Returns the updated
   * row, or undefined if no worker matched.
   */
  async updateFullName(id: string, encryptedFullName: string): Promise<Worker | undefined> {
    const rows = await this.db
      .update(workers)
      .set({ fullName: encryptedFullName, updatedAt: new Date() })
      .where(eq(workers.id, id))
      .returning();
    return rows[0];
  }

  async latestProfile(workerId: string): Promise<WorkerProfile | undefined> {
    const rows = await this.db
      .select()
      .from(workerProfiles)
      .where(eq(workerProfiles.workerId, workerId))
      .orderBy(desc(workerProfiles.createdAt))
      .limit(1);
    return rows[0];
  }

  /**
   * The opaque PDF object keys for a worker's rendered resumes (ADR-0026 Phase 5 — DPDP).
   * Read BEFORE the hard-delete (the cascade erases generated_resumes), so the deletion
   * orchestration can erase the corresponding objects from the resumes bucket. Returns only
   * non-null keys (a row is null until its PDF is rendered). The keys are opaque UUIDs — no
   * PII (the worker's name lives INSIDE the PDF bytes, never in the path).
   */
  async listResumeStorageKeys(workerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: generatedResumes.pdfStorageKey })
      .from(generatedResumes)
      .where(
        eq(generatedResumes.workerId, workerId),
      );
    return rows
      .map((r) => r.key)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
  }

  /**
   * The raw audio object keys (`voice_notes.storage_path`) for a worker (ADR-0026 Phase 5,
   * security Finding 1). Read BEFORE the hard-delete (the cascade erases voice_notes), so the
   * deletion orchestration can erase the corresponding AUDIO blobs — which hold raw PII — from
   * the audio bucket. `storage_path` is NOT NULL in schema; filter defensively anyway. NOTE:
   * these paths are client-supplied placeholders today (no backend audio bucket yet) — the
   * caller no-ops the erase until VOICE_NOTES_BUCKET is configured.
   */
  async listVoiceStorageKeys(workerId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: voiceNotes.storagePath })
      .from(voiceNotes)
      .where(eq(voiceNotes.workerId, workerId));
    return rows
      .map((r) => r.key)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
  }

  /** True if a PIN credential row exists for the worker (the `had_pin` flag, captured
   * pre-delete since the cascade erases worker_credentials). */
  async hasCredentials(workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workerCredentials.id })
      .from(workerCredentials)
      .where(eq(workerCredentials.workerId, workerId))
      .limit(1);
    return rows.length > 0;
  }

  /** Count the worker's device rows (the `devices_revoked` count — every device row is
   * erased by the cascade on hard-delete). Captured pre-delete. */
  async countDevices(workerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workerDevices)
      .where(eq(workerDevices.workerId, workerId));
    return rows[0]?.n ?? 0;
  }

  /**
   * Hard-delete the worker row (ADR-0026 Phase 5 — DPDP right-to-erasure). One DELETE inside
   * a transaction: Postgres atomically cascades to every PII-bearing child (consents, devices,
   * credentials, profiles, chats, voice notes, messages, resumes, answers, applications,
   * downloads, flags) and SET-NULLs the three billing/intent FKs (unlocks/resume_disclosures/
   * invites.inviter_worker_id) per migration 0030. Returns true if a row was deleted, false if
   * the worker was already gone (idempotent — a re-run is a no-op).
   */
  async hardDelete(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(workers)
        .where(eq(workers.id, id))
        .returning({ id: workers.id });
      return deleted.length > 0;
    });
  }

  async latestResume(workerId: string): Promise<GeneratedResume | undefined> {
    const rows = await this.db
      .select()
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId))
      // Order by version (monotonic), not generatedAt (DB-now() granularity): two
      // near-simultaneous generates must not read the same "previous" and collide
      // on the next version / the v{n} object key.
      .orderBy(desc(generatedResumes.version))
      .limit(1);
    return rows[0];
  }
}

import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  workers,
  workerProfiles,
  workerCredentials,
  workerDevices,
  generatedResumes,
  voiceNotes,
  type Database,
} from "@badabhai/db";
import { WorkersRepository } from "./workers.repository";

/**
 * STRUCTURAL tests for the REMAINING (non-deletion-lifecycle) WorkersRepository methods
 * (the `reach.repository.test.ts` / `workers.repository.deletion.test.ts` pattern):
 * capture the Drizzle fluent chain and compile it with the real `PgDialect`, asserting
 * on the TEXT and the BOUND PARAMETERS — no live database.
 *
 * The ADR-0031 deletion-lifecycle queries (scheduleDeletion / cancelDeletion /
 * findDueDeletions / claimDueDeletion / findSelfView) already have their own file
 * (`workers.repository.deletion.test.ts`); this file covers everything else: the ops
 * list, the identity lookups, the PII-write helpers (encrypted-token pass-through only),
 * the DSAR pre-delete key readers, and the hard-delete itself.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);
const text = (cond: unknown) => compile(cond).sql;
const params = (cond: unknown) => compile(cond).params;

const WORKER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WORKER_ID_2 = "bbbbbbbb-0000-4000-8000-000000000002";

interface SelectCall {
  selection?: Record<string, unknown>;
  table?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
}

interface Captured {
  /** Every select(...).from(...)... call, in order — supports methods that select twice. */
  selects: SelectCall[];
  selection?: Record<string, unknown>;
  selectTable?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
  updateTable?: unknown;
  updateSet?: Record<string, unknown>;
  insertTable?: unknown;
  insertValues?: unknown;
  conflict?: unknown;
  deleteTable?: unknown;
  deleteWhere?: unknown;
}

/** Same capturing-mock shape used across the repository test suite (reach/unlocks/posting-plans). */
function makeDb(opts: { rows?: unknown[]; sequence?: unknown[][] } = {}) {
  const captured: Captured = { selects: [] };
  const seq = opts.sequence ? [...opts.sequence] : undefined;
  const nextRows = () => (seq ? (seq.shift() ?? []) : (opts.rows ?? []));

  const selectChain = (selection?: Record<string, unknown>) => {
    const call: SelectCall = { selection };
    captured.selects.push(call);
    const node: Record<string, unknown> = {
      from: (t: unknown) => {
        call.table = t;
        captured.selectTable = t;
        return node;
      },
      where: (c: unknown) => {
        call.where = c;
        captured.where = c;
        return node;
      },
      orderBy: (...o: unknown[]) => {
        call.orderBy = o;
        captured.orderBy = o;
        return node;
      },
      limit: (n: number) => {
        call.limit = n;
        captured.limit = n;
        return node;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(nextRows()).then(res, rej),
    };
    return node;
  };

  const insertChain = (table: unknown) => {
    const build = () => ({
      returning: () => Promise.resolve(nextRows()),
      onConflictDoNothing: (cfg: unknown) => {
        captured.conflict = cfg;
        return build();
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(res, rej),
    });
    return {
      values: (values: unknown) => {
        captured.insertTable = table;
        captured.insertValues = values;
        return build();
      },
    };
  };

  const updateChain = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => {
      captured.updateTable = table;
      captured.updateSet = vals;
      return {
        where: (c: unknown) => {
          captured.where = c;
          return { returning: () => Promise.resolve(nextRows()) };
        },
      };
    },
  });

  const deleteChain = (table: unknown) => ({
    where: (c: unknown) => {
      captured.deleteTable = table;
      captured.deleteWhere = c;
      return { returning: () => Promise.resolve(nextRows()) };
    },
  });

  const handle = {
    select: (selection?: Record<string, unknown>) => {
      captured.selection = selection;
      return selectChain(selection);
    },
    insert: insertChain,
    update: updateChain,
    delete: deleteChain,
  };

  const db = {
    ...handle,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
  } as unknown as Database;

  return { db, captured };
}

function workerRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "active",
    preferredLanguage: "hi",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function profileRow(workerId: string, createdAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    workerId,
    createdAt,
    profileStatus: "confirmed",
    canonicalRoleId: "vmc_operator",
    canonicalTradeId: "cnc_vmc",
    ...overrides,
  };
}

describe("WorkersRepository.list — ops console: workers newest-first + latest-profile summary, PII-free", () => {
  it("reads workers newest-first, then bounds by the same limit", async () => {
    const { db, captured } = makeDb({ sequence: [[workerRow(WORKER_ID)], []] });
    await new WorkersRepository(db).list(50);
    const workersSelect = captured.selects[0]!;
    expect(workersSelect.table).toBe(workers);
    expect(text(workersSelect.orderBy![0])).toBe('"workers"."created_at" desc');
    expect(workersSelect.limit).toBe(50);
  });

  it("short-circuits with [] when there are no workers (never queries profiles)", async () => {
    const { db } = makeDb({ rows: [] });
    const out = await new WorkersRepository(db).list();
    expect(out).toEqual([]);
  });

  it("scopes the profile read to the fetched worker ids", async () => {
    const { db, captured } = makeDb({
      sequence: [[workerRow(WORKER_ID), workerRow(WORKER_ID_2)], [profileRow(WORKER_ID, new Date())]],
    });
    await new WorkersRepository(db).list();
    const profilesSelect = captured.selects[1]!;
    expect(profilesSelect.table).toBe(workerProfiles);
    const q = compile(profilesSelect.where);
    expect(q.sql).toBe('"worker_profiles"."worker_id" in ($1, $2)');
    expect(q.params).toEqual([WORKER_ID, WORKER_ID_2]);
  });

  it("takes the LATEST profile per worker (profile rows arrive newest-first; first-seen wins)", async () => {
    const older = profileRow(WORKER_ID, new Date("2026-06-01T00:00:00.000Z"), {
      profileStatus: "in_progress",
      canonicalRoleId: "old_role",
    });
    const newer = profileRow(WORKER_ID, new Date("2026-07-15T00:00:00.000Z"), {
      profileStatus: "confirmed",
      canonicalRoleId: "vmc_operator",
    });
    // Query result order is created_at desc, so `newer` arrives before `older`.
    const { db } = makeDb({ sequence: [[workerRow(WORKER_ID)], [newer, older]] });
    const out = await new WorkersRepository(db).list();
    expect(out).toEqual([
      {
        id: WORKER_ID,
        status: "active",
        preferred_language: "hi",
        created_at: workerRow(WORKER_ID).createdAt,
        profile_status: "confirmed",
        canonical_role_id: "vmc_operator",
        canonical_trade_id: "cnc_vmc",
      },
    ]);
  });

  it("nulls the profile summary for a worker with no profile row at all — never PII, never a fabricated status", async () => {
    const { db } = makeDb({ sequence: [[workerRow(WORKER_ID_2)], []] });
    const out = await new WorkersRepository(db).list();
    expect(out).toEqual([
      {
        id: WORKER_ID_2,
        status: "active",
        preferred_language: "hi",
        created_at: workerRow(WORKER_ID_2).createdAt,
        profile_status: null,
        canonical_role_id: null,
        canonical_trade_id: null,
      },
    ]);
  });
});

describe("WorkersRepository.findById — SELECT * by id (internal use only, carries PII)", () => {
  it("scopes to id and limits to one", async () => {
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    await new WorkersRepository(db).findById(WORKER_ID);
    expect(captured.selectTable).toBe(workers);
    expect(text(captured.where)).toBe('"workers"."id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    expect(captured.limit).toBe(1);
  });

  it("returns undefined when not found", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).findById(WORKER_ID)).toBeUndefined();
  });
});

describe("WorkersRepository.findByPhoneHash — the OTP-verify identity lookup", () => {
  it("scopes to phone_hash and limits to one", async () => {
    const { db, captured } = makeDb({ rows: [] });
    await new WorkersRepository(db).findByPhoneHash("hash-1");
    expect(captured.selectTable).toBe(workers);
    expect(text(captured.where)).toBe('"workers"."phone_hash" = $1');
    expect(params(captured.where)).toEqual(["hash-1"]);
    expect(captured.limit).toBe(1);
  });
});

describe("WorkersRepository.create — plain insert", () => {
  it("inserts the given row and returns it", async () => {
    const input = { phoneHash: "hash-1", phoneE164: "enc", preferredLanguage: "hi" as const };
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    const out = await new WorkersRepository(db).create(input as never);
    expect(captured.insertTable).toBe(workers);
    expect(captured.insertValues).toBe(input);
    expect(out).toEqual(workerRow(WORKER_ID));
  });

  it("throws when the insert returns no row", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(new WorkersRepository(db).create({} as never)).rejects.toThrow(
      "Failed to create worker",
    );
  });
});

describe("WorkersRepository.createOrGetByPhoneHash — TD23 atomic insert-or-fetch race closure", () => {
  it("reports created:true and the inserted row when the insert wins", async () => {
    const input = { phoneHash: "hash-1" } as never;
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    const out = await new WorkersRepository(db).createOrGetByPhoneHash(input);
    expect(captured.insertTable).toBe(workers);
    expect(captured.conflict).toEqual({ target: workers.phoneHash });
    expect(out).toEqual({ worker: workerRow(WORKER_ID), created: true });
    expect(out.created).toBe(true);
  });

  it("re-reads by phone_hash and reports created:false when the insert loses the race (ON CONFLICT DO NOTHING suppressed it)", async () => {
    const input = { phoneHash: "hash-1" } as never;
    const { db, captured } = makeDb({ sequence: [[], [workerRow(WORKER_ID)]] });
    const out = await new WorkersRepository(db).createOrGetByPhoneHash(input);
    expect(out).toEqual({ worker: workerRow(WORKER_ID), created: false });
    // The re-read is the SAME findByPhoneHash query — scoped to phone_hash.
    expect(text(captured.where)).toBe('"workers"."phone_hash" = $1');
    expect(params(captured.where)).toEqual(["hash-1"]);
  });

  it("throws if the insert lost the race AND the re-read also finds nothing (a true conflict-but-vanished anomaly)", async () => {
    const { db } = makeDb({ sequence: [[], []] });
    await expect(
      new WorkersRepository(db).createOrGetByPhoneHash({ phoneHash: "hash-1" } as never),
    ).rejects.toThrow("worker insert hit a conflict but no row was found");
  });
});

describe("WorkersRepository.updateFullName — stores an ALREADY-ENCRYPTED token, never plaintext", () => {
  it("sets full_name to the given (encrypted) token + updated_at, scoped by id", async () => {
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    await new WorkersRepository(db).updateFullName(WORKER_ID, "cipher:xyz");
    expect(captured.updateTable).toBe(workers);
    expect(captured.updateSet!.fullName).toBe("cipher:xyz");
    expect(captured.updateSet!.updatedAt).toBeInstanceOf(Date);
    expect(text(captured.where)).toBe('"workers"."id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
  });

  it("returns undefined when no worker matched", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).updateFullName(WORKER_ID, "cipher:xyz")).toBeUndefined();
  });
});

describe("WorkersRepository.updateResumePrefs — partial patch of NON-PII display flags", () => {
  it("writes ONLY the provided flags (a partial patch), scoped by id", async () => {
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    await new WorkersRepository(db).updateResumePrefs(WORKER_ID, { resumeShowPhoto: true });
    expect(captured.updateTable).toBe(workers);
    expect(captured.updateSet).toMatchObject({ resumeShowPhoto: true });
    expect(captured.updateSet).not.toHaveProperty("resumeNightShiftReady");
    expect(text(captured.where)).toBe('"workers"."id" = $1');
  });

  it("writes both flags when both are given", async () => {
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    await new WorkersRepository(db).updateResumePrefs(WORKER_ID, {
      resumeShowPhoto: false,
      resumeNightShiftReady: true,
    });
    expect(captured.updateSet).toMatchObject({ resumeShowPhoto: false, resumeNightShiftReady: true });
  });

  it("returns undefined when no worker matched", async () => {
    const { db } = makeDb({ rows: [] });
    expect(
      await new WorkersRepository(db).updateResumePrefs(WORKER_ID, { resumeShowPhoto: true }),
    ).toBeUndefined();
  });
});

describe("WorkersRepository.updatePhotoStorageKey — an OPAQUE object key, never bytes/URL", () => {
  it("sets the key + updated_at, scoped by id", async () => {
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    await new WorkersRepository(db).updatePhotoStorageKey(WORKER_ID, "photos/worker/uuid.jpg");
    expect(captured.updateSet!.photoStorageKey).toBe("photos/worker/uuid.jpg");
    expect(text(captured.where)).toBe('"workers"."id" = $1');
  });

  it("clears the key with null (photo removal)", async () => {
    const { db, captured } = makeDb({ rows: [workerRow(WORKER_ID)] });
    await new WorkersRepository(db).updatePhotoStorageKey(WORKER_ID, null);
    expect(captured.updateSet!.photoStorageKey).toBeNull();
  });

  it("returns undefined when no worker matched", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).updatePhotoStorageKey(WORKER_ID, null)).toBeUndefined();
  });
});

describe("WorkersRepository.latestProfile — the worker's most recent profile row", () => {
  it("scopes by worker_id, newest first, one row", async () => {
    const { db, captured } = makeDb({ rows: [] });
    await new WorkersRepository(db).latestProfile(WORKER_ID);
    expect(captured.selectTable).toBe(workerProfiles);
    expect(text(captured.where)).toBe('"worker_profiles"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    expect(text(captured.orderBy![0])).toBe('"worker_profiles"."created_at" desc');
    expect(captured.limit).toBe(1);
  });

  it("returns undefined when the worker has no profile", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).latestProfile(WORKER_ID)).toBeUndefined();
  });
});

describe("WorkersRepository.listResumeStorageKeys — DSAR pre-delete resume-object keys", () => {
  it("projects ONLY the pdf storage key, scoped by worker", async () => {
    const { db, captured } = makeDb({ rows: [{ key: "resumes/w1/v1.pdf" }, { key: null }] });
    const out = await new WorkersRepository(db).listResumeStorageKeys(WORKER_ID);
    expect(captured.selectTable).toBe(generatedResumes);
    expect(Object.keys(captured.selection!)).toEqual(["key"]);
    expect(text(captured.where)).toBe('"generated_resumes"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    // Null / empty keys are filtered out (a row whose PDF was never rendered).
    expect(out).toEqual(["resumes/w1/v1.pdf"]);
  });

  it("filters out non-string / empty keys defensively", async () => {
    const { db } = makeDb({ rows: [{ key: "" }, { key: undefined }, { key: "ok.pdf" }] });
    expect(await new WorkersRepository(db).listResumeStorageKeys(WORKER_ID)).toEqual(["ok.pdf"]);
  });
});

describe("WorkersRepository.listVoiceStorageKeys — DSAR pre-delete raw-audio object keys", () => {
  it("projects ONLY the storage path, scoped by worker", async () => {
    const { db, captured } = makeDb({ rows: [{ key: "voice/w1/a.wav" }] });
    const out = await new WorkersRepository(db).listVoiceStorageKeys(WORKER_ID);
    expect(captured.selectTable).toBe(voiceNotes);
    expect(Object.keys(captured.selection!)).toEqual(["key"]);
    expect(text(captured.where)).toBe('"voice_notes"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    expect(out).toEqual(["voice/w1/a.wav"]);
  });

  it("returns [] when the worker has no voice notes", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).listVoiceStorageKeys(WORKER_ID)).toEqual([]);
  });
});

describe("WorkersRepository.hasCredentials — the DSAR had_pin flag, captured pre-delete", () => {
  it("scopes by worker, projects only id, limits to one", async () => {
    const { db, captured } = makeDb({ rows: [{ id: "cred-1" }] });
    const out = await new WorkersRepository(db).hasCredentials(WORKER_ID);
    expect(captured.selectTable).toBe(workerCredentials);
    expect(Object.keys(captured.selection!)).toEqual(["id"]);
    expect(text(captured.where)).toBe('"worker_credentials"."worker_id" = $1');
    expect(captured.limit).toBe(1);
    expect(out).toBe(true);
  });

  it("is false when no credential row exists", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).hasCredentials(WORKER_ID)).toBe(false);
  });
});

describe("WorkersRepository.countDevices — the DSAR devices_revoked count, captured pre-delete", () => {
  it("counts device rows scoped to the worker", async () => {
    const { db, captured } = makeDb({ rows: [{ n: 3 }] });
    const out = await new WorkersRepository(db).countDevices(WORKER_ID);
    expect(captured.selectTable).toBe(workerDevices);
    expect(text(captured.where)).toBe('"worker_devices"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    expect(out).toBe(3);
  });

  it("returns 0 when there is no row (never undefined into the DSAR event)", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).countDevices(WORKER_ID)).toBe(0);
  });
});

describe("WorkersRepository.hardDelete — ADR-0026 Phase 5 right-to-erasure, one DELETE in a tx", () => {
  it("deletes the worker row by id inside a transaction and returns true when a row was deleted", async () => {
    const { db, captured } = makeDb({ rows: [{ id: WORKER_ID }] });
    const out = await new WorkersRepository(db).hardDelete(WORKER_ID);
    expect(captured.deleteTable).toBe(workers);
    expect(text(captured.deleteWhere)).toBe('"workers"."id" = $1');
    expect(params(captured.deleteWhere)).toEqual([WORKER_ID]);
    expect(out).toBe(true);
  });

  it("returns false (idempotent no-op) when the worker was already gone", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).hardDelete(WORKER_ID)).toBe(false);
  });
});

describe("WorkersRepository.latestResume — the resume the worker/payer should see", () => {
  it("scopes by worker, orders by VERSION (not generatedAt) descending, one row", async () => {
    const { db, captured } = makeDb({ rows: [] });
    await new WorkersRepository(db).latestResume(WORKER_ID);
    expect(captured.selectTable).toBe(generatedResumes);
    expect(text(captured.where)).toBe('"generated_resumes"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER_ID]);
    expect(text(captured.orderBy![0])).toBe('"generated_resumes"."version" desc');
    expect(captured.limit).toBe(1);
  });

  it("returns undefined when the worker has no generated resume", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new WorkersRepository(db).latestResume(WORKER_ID)).toBeUndefined();
  });
});

describe("WorkersRepository — notification state (#643)", () => {
  describe("findNotificationState", () => {
    it("projects ONLY the three non-PII columns — never the encrypted phone or name", async () => {
      const { db, captured } = makeDb({ rows: [] });
      await new WorkersRepository(db).findNotificationState(WORKER_ID);

      // The whole point of not reusing findById (which is SELECT *): this projection
      // feeds the Alerts feed and the FCM fan-out, so PII must not even be fetched.
      expect(Object.keys(captured.selection ?? {}).sort()).toEqual([
        "notificationsEnabled",
        "notificationsReadAt",
        "preferredLanguage",
      ]);
      expect(captured.selectTable).toBe(workers);
      expect(text(captured.where)).toContain('"id" =');
      expect(params(captured.where)).toEqual([WORKER_ID]);
      expect(captured.limit).toBe(1);
    });
  });

  describe("updateNotificationsEnabled", () => {
    it("writes the flag for exactly that worker and returns the RESULTING value", async () => {
      const { db, captured } = makeDb({ rows: [{ notificationsEnabled: false }] });
      const out = await new WorkersRepository(db).updateNotificationsEnabled(WORKER_ID, false);

      expect(captured.updateTable).toBe(workers);
      expect(captured.updateSet?.notificationsEnabled).toBe(false);
      expect(captured.updateSet?.updatedAt).toBeInstanceOf(Date);
      expect(params(captured.where)).toEqual([WORKER_ID]);
      expect(out).toEqual({ notificationsEnabled: false });
    });

    it("touches no other worker's row", async () => {
      const { db, captured } = makeDb({ rows: [{ notificationsEnabled: true }] });
      await new WorkersRepository(db).updateNotificationsEnabled(WORKER_ID, true);
      expect(params(captured.where)).not.toContain(WORKER_ID_2);
    });
  });

  describe("advanceNotificationsReadAt — the monotonic watermark", () => {
    it("only matches when the stored watermark is NULL or STRICTLY OLDER (never rewinds)", async () => {
      const stamp = new Date("2026-08-07T10:00:00.000Z");
      const { db, captured } = makeDb({ rows: [{ id: WORKER_ID }] });
      const advanced = await new WorkersRepository(db).advanceNotificationsReadAt(
        WORKER_ID,
        stamp,
      );

      const sql = text(captured.where);
      // The guard IS the predicate — without both legs a retried or clock-skewed
      // request could move the watermark BACKWARD and un-read seen alerts.
      expect(sql).toContain('"notifications_read_at" is null');
      expect(sql).toContain('"notifications_read_at" <');
      expect(sql).not.toContain('"notifications_read_at" >');
      // Scoped to the one worker, with the stamp BOUND as a parameter (Drizzle
      // serializes a timestamptz Date to ISO) — never interpolated into the text.
      expect(params(captured.where)).toEqual([WORKER_ID, stamp.toISOString()]);
      expect(captured.updateSet?.notificationsReadAt).toBe(stamp);
      expect(advanced).toBe(true);
    });

    it("reports false (not an error) when no row matched — the watermark was already ahead", async () => {
      const { db } = makeDb({ rows: [] });
      const advanced = await new WorkersRepository(db).advanceNotificationsReadAt(
        WORKER_ID,
        new Date("2026-08-07T10:00:00.000Z"),
      );
      expect(advanced).toBe(false);
    });
  });
});

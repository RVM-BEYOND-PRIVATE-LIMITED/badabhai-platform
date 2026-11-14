import { createHash } from "node:crypto";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import type { CampusDriveRequestStatus, PayerStatus } from "@badabhai/db";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { DriveCursor } from "./campus-drive-cursor";
import type { DriveRequesterFacts } from "./campus-drive-eligibility";
import type {
  CampusDriveRequestsRepository,
  DecisionStore,
  DriveCompanyColumns,
  DriveFeedFilter,
  DriveFeedRow,
  DriveRequestInsert,
  DriveRequestRow,
  LockedForDecision,
} from "./campus-drive-requests.repository";
import type { DecisionTiming } from "./campus-drive-transitions";

/**
 * Test support for #2746 PR 6. Not compiled into the build (`*.test-support.ts` is excluded by
 * tsconfig.build.json). An in-memory `CampusDriveRequestsRepository` that keeps the table's
 * guarantees the services rely on — the unique (payer_id, idempotency_key), tenancy in every
 * company read, status guards in the WHERE of the two writes — so a unit suite exercises the real
 * services' rules without a database. The Postgres suite (`campus-drives.db.test.ts`) proves the
 * real statements keep them too.
 */

/** Real AES and HMAC with deterministic test secrets. */
export function testPii(): PiiCryptoService {
  return new PiiCryptoService({
    PII_HASH_PEPPER: "test-pepper",
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as ServerConfig);
}

/** An in-memory Redis with exactly the two commands `RequestIdempotency` uses. */
export function memoryRedis() {
  const store = new Map<string, string>();
  const redis = {
    set: async (k: string, v: string, _mode: string, _ttl: number, nx?: string) => {
      if (nx === "NX" && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
    get: async (k: string) => store.get(k) ?? null,
  };
  return { store, queue: { client: Promise.resolve(redis) } };
}

/** The real seam over an in-memory Redis; `forget()` is the window passing. */
export function memoryIdempotency(pii: PiiCryptoService = testPii()) {
  const redis = memoryRedis();
  return {
    seam: new RequestIdempotency(pii, redis.queue as never),
    forget: () => redis.store.clear(),
    store: redis.store,
  };
}

/**
 * The real rollout service over `settings` (the suite names the switch: in non-test source only
 * the keys file may) and a fixed pilot list.
 */
export function rolloutWith(
  settings: Record<string, string>,
  pilot: readonly string[] = [],
): FeatureRolloutService {
  const config = loadServerConfig({ NODE_ENV: "test", ...settings });
  const pilots = {
    isListed: async (_feature: string, tenant: TenantKey) => pilot.includes(tenant),
  } as unknown as FeaturePilotRepository;
  return new FeatureRolloutService(config, pilots);
}

const micros = (d: Date) => `${d.toISOString().slice(0, 23)}000Z`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A uuid from a number, for fixture ids. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * The in-memory table. Every write advances a fake clock by one millisecond, so ordering by
 * `created_at` / `updated_at` is total and deterministic.
 */
export class MemoryDriveRequests {
  readonly rows: (DriveRequestRow & { companyNameEnc: string })[] = [];
  /** tenant → the create check's facts; `status` defaults to `active` when not given. */
  readonly facts = new Map<
    string,
    DriveRequesterFacts & { isTestAccount: boolean; status?: PayerStatus | null }
  >();
  /** posting id → owning tenant. */
  readonly postings = new Map<string, string>();
  /** tenant → company name ciphertext (Campus's feed). */
  readonly companyNames = new Map<string, string>();
  /**
   * tenant → the company's standing as Campus's routes read it (joined in the real statements).
   * A company not listed is an active, verified employer with a GSTIN.
   */
  readonly standing = new Map<string, DriveCompanyColumns>();
  readonly audits: { driveRequestId: string; decidedByRef: string; metadata: unknown }[] = [];
  transactions = 0;
  private clock = Date.parse("2026-11-14T06:00:00.000Z");

  private tick(): Date {
    this.clock += 1;
    return new Date(this.clock);
  }

  private standingOf(payerId: string): DriveCompanyColumns {
    return (
      this.standing.get(payerId) ?? {
        companyStatus: "active",
        companyRole: "employer",
        companyVerification: "verified",
        companyHasGst: true,
      }
    );
  }

  /** Test helper: what the account deletion's erasure does to one row (contact gone, re-stamped). */
  eraseContact(id: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) throw new Error("no such row");
    const at = this.tick();
    Object.assign(row, {
      contactNameEnc: null,
      contactPhoneEnc: null,
      contactErasedAt: at,
      updatedAt: at,
      changedKey: micros(at),
    });
  }

  asRepository(): CampusDriveRequestsRepository {
    return this as unknown as CampusDriveRequestsRepository;
  }

  async withTransaction<T>(work: (tx: never) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const snapshot = this.rows.map((r) => ({ ...r }));
    const audits = this.audits.length;
    try {
      return await work({ memoryTx: true } as never);
    } catch (err) {
      // Roll back: nothing a failed transaction wrote survives it.
      this.rows.splice(0, this.rows.length, ...snapshot);
      this.audits.splice(audits);
      throw err;
    }
  }

  async requesterFacts(tenant: TenantKey) {
    const facts = this.facts.get(tenant);
    if (facts === undefined) {
      return {
        role: null,
        status: null,
        isTestAccount: false,
        verificationStatus: null,
        hasGstNumber: false,
      };
    }
    return { ...facts, status: facts.status === undefined ? "active" : facts.status };
  }

  async isOwnPosting(tenant: TenantKey, postingId: string): Promise<boolean> {
    return this.postings.get(postingId) === tenant;
  }

  async insert(_tx: unknown, row: DriveRequestInsert): Promise<DriveRequestRow | undefined> {
    if (
      this.rows.some((r) => r.payerId === row.payerId && r.idempotencyKey === row.idempotencyKey)
    ) {
      return undefined;
    }
    const at = this.tick();
    const created = {
      id: uuid(0x2746d000 + this.rows.length + 1),
      ...row,
      contactErasedAt: null,
      status: "requested" as CampusDriveRequestStatus,
      scheduledOn: null,
      campusDriveRef: null,
      decidedAt: null,
      decidedByRef: null,
      decisionReason: null,
      cancelledAt: null,
      createdAt: at,
      updatedAt: at,
      createdKey: micros(at),
      changedKey: micros(at),
      decidedKey: null,
      cancelledKey: null,
      companyNameEnc: this.companyNames.get(row.payerId) ?? "",
    };
    this.rows.push(created);
    return { ...created };
  }

  async findByIdempotencyKey(tenant: TenantKey, key: string) {
    const row = this.rows.find((r) => r.payerId === tenant && r.idempotencyKey === key);
    return row && { ...row };
  }

  async findOwn(tenant: TenantKey, id: string) {
    const row = this.rows.find((r) => r.id === id && r.payerId === tenant);
    return row && { ...row };
  }

  async listOwn(tenant: TenantKey, after: DriveCursor | undefined, limit: number) {
    return this.rows
      .filter((r) => r.payerId === tenant)
      .sort((a, b) => b.createdKey.localeCompare(a.createdKey) || b.id.localeCompare(a.id))
      .filter(
        (r) =>
          after === undefined ||
          r.createdKey < after.at ||
          (r.createdKey === after.at && r.id < after.id),
      )
      .slice(0, limit + 1)
      .map((r) => ({ ...r }));
  }

  async lockOwn(_tx: unknown, tenant: TenantKey, id: string) {
    return this.findOwn(tenant, id);
  }

  async markCancelled(_tx: unknown, id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined || !["requested", "scheduled"].includes(row.status)) return undefined;
    const at = this.tick();
    Object.assign(row, {
      status: "cancelled",
      cancelledAt: at,
      cancelledKey: micros(at),
      updatedAt: at,
      changedKey: micros(at),
    });
    return { ...row };
  }

  async listFeed(filter: DriveFeedFilter, limit: number): Promise<DriveFeedRow[]> {
    return this.rows
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .filter(
        (r) => filter.changedSince === undefined || r.updatedAt >= new Date(filter.changedSince),
      )
      .sort((a, b) => a.changedKey.localeCompare(b.changedKey) || a.id.localeCompare(b.id))
      .filter(
        (r) =>
          filter.after === undefined ||
          r.changedKey > filter.after.at ||
          (r.changedKey === filter.after.at && r.id > filter.after.id),
      )
      .slice(0, limit + 1)
      .map((r) => ({ ...r, ...this.standingOf(r.payerId) }));
  }

  async lockForDecision(
    _tx: unknown,
    id: string,
    decidedAt: string,
  ): Promise<LockedForDecision | undefined> {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return undefined;
    const body = Date.parse(decidedAt);
    const stored = row.decidedAt?.getTime();
    const timing: DecisionTiming =
      stored === undefined ? "none" : body < stored ? "older" : body === stored ? "same" : "newer";
    return { ...row, ...this.standingOf(row.payerId), timing };
  }

  async writeDecision(_tx: unknown, id: string, write: DecisionStore) {
    const row = this.rows.find((r) => r.id === id && r.status === write.previousStatus);
    if (row === undefined) return undefined;
    const at = this.tick();
    const decidedAt = new Date(write.decidedAt);
    Object.assign(row, {
      status: write.status,
      scheduledOn: write.scheduledOn,
      campusDriveRef: write.campusDriveRef,
      decidedAt,
      decidedKey: micros(decidedAt),
      decidedByRef: write.decidedByRef,
      decisionReason: write.decisionReason,
      updatedAt: at,
      changedKey: micros(at),
    });
    return { ...row };
  }

  async writeDecisionAudit(
    _tx: unknown,
    audit: { driveRequestId: string; decidedByRef: string; metadata: unknown },
  ) {
    this.audits.push(audit);
  }

  /** Test helper: a digest of the table, to prove a refusal wrote nothing. */
  digest(): string {
    return sha(JSON.stringify(this.rows));
  }
}

/** Collects every emitted event (name, payload, and whether it rode a transaction). */
export function capturingEvents() {
  const emitted: {
    event_name: string;
    payload: unknown;
    actor: unknown;
    subject: unknown;
    tx: unknown;
  }[] = [];
  const service = {
    emit: async (params: {
      event_name: string;
      payload: unknown;
      actor: unknown;
      subject: unknown;
      tx?: unknown;
    }) => {
      emitted.push({
        event_name: params.event_name,
        payload: params.payload,
        actor: params.actor,
        subject: params.subject,
        tx: params.tx,
      });
      return { event_id: uuid(0xe0000 + emitted.length) };
    },
  };
  return { emitted, service };
}

import { describe, expect, it } from "vitest";
import { DEV_PII_ENCRYPTION_KEY, DEV_PII_HASH_PEPPER } from "@badabhai/config";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import { ProbeRefusal, drawFreeChatSample, type TurnServedEvent } from "./free-chat-probe";
import { isSampleEligible, readKnownName, samplePiiCrypto } from "./free-chat-probe.cli";

/**
 * ADR-0051 §10 (#2128) — the probe CLI's privacy paths: how a worker's name is read for the mask,
 * and when part B is refused outright. Fabricated values only; no database, no real key.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A fabricated, non-default 32-byte key and pepper — production-shaped, never a real one. */
const FAKE_KEY = Buffer.alloc(32, 9).toString("base64");
const FAKE_PEPPER = "fabricated-probe-test-pepper-not-a-default";

const workersWith = (token: string | null) => ({
  findFullNameToken: async () => token,
});
const decryptingTo = (value: string) => ({ decrypt: () => value });
const throwingDecrypt = {
  decrypt: (): string => {
    throw new Error("unsupported state or unable to authenticate data");
  },
};

describe("readKnownName — any doubt about the name is null", () => {
  it("returns the decrypted name", async () => {
    expect(await readKnownName(workersWith("v1.token"), decryptingTo("Suresh Kumar"), id(1))).toBe(
      "Suresh Kumar",
    );
  });

  it("is null when no name is on file, the decrypt throws, or the name is blank", async () => {
    expect(await readKnownName(workersWith(null), decryptingTo("x"), id(1))).toBeNull();
    expect(await readKnownName(workersWith(""), decryptingTo("x"), id(1))).toBeNull();
    expect(await readKnownName(workersWith("v1.token"), throwingDecrypt, id(1))).toBeNull();
    expect(await readKnownName(workersWith("v1.token"), decryptingTo("   "), id(1))).toBeNull();
  });

  it("drops the line whenever the name read is null — decrypt failure and blank name alike", async () => {
    const turn: TurnServedEvent = {
      id: id(1001),
      occurredAt: new Date("2026-10-07T10:00:00.000Z"),
      payload: {
        worker_id: id(501),
        session_id: id(701),
        mode: "free",
        category: "unclear",
        decided_by: "classifier",
        confidence_bucket: "lt50",
        outcome: "clarify",
        refusal_topic: null,
        strike_count: null,
        cooldown_started: false,
        nudge: false,
        submission_id: null,
      },
    };
    for (const pii of [throwingDecrypt, decryptingTo("  ")]) {
      const sample = await drawFreeChatSample([turn], 5, {
        eligible: async () => true,
        linkedLines: async () => [
          { kind: "linked", messageId: id(3001), workerText: "kaam chahiye", botText: null },
        ],
        linkCounts: async () => ({ none: 0, ambiguous: 0 }),
        knownName: (workerId) => readKnownName(workersWith("v1.token"), pii, workerId),
      });
      expect(sample.entries).toEqual([]);
      expect(sample.workerDrops.name_unreadable).toBe(1);
    }
  });
});

describe("isSampleEligible — owner ruling R36 (DPDP)", () => {
  const active = { purposes: ["profiling", "resume_generation"] as const, revokedAt: null };
  const workersIn = (deletionScheduledAt: Date | null | "gone") => ({
    findSelfView: async () =>
      deletionScheduledAt === "gone"
        ? undefined
        : { status: "active" as const, deletionScheduledAt },
  });
  const latestIs = (row: { purposes: readonly string[]; revokedAt: Date | null } | undefined) => ({
    findLatestByWorker: async () =>
      row === undefined
        ? undefined
        : { purposes: [...row.purposes] as never, revokedAt: row.revokedAt },
  });

  it("is eligible with an active profiling consent and no deletion scheduled", async () => {
    expect(await isSampleEligible(workersIn(null), latestIs(active), id(1))).toBe(true);
  });

  it("is NOT eligible when the latest consent is revoked", async () => {
    expect(
      await isSampleEligible(
        workersIn(null),
        latestIs({ ...active, revokedAt: new Date() }),
        id(1),
      ),
    ).toBe(false);
  });

  it("is NOT eligible when the latest consent does not name profiling", async () => {
    expect(
      await isSampleEligible(
        workersIn(null),
        latestIs({ purposes: ["resume_generation", "communication"], revokedAt: null }),
        id(1),
      ),
    ).toBe(false);
  });

  it("is NOT eligible when a deletion is scheduled, the worker row is gone, or there is no consent", async () => {
    expect(await isSampleEligible(workersIn(new Date()), latestIs(active), id(1))).toBe(false);
    expect(await isSampleEligible(workersIn("gone"), latestIs(active), id(1))).toBe(false);
    expect(await isSampleEligible(workersIn(null), latestIs(undefined), id(1))).toBe(false);
  });

  it("fails closed when the consent read throws", async () => {
    const throwing = {
      findLatestByWorker: async (): Promise<undefined> => {
        throw new Error("read failed");
      },
    };
    expect(await isSampleEligible(workersIn(null), throwing, id(1))).toBe(false);
  });
});

describe("samplePiiCrypto — part B runs on the box only", () => {
  const production = {
    NODE_ENV: "production",
    PII_ENCRYPTION_KEY: FAKE_KEY,
    PII_HASH_PEPPER: FAKE_PEPPER,
  };

  it("refuses --sample anywhere but NODE_ENV=production", () => {
    for (const NODE_ENV of [undefined, "development", "test", "staging"]) {
      expect(() => samplePiiCrypto({ ...production, NODE_ENV })).toThrow(ProbeRefusal);
      expect(() => samplePiiCrypto({ ...production, NODE_ENV })).toThrow(/box only/);
    }
  });

  it("refuses the development-default PII keys, instead of only warning", () => {
    for (const env of [
      { ...production, PII_ENCRYPTION_KEY: DEV_PII_ENCRYPTION_KEY },
      { ...production, PII_HASH_PEPPER: DEV_PII_HASH_PEPPER },
      { NODE_ENV: "production" }, // nothing set: the dev defaults apply
    ]) {
      expect(() => samplePiiCrypto(env)).toThrow(ProbeRefusal);
      expect(() => samplePiiCrypto(env)).toThrow(/PII key configuration/);
    }
  });

  it("builds the api's own PII crypto on a production-shaped config", () => {
    const crypto = samplePiiCrypto(production);
    expect(crypto).toBeInstanceOf(PiiCryptoService);
    expect(crypto.decrypt(crypto.encrypt("fabricated name"))).toBe("fabricated name");
  });
});

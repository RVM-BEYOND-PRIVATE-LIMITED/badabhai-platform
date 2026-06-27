import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  buildReachSeedPlan,
  buildWorker,
  buildPayer,
  syntheticPhone,
  type ReachSeedCounts,
  type SeededWorker,
} from "./seed-reach-pool";
import { makeRng } from "./reach-pool-data";

const COUNTS: ReachSeedCounts = { workers: 80, payers: 12, postings: 16, jobs: 16, rngSeed: 1337 };

describe("buildReachSeedPlan — determinism (same SEED_* → identical pool)", () => {
  it("produces a byte-identical plan for the same counts + seed", () => {
    const a = buildReachSeedPlan(COUNTS);
    const b = buildReachSeedPlan(COUNTS);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("produces a DIFFERENT pool for a different rng seed", () => {
    const a = buildReachSeedPlan(COUNTS);
    const b = buildReachSeedPlan({ ...COUNTS, rngSeed: 9999 });
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("honors the entity counts exactly", () => {
    const p = buildReachSeedPlan(COUNTS);
    expect(p.workers).toHaveLength(COUNTS.workers);
    expect(p.payers).toHaveLength(COUNTS.payers);
    expect(p.postings).toHaveLength(COUNTS.postings);
    expect(p.jobs).toHaveLength(COUNTS.jobs);
  });

  it("a single record builder is reproducible for the same (index, seed)", () => {
    const w1 = buildWorker(7, makeRng(1337));
    const w2 = buildWorker(7, makeRng(1337));
    expect(w1).toEqual(w2);
    const pa1 = buildPayer(3, makeRng(55));
    const pa2 = buildPayer(3, makeRng(55));
    expect(pa1).toEqual(pa2);
  });
});

describe("namespacing + idempotency keys", () => {
  it("every entity carries a stable reach-seed-namespaced id", () => {
    const p = buildReachSeedPlan(COUNTS);
    for (const w of p.workers) {
      expect(w.workerId.startsWith("5eed")).toBe(true);
      expect(w.profileId.startsWith("5eed")).toBe(true);
      expect(w.consentId.startsWith("5eed")).toBe(true);
    }
    for (const pa of p.payers) expect(pa.payerId.startsWith("5eed")).toBe(true);
    for (const po of p.postings) expect(po.postingId.startsWith("5eed")).toBe(true);
    for (const j of p.jobs) expect(j.jobId.startsWith("5eed")).toBe(true);
  });

  it("ids are unique across the whole plan (no key collisions on conflict targets)", () => {
    const p = buildReachSeedPlan(COUNTS);
    const ids = [
      ...p.workers.flatMap((w) => [w.workerId, w.profileId, w.consentId]),
      ...p.payers.map((pa) => pa.payerId),
      ...p.postings.map((po) => po.postingId),
      ...p.jobs.map((j) => j.jobId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a smaller reseed's ids are a SUBSET of a larger seed's (clean teardown by range)", () => {
    const small = buildReachSeedPlan({ ...COUNTS, workers: 10 });
    const large = buildReachSeedPlan({ ...COUNTS, workers: 80 });
    const largeIds = new Set(large.workers.map((w) => w.workerId));
    for (const w of small.workers) expect(largeIds.has(w.workerId)).toBe(true);
  });
});

describe("signal-distribution coverage (the pool exercises the scorer)", () => {
  const plan = buildReachSeedPlan({ ...COUNTS, workers: 500 });

  it("role: null + a spread of canonical roles incl. the rare thin-supply trades", () => {
    const roleNullCount = plan.workers.filter((w) => w.canonicalRoleId == null).length;
    expect(roleNullCount).toBeGreaterThan(0); // some "trade not stated yet"
    const roles = new Set(plan.workers.map((w) => w.canonicalRoleId));
    expect(roles.has("role_vmc_operator")).toBe(true);
    expect(roles.has("role_cnc_grinding_operator")).toBe(true); // the thin-supply trade exists
    // Non-uniform: VMC (common) clearly outnumbers grinding (rare).
    const vmc = plan.workers.filter((w) => w.canonicalRoleId === "role_vmc_operator").length;
    const grind = plan.workers.filter(
      (w) => w.canonicalRoleId === "role_cnc_grinding_operator",
    ).length;
    expect(vmc).toBeGreaterThan(grind);
  });

  it("has a ~10-15% deliberately sparse cohort (missing exp/salary/location)", () => {
    const sparse = plan.workers.filter((w) => w.sparse);
    const pct = (sparse.length / plan.workers.length) * 100;
    expect(pct).toBeGreaterThan(6);
    expect(pct).toBeLessThan(20);
    for (const w of sparse) {
      expect(w.experience).toEqual({}); // missing experience
      expect(w.salaryExpectation).toEqual({}); // missing salary
      expect(w.locationPreference).toEqual({}); // missing location
    }
  });

  it("availability covers every value incl. unknown", () => {
    const seen = new Set(plan.workers.map((w) => w.availability));
    for (const v of ["immediate", "notice_period", "not_looking", "unknown"]) {
      expect(seen.has(v as SeededWorker["availability"]), `missing availability ${v}`).toBe(true);
    }
  });

  it("activity recency spans fresh → stale (drives the activity signal)", () => {
    const tiers = new Set(plan.workers.map((w) => w.activityTier));
    for (const t of ["fresh", "this_week", "this_month", "stale"]) {
      expect(tiers.has(t as SeededWorker["activityTier"]), `missing activity ${t}`).toBe(true);
    }
  });

  it("payers are a mix of employer + agent", () => {
    const roles = new Set(plan.payers.map((p) => p.role));
    expect(roles.has("employer")).toBe(true);
    expect(roles.has("agent")).toBe(true);
  });
});

describe("NO-PII discipline (the generated signal payloads never carry a name/phone)", () => {
  const plan = buildReachSeedPlan({ ...COUNTS, workers: 300 });

  it("synthetic phones are E.164-shaped, in a reserved block, and unique", () => {
    expect(syntheticPhone(0)).toMatch(/^\+915550\d{5}$/);
    const phones = plan.workers.map((w) => w.phoneE164);
    expect(new Set(phones).size).toBe(phones.length);
    for (const p of phones) expect(p).toMatch(/^\+915550\d{5}$/);
  });

  it("the rankable JSONB payloads (the only thing that flows to the scorer/events) carry NO name or phone", () => {
    for (const w of plan.workers) {
      // These four objects are exactly what worker_profiles stores + the scorer reads;
      // none must ever contain the worker's name or phone.
      const signalBlob = JSON.stringify([
        w.experience,
        w.salaryExpectation,
        w.locationPreference,
        w.availabilityJson,
      ]);
      expect(signalBlob).not.toContain(w.fullName);
      expect(signalBlob).not.toContain(w.phoneE164);
      expect(signalBlob.toLowerCase()).not.toContain("test worker");
      expect(signalBlob).not.toMatch(/\+?\d{10,}/); // no long digit runs (phone-like)
    }
  });

  it("PII (name/phone) lives ONLY on the worker record fields destined for `workers`", () => {
    // The faceless profile/job/payer-signal fields must not echo the worker's PII.
    for (const w of plan.workers) {
      expect(w.canonicalRoleId ?? "").not.toContain(w.fullName);
      expect(JSON.stringify(w.locationPreference)).not.toContain(w.fullName);
    }
  });
});

describe("PROD-GUARD — the seed writer refuses to run in production before connecting", () => {
  it("exits non-zero with NODE_ENV=production (no DB connection attempted)", () => {
    // vitest runs with CWD = packages/db. Spawn the script with the SAME node binary
    // through the tsx CLI (portable across OSes — avoids the platform .bin shim).
    const cwd = process.cwd();
    const script = resolve(cwd, "src/seed-reach-pool.ts");
    const tsxCli = createRequire(resolve(cwd, "package.json")).resolve("tsx/cli");
    let threw = false;
    let output = "";
    try {
      execFileSync(process.execPath, [tsxCli, script], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          // Deliberately NO DATABASE_URL/keys — the guard must fire FIRST regardless.
          DATABASE_URL: "",
          PII_ENCRYPTION_KEY: "",
          PII_HASH_PEPPER: "",
        },
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (err) {
      threw = true;
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      output = `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`;
    }
    expect(threw).toBe(true);
    expect(output).toContain("refusing to seed synthetic fixtures in production");
  });
});

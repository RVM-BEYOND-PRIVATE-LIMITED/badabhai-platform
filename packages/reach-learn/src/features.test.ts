import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { JobSpec, WorkerSignals } from "@badabhai/reach-engine";
import {
  assertEventPiiFree,
  assertFeatureVectorClean,
  buildFeatureVector,
  FEATURE_ALLOWLIST,
} from "./features";
import { SIGNALS } from "./types";

const job: JobSpec = { jobId: "job-1", roleIds: ["role_a"], city: "pune" };
const worker: WorkerSignals = {
  workerId: "wkr-1",
  roleId: "role_a",
  city: "pune",
  experienceYears: 3,
};

/** mulberry32 — a tiny seeded PRNG, so the fuzz below is the same on every run. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when the ingest guard refuses `value` as a PII-shaped VALUE (the key is innocent). */
function refusesValue(value: string): boolean {
  try {
    assertEventPiiFree({ note: value });
    return false;
  } catch (err) {
    if (!/PII-shaped value/.test((err as Error).message)) throw err;
    return true;
  }
}

describe("PII boundary — fail closed (ADR-0017 Decision 2 / security gate)", () => {
  it("throws on a PII-shaped KEY in an event payload", () => {
    expect(() => assertEventPiiFree({ worker_id: "w", phone: "x" })).toThrow(/PII-shaped key/);
    expect(() => assertEventPiiFree({ full_name: "Asha" })).toThrow(/PII-shaped key/);
    expect(() => assertEventPiiFree({ employer: "Acme" })).toThrow(/PII-shaped key/);
    expect(() => assertEventPiiFree({ geo: { lat: 1, lng: 2 } })).toThrow(/PII-shaped key/);
  });

  it("throws on a PII-shaped VALUE (phone / email) even under an innocent key", () => {
    expect(() => assertEventPiiFree({ note: "+91 98765 43210" })).toThrow(/PII-shaped value/);
    expect(() => assertEventPiiFree({ ref: "asha@example.com" })).toThrow(/PII-shaped value/);
  });

  it("accepts a clean PII-free feed/application payload (ids + enums + signals)", () => {
    expect(() =>
      assertEventPiiFree({ worker_id: "w-1", job_id: "j-1", rank: 2, score: 0.8, hot: true }),
    ).not.toThrow();
    expect(() =>
      assertEventPiiFree({ worker_id: "w-1", job_id: "j-1", reason: "too_far" }),
    ).not.toThrow();
  });
});

// #1936 (the #1924 follow-up) — the value guard's email shape is linear, and no verdict moved.
describe("PII boundary — the value guard's email shape (#1936)", () => {
  // THE PRE-#1936 value check, frozen as the oracle. Its email pattern is the quadratic one,
  // so it only ever sees short strings here.
  const PRE_1936_EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const pre1936ValueLooksPii = (s: string): boolean =>
    /(?:\+?\d[\s-]?){7,}/.test(s) || PRE_1936_EMAIL_RE.test(s);

  it.each([
    "asha@example.com",
    "first.last+tag@mail.example.co.in",
    "ref: x@y.z",
    "x@y.z",
    "@@a@b.co",
    "a@b@c.in",
    "रमेश@उदा.भारत", // Devanagari, both sides
    "\u{1d4b6}@b.co", // an astral letter: two UTF-16 units before the @
    `${"l".repeat(300)}@acme.in`,
  ])("refuses the email shape %j", (s) => {
    expect(refusesValue(s)).toBe(true);
    expect(pre1936ValueLooksPii(s)).toBe(true);
  });

  it.each([
    "",
    "@",
    "a@",
    "@b.com",
    "a@b",
    "a @b.com",
    "a @b.com",
    "a@ b.com",
    "a@b　.com",
    "a@.com",
    "a@b.",
    "a@@b.com",
    "rate @ 500.00",
    "user@localhost",
    "too_far",
  ])("passes the near-miss %j", (s) => {
    expect(refusesValue(s)).toBe(false);
    expect(pre1936ValueLooksPii(s)).toBe(false);
  });

  // ~0.5 s locally, but CI runners are contended: #1941 saw a 227 ms walk take 5.48 s and trip
  // vitest's 5 s default. The two oracle walks below carry an explicit, generous ceiling.
  const EXHAUSTIVE_TIMEOUT_MS = 60_000;

  it(
    "agrees with the pre-#1936 oracle on every string up to 7 characters over a small alphabet",
    () => {
      // "@", ".", ASCII and Unicode whitespace, an ASCII and a Devanagari letter: every email,
      // near-miss, leading/trailing "@" and multiple-"@" shape that fits in 7 characters.
      const alphabet = ["a", "क", "@", ".", " ", " "];
      let flagged = 0;
      let level = [""];
      for (let len = 0; len <= 7; len++) {
        for (const s of level) {
          const verdict = refusesValue(s);
          if (verdict !== pre1936ValueLooksPii(s)) expect.fail(JSON.stringify(s));
          if (verdict) flagged++;
        }
        level = level.flatMap((p) => alphabet.map((c) => p + c));
      }
      expect(flagged).toBeGreaterThan(3_000); // not vacuous: 4,077 of 335,923
    },
    EXHAUSTIVE_TIMEOUT_MS,
  );

  it(
    "agrees with the pre-#1936 oracle on 20,000 seeded emails and near-misses",
    () => {
      const rng = mulberry32(0x1936);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
      const chars = [..."abcxyzABC019._+-%!#'~éक"];
      const run = (min: number, max: number): string => {
        let out = "";
        for (let n = min + Math.floor(rng() * (max - min + 1)); n > 0; n--) out += pick(chars);
        return out;
      };
      let flagged = 0;
      for (let i = 0; i < 20_000; i++) {
        const s =
          pick(["", "ref ", "contact:", "too_far\n", " ", "(", "@", "."]) +
          (rng() < 0.05 ? run(64, 300) : run(0, 10)) +
          (rng() < 0.8 ? "@" : pick(["@@", " @", "@ ", "＠", "(at)"])) +
          (rng() < 0.05 ? run(64, 300) : run(0, 10)) +
          (rng() < 0.75 ? "." : pick(["..", ". ", " .", "。", ""])) +
          pick(["com", "in", "co.in", "x", ""]) +
          pick(["", ".", "@", "@x", ")", " now", "\tPF + ESI", " "]);
        const verdict = refusesValue(s);
        if (verdict !== pre1936ValueLooksPii(s)) expect.fail(JSON.stringify(s));
        if (verdict) flagged++;
      }
      // Not vacuous: both verdicts are well represented.
      expect(flagged).toBeGreaterThan(4_000);
      expect(flagged).toBeLessThan(16_000);
    },
    EXHAUSTIVE_TIMEOUT_MS,
  );

  it("matches ONE character before the @, never a run that re-scans from every start", () => {
    // The #1924 pin. Classes collapse to one token first, so the "@" found is the literal one,
    // not the "@" inside `[^\s@]`.
    const src = readFileSync(join(__dirname, "features.ts"), "utf8");
    const pattern = /^const EMAIL_RE = \/(.+)\/;\r?$/m.exec(src)?.[1];
    expect(pattern).toBeDefined();
    const tokens = pattern!.replace(/\[(?:\\.|[^\]\\])*\]/g, "C");
    expect(tokens.slice(0, tokens.indexOf("@"))).toBe("C");
  });

  // Before the fix the guard cost ~4.8 s on a 100,000-character value with no whitespace or
  // "@". About a millisecond now. The oracle and the pin above are the guard; this generous
  // bound is the backstop, still ~10x under the old cost.
  it.each([
    ["a run with no whitespace or @", "a".repeat(100_000), false],
    ["a long run, then an @", `${"a".repeat(100_000)}@`, false],
    ["an @ with no dot after it", `${"a".repeat(50_000)}@${"b".repeat(49_999)}`, false],
    ["repeated @s", "a@".repeat(50_000), false],
    ["an @ before a run of dots", `x@${".".repeat(99_998)}`, true],
  ])("judges a 100,000-character value (%s) fast", (_shape, value, refused) => {
    const started = performance.now();
    expect(refusesValue(value)).toBe(refused);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("feature vector — fixed allowlist, no ids, no PII", () => {
  it("contains EXACTLY the six signal raws", () => {
    const vec = buildFeatureVector(job, worker);
    expect(Object.keys(vec).sort()).toEqual([...SIGNALS].sort());
    expect(FEATURE_ALLOWLIST).toEqual(SIGNALS);
    for (const s of SIGNALS) expect(typeof vec[s]).toBe("number");
  });

  it("rejects any non-allowlisted key (e.g. an id leaking in)", () => {
    expect(() =>
      assertFeatureVectorClean({ ...buildFeatureVector(job, worker), worker_id: "w-1" } as never),
    ).toThrow(/not in the allowlist/);
  });

  it("rejects a non-finite feature value", () => {
    expect(() =>
      assertFeatureVectorClean({ ...buildFeatureVector(job, worker), role: NaN }),
    ).toThrow(/finite number/);
  });
});

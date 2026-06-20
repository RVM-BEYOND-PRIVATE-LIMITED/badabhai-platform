/**
 * LEARN feature pipeline — PII boundary (ADR-0017 Decision 2; security gate).
 *
 * Two hard guarantees, both FAIL-CLOSED:
 *  1. Events are read PII-free. `assertEventPiiFree` throws if any payload key or
 *     value looks like raw PII (phone/name/email/address/employer/precise geo).
 *  2. The model's {@link FeatureVector} is a FIXED ALLOWLIST of the six derived 0..1
 *     signal raws — nothing else. `worker_id`/`job_id` are join/group keys and are
 *     NEVER placed in the vector. `buildFeatureVector` is the only constructor and it
 *     refuses any non-allowlisted key.
 */
import { scoreWorkerForJob, type JobSpec, type WorkerSignals } from "@badabhai/reach-engine";
import { SIGNALS, type FeatureVector } from "./types";

/** The ONLY keys allowed in a feature vector. Anything else → throw. */
export const FEATURE_ALLOWLIST: readonly string[] = SIGNALS;

/**
 * Substrings that must never appear as a key in an ingested event payload. Raw PII
 * lives ONLY in `workers` (invariant #2); if any of these reaches the LEARN ingest
 * something upstream leaked — fail closed rather than learn on it.
 */
const PII_KEY_DENYLIST = [
  "phone",
  "name", // full_name, first_name, ...
  "email",
  "address",
  "employer",
  "company",
  "aadhaar",
  "dob",
  "birth",
  "lat", // worker-precise geo (city-centroid is never in event payloads)
  "lng",
  "lon",
  "pincode",
  "pin_code",
  "otp",
  "token",
] as const;

const PHONE_RE = /(?:\+?\d[\s-]?){7,}/; // 7+ digits run → looks like a phone
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function keyLooksPii(key: string): boolean {
  const k = key.toLowerCase();
  // `*_id` / `*_hash` are opaque references, explicitly allowed even if they contain
  // a denied substring by coincidence (none do today, but keep the rule honest).
  if (k.endsWith("_id") || k.endsWith("_hash") || k === "id") return false;
  return PII_KEY_DENYLIST.some((bad) => k.includes(bad));
}

function valueLooksPii(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return PHONE_RE.test(value) || EMAIL_RE.test(value);
}

/**
 * FAIL-CLOSED: throw if a payload (recursively) carries a PII-shaped key or value.
 * Run on every event before it is used. Returns the input for chaining.
 */
export function assertEventPiiFree(
  payload: Record<string, unknown>,
  path = "payload",
): Record<string, unknown> {
  for (const [key, value] of Object.entries(payload)) {
    if (keyLooksPii(key)) {
      throw new Error(`PII-shaped key '${path}.${key}' in LEARN ingest — refusing (fail-closed).`);
    }
    if (valueLooksPii(value)) {
      throw new Error(`PII-shaped value at '${path}.${key}' in LEARN ingest — refusing (fail-closed).`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertEventPiiFree(value as Record<string, unknown>, `${path}.${key}`);
    }
  }
  return payload;
}

/**
 * Build the feature vector for one (job, worker) pair by recomputing the deterministic
 * RANK components and extracting ONLY the six signal raws. Reuses the engine's exact
 * scoring (no re-implementation, no drift). Asserts the result is allowlist-only.
 */
export function buildFeatureVector(job: JobSpec, worker: WorkerSignals): FeatureVector {
  const scored = scoreWorkerForJob(job, worker);
  const raws = new Map(scored.components.map((c) => [c.signal, c.raw]));
  const vec = {} as FeatureVector;
  for (const signal of SIGNALS) {
    vec[signal] = raws.get(signal) ?? 0;
  }
  return assertFeatureVectorClean(vec);
}

/**
 * FAIL-CLOSED: a feature vector may contain EXACTLY the allowlisted signal keys, each
 * a finite number. No ids, no extra fields. Throws otherwise. The single chokepoint
 * that makes "no raw PII / no ids in features" a testable invariant, not a promise.
 */
export function assertFeatureVectorClean(vec: Record<string, unknown>): FeatureVector {
  const keys = Object.keys(vec);
  for (const key of keys) {
    if (!FEATURE_ALLOWLIST.includes(key)) {
      throw new Error(`Feature '${key}' is not in the allowlist (${FEATURE_ALLOWLIST.join(", ")}).`);
    }
    const v = vec[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`Feature '${key}' must be a finite number, got ${String(v)}.`);
    }
  }
  for (const signal of FEATURE_ALLOWLIST) {
    if (!keys.includes(signal)) throw new Error(`Feature '${signal}' missing from vector.`);
  }
  return vec as FeatureVector;
}

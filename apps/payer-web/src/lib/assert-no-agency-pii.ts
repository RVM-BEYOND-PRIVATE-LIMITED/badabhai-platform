/**
 * FACELESS defensive boundary for the agency portal (CLAUDE.md §2 #2 + #6 / B-R2).
 *
 * The agency (an `agent` payer) sees ONLY opaque worker IDs, counts, status enums,
 * and timestamps — NEVER a worker's name, phone, email, address, or raw resume.
 * Pages are written to render none of that, but a backend payload could one day
 * regress and carry a forbidden key. This helper is the LAST-LINE guard at the
 * render boundary: it scans a payload for forbidden keys and
 *  - in development/test: THROWS (loudly fail the build/test so a regression is
 *    caught before it ships), and
 *  - in production: strips/omits the offending keys and emits a SAFE warning
 *    (the key NAME only, never the value), so the agency never renders PII even if
 *    a payload accidentally contains it.
 *
 * This is defence-in-depth, NOT a license to fetch PII: the seam (`payer-api.ts`)
 * must still never request raw PII. NOTHING here is logged with a value.
 */

/**
 * Forbidden key tokens (lower-cased, substring match). These cover worker PII that
 * must never reach the agency surface. `payerId` / `payer_id` (the agency's OWN
 * tenant token) and the agency's own org label are NOT worker PII and are allowed
 * — they are deliberately excluded below.
 */
const FORBIDDEN_KEY_TOKENS = [
  "name", // name, full_name, first_name, last_name, worker_name, display_name
  "phone", // phone, phone_e164, mobile, contact_number
  "mobile",
  "email", // a worker's email
  "address", // address, street, pincode-bearing address blobs
  "aadhaar",
  "aadhar",
  "pan", // PAN (also caught defensively though KYC is parked)
  "dob",
  "date_of_birth",
  "birthdate",
  "resume_text", // raw resume bytes/text (the masked artifact is a URL, allowed)
  "resume_bytes",
  "raw_resume",
  "bank", // bank account (payouts parked, but guard anyway)
  "ifsc",
  "upi",
] as const;

/**
 * Keys that LOOK like they might match a token but are explicitly SAFE on the
 * agency surface (the agency's OWN identifiers / display label, opaque handles).
 */
const ALLOWED_KEY_EXACT = new Set<string>([
  "payerid",
  "payer_id",
  "displaylabel",
  "display_label",
  "orgname",
  "org_name",
  "rolename", // a job role title is demand-side metadata, not worker PII
  "role_name",
  "roletitle",
  "role_title",
  "relay_handle", // opaque, non-reversible routed handle (not a phone)
  "relayhandle",
  "displayinitials", // masked initials ("R***** K.") — already masked, not raw PII
  "display_initials",
]);

function keyLooksLikePii(key: string): boolean {
  const k = key.toLowerCase();
  if (ALLOWED_KEY_EXACT.has(k)) return false;
  return FORBIDDEN_KEY_TOKENS.some((token) => k.includes(token));
}

function isDevOrTest(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}

/** Collected violation: the dotted PATH only (never the value). */
export interface AgencyPiiViolation {
  path: string;
  key: string;
}

/** Walk an arbitrary value, collecting forbidden-key paths and (in prod) stripping them. */
function scrub(value: unknown, path: string, violations: AgencyPiiViolation[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => scrub(item, `${path}[${i}]`, violations));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (keyLooksLikePii(key)) {
        violations.push({ path: childPath, key });
        // In prod we OMIT the offending key entirely (strip). In dev/test we still
        // record it so the throw below fails loudly; we don't keep its value either.
        continue;
      }
      out[key] = scrub(child, childPath, violations);
    }
    return out;
  }
  // Primitive (string/number/bool/null/undefined) — pass through unchanged.
  return value;
}

/**
 * Assert a payload destined for the agency surface carries NO forbidden worker PII.
 *
 * @returns the SAME data in prod with any forbidden keys stripped (so a regressed
 *          payload still renders faceless); the same data in dev/test (it throws
 *          first on any violation, so callers always get clean data on the happy
 *          path).
 * @throws in development/test if any forbidden key is present (key NAME only in the
 *          message — never a value), so a regression fails CI loudly.
 */
export function assertNoAgencyPII<T>(data: T, label = "agency-payload"): T {
  const violations: AgencyPiiViolation[] = [];
  const scrubbed = scrub(data, "", violations) as T;

  if (violations.length === 0) return data;

  const paths = violations.map((v) => v.path).join(", ");
  if (isDevOrTest()) {
    // Fail loudly — a forbidden key in an agency payload is a faceless-boundary bug.
    throw new Error(
      `assertNoAgencyPII(${label}): forbidden PII key(s) present at: ${paths}. ` +
        `The agency surface must be faceless (opaque ids/counts/status/timestamps only).`,
    );
  }

  // Production: never crash the console; strip + warn with the PATH only (no value).
  console.warn(`[assertNoAgencyPII] stripped forbidden PII key(s) from ${label}: ${paths}`);
  return scrubbed;
}

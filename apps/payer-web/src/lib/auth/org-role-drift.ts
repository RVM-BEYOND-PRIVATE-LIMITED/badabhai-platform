import "server-only";

/**
 * CONTRACT-DRIFT SIGNAL for `GET /payer/me` `orgRole` (#2079).
 *
 * The wire schema (`payerMeWireSchema`, contracts.ts) degrades an `orgRole` outside the mirrored
 * enum to `null` — least privilege, never a sign-out — so by the time a session reaches
 * `getOrgRole()` (org-roles.ts) an unexpected role and "no membership" look the same. That is the
 * right BEHAVIOUR, and it is unchanged here; what it hid was the drift itself: the API adding a
 * role payer-web does not know would silently cost every such member their Owner rights.
 *
 * So the session read hands the RAW value here, and anything but `"owner"`, `"recruiter"`, `null`
 * or absent logs ONE server-side warn — once per distinct value per server process: the read runs
 * on every request, the drift is one fact. BOUNDED: after {@link MAX_REPORTED} distinct values one
 * last line says further values are suppressed, and nothing more is kept or logged — an API (or a
 * proxy) answering a fresh value per request can grow neither the set nor the log. Logged: the
 * value itself only when it is a short role-shaped token (`"admin"`), otherwise only its type.
 * Never the email, name or org label; no payer id either — payer-web's server logs carry none (cf.
 * `assertNoAgencyPII`, which names a path only), so this one does not start.
 */
const KNOWN_ORG_ROLES: ReadonlySet<unknown> = new Set<unknown>([
  "owner",
  "recruiter",
  null,
  undefined,
]);

/** A value safe and useful to name in the log: a short enum-like token, nothing free-form. */
const ROLE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Distinct values reported before the rest are suppressed (memory and log stay bounded). */
const MAX_REPORTED = 16;

const reported = new Set<string>();
let suppressed = false;

function describeValue(raw: unknown): string {
  if (typeof raw === "string" && ROLE_TOKEN.test(raw)) return JSON.stringify(raw);
  const kind = Array.isArray(raw) ? "array" : typeof raw;
  return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} value`;
}

/** The raw `orgRole` of a `/payer/me` body — `undefined` when the body or the key is absent. */
export function rawOrgRoleOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>).orgRole;
}

/**
 * Warn — once per distinct value per process, up to {@link MAX_REPORTED} values, then once that
 * further values are suppressed — when `raw` is not an `orgRole` payer-web knows.
 */
export function reportUnexpectedOrgRole(raw: unknown): void {
  if (KNOWN_ORG_ROLES.has(raw)) return;
  const value = describeValue(raw);
  if (reported.has(value) || suppressed) return;
  if (reported.size >= MAX_REPORTED) {
    suppressed = true;
    console.warn(
      `[payer-session] GET /payer/me returned more unexpected orgRole values; ` +
        `further values suppressed (${MAX_REPORTED} already reported).`,
    );
    return;
  }
  reported.add(value);
  console.warn(
    `[payer-session] GET /payer/me returned an unexpected orgRole (${value}); ` +
      `read as recruiter (least privilege). payer-web's OrgRole mirror is behind the API.`,
  );
}

/** Tests only: forget which values were already reported. */
export function resetOrgRoleDriftForTests(): void {
  reported.clear();
  suppressed = false;
}

/**
 * WHO COUNTS AS A DEMO WORKER — the one shared definition (Matching V1 demo, 2026-10-06).
 *
 * Owner ruling: demo tooling may act on, and demo views may show, ONLY
 *   1. the reserved DEMO phone block `+910000026xxx` (the seeded personas, and live demo workers
 *      onboarded on the local stack via test-login), and
 *   2. phones the owner lists in an ALLOW-LIST FILE (e.g. the owner's own handset on production).
 *
 * Consumers: `seed-demo-matching.ts` (`--reset-live-worker`), and any view that must show demo
 * workers only (e.g. the W4 engine view). Import from `@badabhai/db` — never re-declare the range.
 *
 * `WORKFORCE_SEED_PHONE_PATTERN` below is a SEPARATE carve-out of the same reserved range, owned
 * by `seed-synthetic-workforce.ts` — not a "demo worker" per this file's ruling, and not consumed
 * by anything here.
 *
 * ALLOW-LIST FILE FORMAT: UTF-8 text, one E.164 number per line (`+` then 8–15 digits, no spaces);
 * blank lines ignored; `#` starts a comment (whole line or trailing). Any other content is an
 * error — a malformed allow-list fails closed rather than silently allowing less or more.
 *
 * Pure, dependency-free, no IO: callers read the file and pass its text.
 */

/** The whole reserved synthetic range the test-login seam serves: `+91` + five zeros + five digits. */
export const RESERVED_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/;

/**
 * The DEMO block of the reserved range: `+910000026` + three digits. Narrower than the reserved
 * range on purpose — it never reaches the E4 fixture (19844) or the smoke worker (00000).
 */
export const DEMO_PHONE_PATTERN = /^\+910000026\d{3}$/;

/** The demo block's fixed prefix (`DEMO_PHONE_PATTERN` = this + exactly 3 digits). */
export const DEMO_PHONE_PREFIX = "+910000026";

/**
 * THE SYNTHETIC-WORKFORCE SEED block of the reserved range: `+910000050` + three digits
 * (1000 slots). Reserved for `seed-synthetic-workforce.ts` — the 250-worker / ~140-posting
 * synthetic cohort minted 2026-10-07 to repopulate production's Matching V1 engine after
 * `workers`/`worker_profiles`/`worker_skill`/`applications` were found wiped (unrelated
 * incident). Disjoint from every other carve-out of the reserved range: `DEMO_PHONE_PATTERN`
 * (`026xxx`, owned by `seed-demo-matching.ts`), the E4 fixture (`19844`), and the smoke
 * worker (`00000`).
 */
export const WORKFORCE_SEED_PHONE_PATTERN = /^\+910000050\d{3}$/;

/** The workforce-seed block's fixed prefix (`WORKFORCE_SEED_PHONE_PATTERN` = this + exactly 3 digits). */
export const WORKFORCE_SEED_PHONE_PREFIX = "+910000050";

/** E.164: `+`, a non-zero country digit, 8–15 digits in all. */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Parse an allow-list file's text. Throws (naming the line number, never its content) on a bad line. */
export function parseAllowPhones(text: string): Set<string> {
  const out = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (line.length === 0) return;
    if (!E164_PATTERN.test(line)) {
      throw new Error(
        `allow-list line ${i + 1} is not an E.164 number (one per line, e.g. +91XXXXXXXXXX)`,
      );
    }
    out.add(line);
  });
  return out;
}

/** True when `phone` is a demo worker's: in the demo block, or listed in the allow-list. */
export function isDemoWorkerPhone(
  phone: string,
  allowed: ReadonlySet<string> = new Set(),
): boolean {
  return DEMO_PHONE_PATTERN.test(phone) || (E164_PATTERN.test(phone) && allowed.has(phone));
}

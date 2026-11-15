/**
 * Synthetic worker phones for the e2e suites: one disjoint range per file.
 *
 * WHY. `POST /auth/test-login` (the D-3 seam) mints a worker only for the reserved block
 * `RESERVED_TEST_PHONE_PATTERN` (`+91` + five zeros + five digits, 100,000 numbers), and it
 * FIND-OR-CREATES by phone hash. Every suite used to draw from the whole block at random, so two
 * suites in one run (one CI database) could draw the same number: the later suite then logged in
 * as the earlier suite's worker, state and all. That is how swipe-to-apply's "NON-consented
 * worker gets 403" saw a consented worker and got 200 on main 961a1cdf1.
 *
 * WHAT. The last five digits split into 100 slots of 1,000 numbers (`SS` + `NNN`). Each suite
 * owns ONE slot, a literal at its call site, and `e2e-phone-slots.static.test.ts` fails the build
 * when two suites claim the same slot, when a slot is reserved below, or when a suite spells a
 * raw reserved-block number instead of calling this helper.
 *
 * WITHIN A SUITE. The minter walks its slot from a random start and wraps, so one suite never
 * hands out the same number twice. After 1,000 numbers it throws rather than repeat.
 */

/** The reserved block's fixed part: `+91` then five zeros. Five free digits follow. */
const RESERVED_BLOCK_PREFIX = "+91" + "00000";

/** Numbers per slot: the last three of the five free digits. */
export const SLOT_SIZE = 1_000;

/**
 * Slots other code already owns inside the reserved block. A suite may not take one:
 *   00 — the staging smoke's default worker `+910000000000` (scripts/staging-smoke.mjs).
 *   19 — the E4 fixture `+910000019844`.
 *   26 — the Matching V1 demo block `DEMO_PHONE_PREFIX` (`@badabhai/db` demo-phones.ts).
 *   50 — the synthetic-workforce seed block `WORKFORCE_SEED_PHONE_PREFIX` (same file).
 */
export const RESERVED_SLOTS: ReadonlySet<number> = new Set([0, 19, 26, 50]);

/**
 * A minter for one suite's slot (0–99, not reserved). Each call returns the next unused number
 * in that slot, e.g. slot 64 → `+91000006` + `4NNN`.
 *
 * @throws Error — a slot outside 0–99 or a reserved slot; or a 1,001st number from one minter.
 */
export function syntheticPhoneMinter(slot: number): () => string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 99) {
    throw new Error(`synthetic phone slot must be an integer 0-99, got ${slot}`);
  }
  if (RESERVED_SLOTS.has(slot)) {
    throw new Error(`synthetic phone slot ${slot} is reserved for other fixtures`);
  }
  const start = Math.floor(Math.random() * SLOT_SIZE);
  let issued = 0;
  return () => {
    if (issued >= SLOT_SIZE) {
      throw new Error(`synthetic phone slot ${slot} is exhausted (${SLOT_SIZE} numbers issued)`);
    }
    const tail = slot * SLOT_SIZE + ((start + issued) % SLOT_SIZE);
    issued += 1;
    return `${RESERVED_BLOCK_PREFIX}${String(tail).padStart(5, "0")}`;
  };
}

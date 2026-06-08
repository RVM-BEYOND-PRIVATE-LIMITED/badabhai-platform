/**
 * Database seed — PLACEHOLDER for Phase 1.
 *
 * Run with: `pnpm --filter @badabhai/db db:seed`
 *
 * Intentionally does NOT insert fake worker PII. When real seed data is needed
 * (e.g. demo workers for the ops console), add clearly-synthetic records here and
 * guard with NODE_ENV !== "production".
 */
import { getDb } from "./client";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed in production.");
  }

  // const db = getDb();
  // TODO(Phase 1): insert synthetic taxonomy-aligned demo data if/when needed.
  void getDb; // keep the import meaningful until seeding is implemented

  console.log("[seed] No seed data defined yet (Phase 1 placeholder). Nothing inserted.");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});

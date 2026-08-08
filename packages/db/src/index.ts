/**
 * @badabhai/db — Drizzle schema + client for BadaBhai's Supabase Postgres.
 *
 * - Schema/tables + row types: re-exported here and from "@badabhai/db/schema".
 * - Client: `createDbClient` (DI) / `getDb` (scripts).
 */
export * from "./schema";
export * from "./client";
export * from "./credit-packs";
export * from "./crypto";
// The one ordering that decides which `worker_profiles` row IS a worker's profile. Exported
// because the readers are spread across apps/api repositories AND the D2 backfill in this
// package — seven call sites that previously each had their own answer, one of them with no
// ORDER BY at all.
export * from "./current-profile";
// The family fallback chain. Its own header says it exists so "Phase 7's production
// QuestionPackService" can make this decision without a database — which requires that the
// service can actually IMPORT it. Unexported, the guarantee it offers (one decision, SQL-parity
// tested) is unreachable, and every consumer reimplements the chain instead.
export * from "./question-pack-resolver";
// The RFS vocabulary a `target_kind: "rfs"` question may write into. Exported because the
// orchestrator keys its capture-time normalizers on these same ids.
export * from "./rfs-vocabulary";
// The L0/L1 eval harness. Exported so `apps/api` can assert PARITY between the number this
// harness publishes and what `OccupationIndexService` actually does — see
// `occupation-retrieval-parity.test.ts`. Nothing on a request path imports it.
export * from "./occupation-retrieval-eval";
// The authored question-pack corpus reader + its validator. Exported for the SAME reason as the
// eval harness above and with the same caveat: nothing on a request path imports it. `apps/api`
// needs it to generate the reply-closure manifest — the enumeration of every string the engine can
// speak — from the real packs rather than from a fixture, and a manifest built from a fixture
// would pre-render audio for questions no worker is ever asked.
export * from "./question-pack-corpus";

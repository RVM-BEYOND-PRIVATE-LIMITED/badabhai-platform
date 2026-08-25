/**
 * LEARN label store (migration 0091) — the real-event training labels the offline
 * `@badabhai/reach-learn` calibrator trains from.
 *
 * WHY THIS EXISTS. reach-learn's 2026-06-17 eval ran entirely on synthetic data because
 * ZERO real feed/application events had been captured anywhere. The events ARE on the
 * spine (`feed.shown_v2`, `application.submitted`, `application.skipped`) — what was
 * missing is a durable per-IMPRESSION projection that joins them into a
 * (worker, posting) → outcome label with its rank/tier context at show time.
 * `applications` already records decisions; it does NOT record which impression they
 * followed, at what rank, through which matched skill — that context is exactly what a
 * learning-to-rank label needs and what this table keeps.
 *
 * SHAPE. One row per SERVED feed card (`feed.shown_v2` impression). A fresh row starts
 * `outcome='none'` (a WEAK NEGATIVE at export time — shown but never decided). When an
 * application event for the same (worker, posting) arrives later, every still-pending
 * impression of that pair is resolved to `applied`/`skipped` with the deciding event id.
 *
 * PII-FREE BY CONSTRUCTION: opaque worker/posting/event ids, closed-vocabulary
 * `mskill_*`, smallints and timestamps — the exact fields `FeedShownV2Payload` carries,
 * which is registry-enforced ids-only. Nothing here ever holds query text or free text.
 *
 * DPDP ERASURE: `worker_id` CASCADEs from `workers`, so the existing single-statement
 * hard delete removes a deleted worker's labels atomically — no deletion-service change,
 * mirroring `job_reach`.
 *
 * CONSUMER CONTRACT (offline only): `reach-learn`'s dataset assembler reads rows like
 * these plus a point-in-time signal snapshot; this package has NO dependency on it and
 * no runtime consumer. Export is a future ops script — writing labels correctly is the
 * whole job here.
 */
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SkipReason } from "@badabhai/taxonomy";
import { workers } from "./worker";
import { jobPostings } from "./job";

export const learnLabels = pgTable(
  "learn_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    // The `events.id` of the feed.shown_v2 row this label projects. UNIQUE is the
    // ingest's idempotency: a re-read window re-inserts nothing. No FK — the events
    // spine is append-only and outlives every subject.
    impressionEventId: uuid("impression_event_id").notNull(),
    // Post-interleave position when served (payload contract: >= 1).
    rank: integer("rank").notNull(),
    matchTier: smallint("match_tier").notNull(),
    boosted: boolean("boosted").notNull().default(false),
    // The mskill_* that earned the tier — "why was this card shown?" for offline analysis.
    matchedSkillId: text("matched_skill_id").notNull(),
    /** none → applied | skipped. 'none' exports as a weak negative (label 0). */
    outcome: text("outcome")
      .$type<"none" | "applied" | "skipped">()
      .notNull()
      .default("none"),
    // The application.* event row that resolved the outcome (null while pending).
    outcomeEventId: uuid("outcome_event_id"),
    skipReason: text("skip_reason").$type<SkipReason | null>(),
    /** The binary learning target: applied = 1, anything else = 0. */
    label: smallint("label").notNull().default(0),
    shownAt: timestamp("shown_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ingest idempotency (see above).
    uniqueIndex("learn_labels_impression_uq").on(t.impressionEventId),
    // Resolution probe: pending impressions for a deciding (worker, posting) pair.
    index("learn_labels_resolve_idx").on(t.workerId, t.jobPostingId),
    // Offline export windows + temporal train/test splits order by shown time.
    index("learn_labels_shown_at_idx").on(t.shownAt),
    check("learn_labels_outcome_chk", sql`${t.outcome} IN ('none', 'applied', 'skipped')`),
    check("learn_labels_label_chk", sql`${t.label} IN (0, 1)`),
    check("learn_labels_rank_chk", sql`${t.rank} >= 1`),
    check("learn_labels_tier_chk", sql`${t.matchTier} IN (1, 2)`),
    check(
      "learn_labels_skip_reason_chk",
      sql`(${t.skipReason} IS NULL AND ${t.outcome} <> 'skipped') OR (${t.skipReason} IS NOT NULL AND ${t.outcome} = 'skipped')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0091

/**
 * Single-row sweep cursor (`id = 'singleton'`). Stores the high-water
 * `events.created_at` the producer has consumed; each tick re-reads a small OVERLAP
 * window before it, because idempotency comes from the UNIQUE impression key and the
 * resolution guard (`resolved_at IS NULL`), never from exact-once delivery.
 */
export const learnLabelsCursor = pgTable("learn_labels_cursor", {
  id: text("id").primaryKey(), // always 'singleton'
  watermark: timestamp("watermark", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0091

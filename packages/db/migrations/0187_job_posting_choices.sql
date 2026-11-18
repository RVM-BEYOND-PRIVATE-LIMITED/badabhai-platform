-- ==============================================================================
-- job_posting_choices: which posting button a company tapped (#2751 items 1 to 3)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2751 items 1 to 3 (brief 4B.7, B4B-26). A company publishes a job with one of two buttons,
-- "Post free" (`free`) or "Post free + Starter" (`free_plus_pack`), on payer-web or the payer app
-- (`web` / `app`). The job goes live either way; this table records the tap, ONE ROW PER POSTING
-- (the posting id is the primary key), so the numbers screen can count the share per button by
-- week, city and trade (joined through the posting). The purchase a paid tap starts is joined
-- through `payment_orders.origin_job_posting_id` (#2749 item 9), not stored here.
--
-- A NEW TABLE, NOT COLUMNS ON `job_postings`: the posting reads select every column, so a new
-- column there would make this migration apply-before-deploy.
--
-- PII-FREE: ids, two closed codes and a time.
--
-- ADDITIVE ONLY. One new, EMPTY table, its two indexes and one foreign key; no existing column,
-- constraint or row moves. Nothing is seeded.
--
-- DEPLOY ORDER - APPLY BEFORE POSTING_CHOICE_ROLLOUT IS SET TO pilot OR on, NOT BEFORE THE DEPLOY.
-- Nothing names this table while the switch is off for a company (the default): the
-- posting-options route answers 404 and the publish ignores `posting_choice`. Armed with the table
-- missing, the publish still succeeds (the record is written after the publish committed, and its
-- error is logged and swallowed) and the choice is simply not recorded.
-- Apply every lower-numbered migration first (slot order), then this.
--
-- LOCKS. The new table is empty. The foreign key takes a brief SHARE ROW EXCLUSIVE lock on
-- `job_postings` (blocks its writes, not its reads, for the instant the constraint is added;
-- nothing to validate). Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;`
-- and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 / 0185 / 0186 pattern) - a regenerate drops them
-- silently. The table is registered as an `rls` entry in `schema-contract.ts` and listed in
-- LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch POSTING_CHOICE_ROLLOUT off first; the recorded taps are lost):
--   DROP TABLE IF EXISTS "job_posting_choices";
-- ==============================================================================
CREATE TABLE "job_posting_choices" (
	"job_posting_id" uuid PRIMARY KEY NOT NULL,
	"payer_id" uuid NOT NULL,
	"choice" text NOT NULL,
	"surface" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_posting_choices_choice_chk" CHECK ("job_posting_choices"."choice" IN ('free', 'free_plus_pack')),
	CONSTRAINT "job_posting_choices_surface_chk" CHECK ("job_posting_choices"."surface" IN ('web', 'app'))
);
--> statement-breakpoint
ALTER TABLE "job_posting_choices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_posting_choices" ADD CONSTRAINT "job_posting_choices_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_posting_choices_recorded_idx" ON "job_posting_choices" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "job_posting_choices_payer_idx" ON "job_posting_choices" USING btree ("payer_id");

--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 / 0185 / 0186 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "job_posting_choices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_choices" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_choices" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_choices" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_choices" FROM service_role;

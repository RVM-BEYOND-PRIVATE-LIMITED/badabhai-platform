-- ===========================================================================
-- 0121 — pay_type (#1648) + unticked_related_ids (#1645)
--
-- PURELY ADDITIVE (§10). Three new columns, two NULL-tolerant CHECKs, no backfill,
-- no rewrite, no drop. Every existing row and every shipped reader is untouched.
--
--  * job_postings.unticked_related_ids  jsonb NOT NULL DEFAULT '[]'
--      The curated related skills a poster chose to DROP. Until now an untick existed
--      only as a PATCH body read at reach-resolution time, so unticks supplied at
--      CREATE were lost by publish and the reach silently widened past what the payer
--      asked for. This is the REQUEST, never the result: `reach_skill_ids` stays
--      server-resolved by `resolveReachSet` and no client input sets it (Policy 10).
--
--  * job_postings.pay_type / jobs.pay_type  text NULL
--      What the ₹ band MEANS: in_hand | gross | ctc. NULLABLE WITH NO DEFAULT AND NO
--      BACKFILL — NULL is "the poster did not state it", never a hidden `gross`. Every
--      row that exists today reads NULL and the worker card renders the band with no
--      pay-type pill, which is the app's existing behaviour. A default here would make
--      the platform assert a net-vs-gross claim nobody made.
--
-- ROLLBACK: drop the two CHECKs and the three columns. Nothing reads them fail-closed.
-- ===========================================================================
ALTER TABLE "job_postings" ADD COLUMN "unticked_related_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "pay_type" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pay_type" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_pay_type_chk" CHECK ("job_postings"."pay_type" IS NULL OR "job_postings"."pay_type" IN ('in_hand', 'gross', 'ctc'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pay_type_chk" CHECK ("jobs"."pay_type" IS NULL OR "jobs"."pay_type" IN ('in_hand', 'gross', 'ctc'));
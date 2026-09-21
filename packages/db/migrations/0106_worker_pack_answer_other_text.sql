-- ===========================================================================
-- 0106 — worker_pack_answer gains a fifth typed answer column plus its LLM-reviewed rewrite
--
-- "Typed custom answer, everywhere" (owner ruling, round 4): a worker may type free text
-- against a CLOSED-OPTION question instead of tapping a chip. That text is not reviewed
-- vocabulary — it must never decide a tier gate, never become a matchable
-- `worker_attributes` row, and never print on a resume unreviewed. `answer_other_text`
-- keeps that fact visible in the SHAPE of the row (NULL in every other typed column)
-- rather than relying on every reader to reimplement the rule.
--
-- `answer_other_text_polished` / `_polished_declined` mirror the ADR-0039
-- work-history-polish precedent exactly (`worker_attributes.value_text_polished` /
-- `value_text_polished_declined`): the ruling text is "print it after LLM reviews it...
-- If the LLM finds that it is irrelevant it can omit the reply as well" — the polished
-- column is what may print, `answer_other_text` never does, and `_declined` is the
-- worker's own refusal of the rewrite, kept apart from "not reviewed yet".
--
-- ADDITIVE, BACKWARD-COMPATIBLE. No column removed, no existing row touched. The CHECK is
-- dropped and re-added widened to include `answer_other_text` in the same "exactly one of
-- five" biconditional it already enforced over four — every row written before this
-- migration still satisfies it (its `answer_other_text` is NULL, contributing 0 to the
-- sum). The two polish columns are outside the CHECK, exactly like
-- `worker_attributes.value_text_polished*` is outside that table's shape constraint.
--
-- APPLY-BEFORE-DEPLOY. Once code that can WRITE `answer_other_text` ships, this migration
-- must already be applied — an INSERT naming a column that does not exist yet fails closed
-- (500), never partially.
--
-- ROLLBACK: additive-only, so rollback is a straight reversal and safe at any time these
-- columns hold no rows (i.e., before the writer above is deployed):
--   ALTER TABLE "worker_pack_answer" DROP CONSTRAINT "wpa_answer_shape_chk";
--   ALTER TABLE "worker_pack_answer" DROP COLUMN "answer_other_text";
--   ALTER TABLE "worker_pack_answer" DROP COLUMN "answer_other_text_polished";
--   ALTER TABLE "worker_pack_answer" DROP COLUMN "answer_other_text_polished_declined";
--   ALTER TABLE "worker_pack_answer" ADD CONSTRAINT "wpa_answer_shape_chk" CHECK (
--     ("status" = 'answered') = (
--       ("answer_text" IS NOT NULL)::int + ("answer_number" IS NOT NULL)::int
--       + ("answer_bool" IS NOT NULL)::int + ("answer_option_keys" IS NOT NULL)::int = 1
--     )
--   );
-- If any row has `answer_other_text` set by the time rollback is needed, the DROP COLUMN
-- destroys those workers' typed "other" answers — CLAUDE.md §10 forbids that once real data
-- exists; at that point the correct rollback is code-only (stop writing the columns), never
-- a schema rollback.
-- ===========================================================================
ALTER TABLE "worker_pack_answer" DROP CONSTRAINT "wpa_answer_shape_chk";--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ADD COLUMN "answer_other_text" text;--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ADD COLUMN "answer_other_text_polished" text;--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ADD COLUMN "answer_other_text_polished_declined" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ADD CONSTRAINT "wpa_answer_shape_chk" CHECK (("worker_pack_answer"."status" = 'answered') = (
        ("worker_pack_answer"."answer_text" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_number" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_bool" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_option_keys" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_other_text" IS NOT NULL)::int
        = 1
      ));

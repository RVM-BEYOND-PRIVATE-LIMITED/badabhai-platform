-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0111 — worker_attributes.value_json: the `json` value kind
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ADR-0042 D9 / Layer A (c). One structured answer kind joins boolean/number/text/text_list:
-- `availability` is one fact with three named parts (`status`, `available_from`,
-- `notice_period_days`) and needs one object in one row rather than three independently
-- clobberable attribute keys.
--
-- WHAT MOVES:
--   * ADD COLUMN value_json jsonb (nullable, no default — catalog-only on PG11+);
--   * wa_value_kind_chk widened to admit 'json';
--   * wa_value_present_chk re-stated with the json branch: exactly one value column populated,
--     and the one `value_kind` names;
--   * wa_value_json_shape_chk: a json value is an OBJECT, never an array/scalar/null.
--
-- ADDITIVE / BACKWARD-COMPATIBLE. No existing row changes: every row written before this file
-- has value_json NULL, and each of the four original branches of wa_value_present_chk now also
-- demands value_json IS NULL — true of all of them. No backfill. Old builds never name the
-- column and keep working (their INSERTs leave it NULL).
--
-- APPLY-BEFORE-DEPLOY. `WorkerAttributesRepository.upsertMany` names every value column in its
-- INSERT list and its ON CONFLICT SET (including `excluded.value_json`), so a build carrying the
-- column against a database without it fails EVERY attribute write — the interview soak and the
-- trade form included. Registered as `0111-worker-attributes-value-json-column` in
-- `schema-contract.ts`; run `pnpm --filter @badabhai/db db:audit:schema-contract` first.
--
-- Reversible while no `json` row exists (the four original kinds are untouched):
--
--   ALTER TABLE "worker_attributes" DROP CONSTRAINT "wa_value_json_shape_chk";
--   ALTER TABLE "worker_attributes" DROP CONSTRAINT "wa_value_present_chk";
--   ALTER TABLE "worker_attributes" DROP CONSTRAINT "wa_value_kind_chk";
--   ALTER TABLE "worker_attributes" DROP COLUMN "value_json";
--   -- then re-add the 0106 definitions of wa_value_kind_chk / wa_value_present_chk.
--
-- COST. ADD COLUMN is catalog-only. The two re-added CHECKs take ACCESS EXCLUSIVE and VALIDATE
-- by scanning the table once each; run under `SET lock_timeout = '3s';` and retry on 55P03 if
-- `worker_attributes` is large. The scan is read-only and the rewrite is none.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE "worker_attributes" DROP CONSTRAINT "wa_value_kind_chk";--> statement-breakpoint
ALTER TABLE "worker_attributes" DROP CONSTRAINT "wa_value_present_chk";--> statement-breakpoint
ALTER TABLE "worker_attributes" ADD COLUMN "value_json" jsonb;--> statement-breakpoint
ALTER TABLE "worker_attributes" ADD CONSTRAINT "wa_value_json_shape_chk" CHECK ("worker_attributes"."value_json" IS NULL OR ("worker_attributes"."value_kind" = 'json' AND jsonb_typeof("worker_attributes"."value_json") = 'object'));--> statement-breakpoint
ALTER TABLE "worker_attributes" ADD CONSTRAINT "wa_value_kind_chk" CHECK ("worker_attributes"."value_kind" IN ('boolean', 'number', 'text', 'text_list', 'json'));--> statement-breakpoint
ALTER TABLE "worker_attributes" ADD CONSTRAINT "wa_value_present_chk" CHECK ((
        ("worker_attributes"."value_kind" = 'boolean'   AND "worker_attributes"."value_bool" IS NOT NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text" IS NULL AND "worker_attributes"."value_text_list" IS NULL AND "worker_attributes"."value_json" IS NULL) OR
        ("worker_attributes"."value_kind" = 'number'    AND "worker_attributes"."value_number" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_text" IS NULL AND "worker_attributes"."value_text_list" IS NULL AND "worker_attributes"."value_json" IS NULL) OR
        ("worker_attributes"."value_kind" = 'text'      AND "worker_attributes"."value_text" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text_list" IS NULL AND "worker_attributes"."value_json" IS NULL) OR
        ("worker_attributes"."value_kind" = 'text_list' AND "worker_attributes"."value_text_list" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text" IS NULL AND "worker_attributes"."value_json" IS NULL) OR
        ("worker_attributes"."value_kind" = 'json'      AND "worker_attributes"."value_json" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text" IS NULL AND "worker_attributes"."value_text_list" IS NULL)
      ));

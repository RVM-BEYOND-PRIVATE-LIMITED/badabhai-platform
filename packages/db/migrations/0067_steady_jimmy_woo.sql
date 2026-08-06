-- ═══════════════════════════════════════════════════════════════════════════════════════
-- 0067 — Retrieval foundations for the Occupation Intelligence Engine (Phase 1).
--
-- WHY. A worker says "kharad ka kaam karta hun". The catalogue calls it "Machine Tool
-- Setter-Operator, Lathe". Today the ONLY way to bridge that is a vector embedding, so
-- every profiling turn costs an embedding call — and even that path is broken, because
-- `nearestDomains` leads its ORDER BY with the dedupe key and can therefore never use the
-- HNSW index it was built for (verified by EXPLAIN: Seq Scan over all 8,695 aliases).
--
-- This migration lays the two FREE retrieval layers underneath the paid one:
--   L0  exact  — `text_norm` btree, an equality probe on the normalized phrase
--   L2  fuzzy  — `pg_trgm` GIN over the same column, for misspellings
-- and repairs L3 so the ANN index is actually reachable.
--
-- CONSOLIDATION NOTE. The sprint plan splits this into 0067 + 0068, with 0068 deferred
-- until after `db:normalize:aliases` had run, because a unique index on
-- (job_domain_id, text_norm, lang) NULLS NOT DISTINCT fails while text_norm is still NULL
-- — every domain with 2+ aliases is a duplicate. Verified against the live catalogue:
--     ERROR: could not create unique index "job_domain_alias_domain_norm_lang_uq"
--     DETAIL: Key (job_domain_id, text_norm, lang)=(jd_isco_8111, null, en) is duplicated.
-- Making that index PARTIAL on `is_searchable` (default false) removes the ordering
-- dependency completely: the index is empty at creation and can never fail. Two migrations
-- separated by a mandatory data-runner run is a deploy hazard; one order-independent
-- migration is not. So they are merged here and 0068 is left unclaimed.
--
-- ── DEPLOY ORDER (THE RUNNER IS NOT OPTIONAL) ─────────────────────────────────────────
--   pnpm db:migrate
--   pnpm db:normalize:aliases --apply      <-- REQUIRED, part of the deploy
--   pnpm db:verify:domains
--
-- This migration adds `is_searchable` with a DEFAULT of false and deliberately does NOT
-- backfill it. Until the runner has run, `is_searchable` is false everywhere, the partial
-- HNSW index is EMPTY, and `nearestDomains` returns nothing.
--
-- That is a considered trade, not an oversight: a SQL backfill would require a second
-- implementation of `normalizeOccupationText` inside the migration, and two normalizers
-- that drift is the precise failure this whole design exists to prevent. The cost is that
-- the runner belongs to the deploy rather than to a follow-up. `db:verify:domains` WARNs
-- for as long as the catalogue is un-normalized, so the state is loud rather than silent.
--
-- In practice this window is not a regression: zero aliases are embedded today, so L3
-- already returns nothing.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────────────────
-- `is_searchable` has a CONSTANT default, so PG11+ records it in the catalog and does NOT
-- rewrite the table. `text_norm` is nullable with no default — also metadata-only.
--
-- The two GENERATED STORED columns DO rewrite `job_domain` (4,071 rows, ~0.1 s) and hold an
-- ACCESS EXCLUSIVE lock for the duration. That is acceptable here and nowhere near a hot
-- table: `job_domain` is a reference catalogue written only by `db:seed:domains`.
--
-- The HNSW index is DROPped and recreated. This is close to free TODAY — zero aliases are
-- embedded, so there is nothing to rebuild. Doing it after the Phase 2 alias backfill would
-- mean re-indexing a corpus we paid to embed, which is why it happens now.
--
-- ── PII ───────────────────────────────────────────────────────────────────────────────
-- NONE. `job_domain` and `job_domain_alias` are a published occupation catalogue (NCO-2015
-- / ISCO-08) plus vectors over those titles — PII-free by construction, per 0066. The one
-- statement that touches a worker-facing table (`chat_messages_session_created_idx`) is an
-- INDEX on (session_id, created_at); it stores no message body and no new column.
--
-- ── SECURITY ──────────────────────────────────────────────────────────────────────────
-- No new table, so no new RLS surface. `job_domain` and `job_domain_alias` already carry
-- ENABLE + FORCE ROW LEVEL SECURITY and the four REVOKEs from 0066; adding a column or an
-- index does not weaken any of it. `pg_trgm` installs functions and operator classes only —
-- it grants nothing and exposes no data.
--
-- ── SAFE TO RE-RUN ────────────────────────────────────────────────────────────────────
-- `CREATE EXTENSION IF NOT EXISTS` and the guarded `DROP INDEX IF EXISTS` are idempotent.
-- The remaining statements are not, and do not need to be — drizzle's journal applies each
-- migration exactly once.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS job_domain_alias_domain_norm_lang_uq, job_domain_alias_text_norm_trgm_idx,
--              job_domain_alias_text_norm_idx, job_domain_isco_minor_idx,
--              job_domain_isco_submajor_idx, chat_messages_session_created_idx,
--              job_domain_alias_embedding_hnsw;
--   ALTER TABLE job_domain       DROP COLUMN isco_minor_code, DROP COLUMN isco_submajor_code;
--   ALTER TABLE job_domain_alias DROP COLUMN text_norm, DROP COLUMN is_searchable;
--   CREATE INDEX job_domain_alias_embedding_hnsw
--     ON job_domain_alias USING hnsw (embedding vector_cosine_ops);   -- the 0066 form
-- Leave `pg_trgm` installed: dropping an extension other objects may come to depend on is
-- the riskier half of the rollback, and an unused extension costs nothing.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- HAND-PREPENDED (drizzle cannot model an extension). Required by
-- `job_domain_alias_text_norm_trgm_idx` below, which uses the `gin_trgm_ops` operator class.
-- Same shape and same reason as pgvector in 0001_same_xavin.sql.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- HAND-EDITED: `IF EXISTS` added. Drizzle emits a bare DROP INDEX, which aborts the entire
-- migration on any database where the 0066 index was already removed by hand — a rollback
-- rehearsal, or a restore taken mid-repair. The recreate below is unconditional, so the end
-- state is identical either way.
DROP INDEX IF EXISTS "job_domain_alias_embedding_hnsw";--> statement-breakpoint
ALTER TABLE "job_domain_alias" ADD COLUMN "text_norm" text;--> statement-breakpoint
ALTER TABLE "job_domain_alias" ADD COLUMN "is_searchable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_domain" ADD COLUMN "isco_minor_code" text GENERATED ALWAYS AS (left("job_domain"."isco_unit_code", 3)) STORED;--> statement-breakpoint
ALTER TABLE "job_domain" ADD COLUMN "isco_submajor_code" text GENERATED ALWAYS AS (left("job_domain"."isco_unit_code", 2)) STORED;--> statement-breakpoint
-- NULLS FIRST is load-bearing, not noise. A bare `ORDER BY created_at DESC` MEANS
-- DESC NULLS FIRST, and an index built NULLS LAST does not satisfy that ordering. Measured
-- over 200k rows: the NULLS LAST form gave Bitmap Index Scan + a separate top-N Sort
-- (1.32 ms) — the index served the FILTER while the sort still happened, which is the whole
-- thing this index exists to remove. This form gives a plain Index Scan, no Sort (0.17 ms).
-- `created_at` is NOT NULL, so no result changes — only the plan.
CREATE INDEX "chat_messages_session_created_idx" ON "chat_messages" USING btree ("session_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "job_domain_alias_text_norm_idx" ON "job_domain_alias" USING btree ("text_norm");--> statement-breakpoint
CREATE INDEX "job_domain_alias_text_norm_trgm_idx" ON "job_domain_alias" USING gin ("text_norm" gin_trgm_ops);--> statement-breakpoint
-- HAND-EDITED: `NULLS NOT DISTINCT` appended (PG15+). This drizzle version can only model
-- that clause on a table CONSTRAINT, never on an INDEX, so it is added here and mirrored by
-- a comment at the schema-side index — exactly as `unresolved_phrase_uq` did in 0037.
-- DO NOT REGENERATE OVER IT.
--
-- Its scope, precisely, because the obvious reading is wrong: it makes two rows whose `lang`
-- is NULL collide WITH EACH OTHER. It does NOT make a NULL `lang` collide with 'en' — those
-- stay distinct rows, which is correct, since an untagged alias and an explicitly-English
-- alias are different catalogue entries.
CREATE UNIQUE INDEX "job_domain_alias_domain_norm_lang_uq" ON "job_domain_alias" USING btree ("job_domain_id","text_norm","lang") NULLS NOT DISTINCT WHERE "job_domain_alias"."is_searchable";--> statement-breakpoint
CREATE INDEX "job_domain_isco_minor_idx" ON "job_domain" USING btree ("isco_minor_code");--> statement-breakpoint
CREATE INDEX "job_domain_isco_submajor_idx" ON "job_domain" USING btree ("isco_submajor_code");--> statement-breakpoint
CREATE INDEX "job_domain_alias_embedding_hnsw" ON "job_domain_alias" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=128) WHERE "job_domain_alias"."is_searchable";

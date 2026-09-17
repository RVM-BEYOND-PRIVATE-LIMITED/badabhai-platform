-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0113 — worker_portfolio: work samples (photo / video / link)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ADR-0042 D9 / Layer A (e). One row per work sample, in the worker's own order:
--
--   kind 'photo' | 'video'  →  storage_key is the opaque object key in the private portfolio
--                              bucket (`portfolio/{workerId}/{uuid}.{ext}`, server-chosen at
--                              mint time). NEVER a URL, never bytes.
--   kind 'link'             →  url is an external https(s) link.
--
-- `wp_content_chk` refuses a row carrying both or neither, so every reader knows which column a
-- kind means. `wp_url_scheme_chk` keeps a link a link (no `javascript:`, no relative paths).
--
-- ADDITIVE / BACKWARD-COMPATIBLE. One new, empty table. Rollback is one statement:
--
--   DROP TABLE "worker_portfolio";
--
-- APPLY-BEFORE-DEPLOY: `WorkerPortfolioRepository` names the table unconditionally on
-- PUT/GET /workers/me/portfolio and the mint route. Registered as `0113-worker-portfolio-table` +
-- `0113-worker-portfolio-rls` in `schema-contract.ts`; listed in `LOCKED_TABLES` in the e2e RLS
-- spine. The storage bucket itself is an infra action (`WORKER_PORTFOLIO_BUCKET`, dormant when
-- unset — the mint route 503s exactly like the photo route).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "worker_portfolio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text,
	"url" text,
	"caption" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wp_kind_chk" CHECK ("worker_portfolio"."kind" IN ('photo', 'video', 'link')),
	CONSTRAINT "wp_content_chk" CHECK ((
        ("worker_portfolio"."kind" IN ('photo', 'video') AND "worker_portfolio"."storage_key" IS NOT NULL AND "worker_portfolio"."url" IS NULL) OR
        ("worker_portfolio"."kind" = 'link' AND "worker_portfolio"."url" IS NOT NULL AND "worker_portfolio"."storage_key" IS NULL)
      )),
	CONSTRAINT "wp_url_scheme_chk" CHECK ("worker_portfolio"."url" IS NULL OR "worker_portfolio"."url" ~ '^https?://'),
	CONSTRAINT "wp_caption_len_chk" CHECK ("worker_portfolio"."caption" IS NULL OR length("worker_portfolio"."caption") <= 160),
	CONSTRAINT "wp_sort_order_chk" CHECK ("worker_portfolio"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_portfolio" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_portfolio" ADD CONSTRAINT "worker_portfolio_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wp_worker_sort_uq" ON "worker_portfolio" USING btree ("worker_id","sort_order");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- ===========================================================================
ALTER TABLE "worker_portfolio" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_portfolio" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_portfolio" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_portfolio" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_portfolio" FROM service_role;

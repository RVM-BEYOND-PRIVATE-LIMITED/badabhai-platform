CREATE INDEX "applications_admin_keyset_idx" ON "applications" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_ledger_payer_keyset_idx" ON "credit_ledger" USING btree ("payer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payers_admin_keyset_idx" ON "payers" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workers_admin_keyset_idx" ON "workers" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
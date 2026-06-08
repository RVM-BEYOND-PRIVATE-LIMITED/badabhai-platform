-- Enable pgvector (required for the vector type + HNSW index below).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "embedding" vector(768);--> statement-breakpoint
CREATE INDEX "worker_profiles_embedding_hnsw" ON "worker_profiles" USING hnsw ("embedding" vector_cosine_ops);

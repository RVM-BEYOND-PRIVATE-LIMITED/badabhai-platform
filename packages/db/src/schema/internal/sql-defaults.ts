import { sql } from "drizzle-orm";

// The two shared JSONB column defaults, moved out of the old single-file schema so
// every domain module can share them. Internal to packages/db — deliberately NOT
// re-exported from the schema barrel, so the public surface is unchanged.
const jsonObject = sql`'{}'::jsonb`;
const jsonArray = sql`'[]'::jsonb`;

export { jsonObject, jsonArray };

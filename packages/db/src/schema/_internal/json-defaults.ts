import { sql } from "drizzle-orm";

// Internal (non-exported from the schema barrel) jsonb column defaults shared by
// the domain modules. Moved verbatim out of the pre-split schema.ts header.
export const jsonObject = sql`'{}'::jsonb`;
export const jsonArray = sql`'[]'::jsonb`;

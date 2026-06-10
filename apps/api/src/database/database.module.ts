import { Global, Module, type OnModuleDestroy, Inject, Logger } from "@nestjs/common";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** DI token for the Drizzle `Database` instance (use in repositories). */
export const DATABASE = "DATABASE";
/** DI token for the full `{ db, sql }` client (used to close the pool). */
export const DB_CLIENT = "DB_CLIENT";

/**
 * Provides the Drizzle database. postgres.js connects lazily, so the app boots
 * even when the DB is unreachable — queries fail at call time, not at startup.
 *
 * The backend connects via DATABASE_URL as the `postgres` role (the Supabase
 * session-pooler `postgres.<ref>` user) over a DIRECT Postgres connection. That
 * role has BYPASSRLS and is distinct from the PostgREST `service_role` (Data API).
 * RLS is now ENABLED + deny-by-default on `workers` (migrations 0003/0004) with
 * grants revoked from anon/authenticated/service_role — so DATABASE_URL MUST point
 * at a BYPASSRLS role, or workers reads/writes will be denied (42501).
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig): DbClient => createDbClient(config.DATABASE_URL),
    },
    {
      provide: DATABASE,
      inject: [DB_CLIENT],
      useFactory: (client: DbClient): Database => client.db,
    },
  ],
  exports: [DATABASE, DB_CLIENT],
})
export class DatabaseModule implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(DB_CLIENT) private readonly client: DbClient) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.sql.end({ timeout: 5 });
    } catch (err) {
      this.logger.warn(`Error closing DB pool: ${String(err)}`);
    }
  }
}

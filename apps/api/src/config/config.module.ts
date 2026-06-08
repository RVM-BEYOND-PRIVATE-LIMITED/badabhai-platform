import { Global, Module } from "@nestjs/common";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";

/** DI token for the validated server configuration. */
export const SERVER_CONFIG = "SERVER_CONFIG";

/**
 * Loads and validates server env once at startup. Throws (crashes the process)
 * on invalid config — fail fast rather than run mis-configured.
 */
@Global()
@Module({
  providers: [
    {
      provide: SERVER_CONFIG,
      useFactory: (): ServerConfig => loadServerConfig(),
    },
  ],
  exports: [SERVER_CONFIG],
})
export class AppConfigModule {}

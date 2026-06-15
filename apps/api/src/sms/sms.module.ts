import { Global, Module } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { SMS_PROVIDER, type SmsProvider } from "./sms.provider";
import { ConsoleSmsProvider } from "./console-sms.provider";
import { Fast2SmsProvider } from "./fast2sms.provider";

/**
 * Provides the active {@link SmsProvider} behind the {@link SMS_PROVIDER} token,
 * selected by config. Global so the auth module (and any future caller) can
 * inject it without re-wiring. The console provider is dev/test only — the boot
 * guard (`assertAuthConfig`) forbids it outside development.
 */
@Global()
@Module({
  providers: [
    ConsoleSmsProvider,
    Fast2SmsProvider,
    {
      provide: SMS_PROVIDER,
      inject: [SERVER_CONFIG, ConsoleSmsProvider, Fast2SmsProvider],
      useFactory: (
        config: ServerConfig,
        consoleProvider: ConsoleSmsProvider,
        fast2sms: Fast2SmsProvider,
      ): SmsProvider => (config.SMS_PROVIDER === "fast2sms" ? fast2sms : consoleProvider),
    },
  ],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}

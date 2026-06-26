import { Global, Module } from "@nestjs/common";
import { SMS_PROVIDER } from "./sms.provider";
import { Fast2SmsProvider } from "./fast2sms.provider";

/**
 * Provides the active {@link SmsProvider} behind the {@link SMS_PROVIDER} token.
 * Real-only: worker OTP is delivered exclusively via the real Fast2SMS DLT gateway —
 * there is no dev/console provider. The boot guard (`assertAuthConfig`) requires the
 * Fast2SMS credentials in every environment, so the app fails closed without them.
 * Global so the auth module (and any future caller) can inject it without re-wiring.
 */
@Global()
@Module({
  providers: [Fast2SmsProvider, { provide: SMS_PROVIDER, useExisting: Fast2SmsProvider }],
  exports: [SMS_PROVIDER],
})
export class SmsModule {}

import { Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { SmsProvider } from "./sms.provider";

/**
 * Dev/test SMS provider: writes the OTP code to the server log so a developer can
 * read it locally without a real SMS gateway.
 *
 * This is the ONLY place the code is intentionally logged, and it is acceptable
 * solely because it can never run outside development: `assertAuthConfig` fails
 * closed at boot if SMS_PROVIDER=console with a non-dev NODE_ENV. The raw phone
 * number is still never logged — only a prefix of its keyed HASH.
 */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  constructor(private readonly pii: PiiCryptoService) {}

  async sendOtp(input: { phoneE164: string; code: string }): Promise<void> {
    const phoneHashPrefix = this.pii.hashPhone(input.phoneE164).slice(0, 8);
    // DEV ONLY: the code is printed so a local developer can complete the flow.
    this.logger.log(`OTP issued [dev] ${phoneHashPrefix} code=${input.code}`);
  }
}

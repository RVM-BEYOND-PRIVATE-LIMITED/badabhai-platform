import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { SmsSendError, type SmsProvider } from "./sms.provider";

const FAST2SMS_BULK_URL = "https://www.fast2sms.com/dev/bulkV2";

/**
 * Real OTP delivery via Fast2SMS (DLT route).
 *
 * Everything Fast2SMS-specific is isolated here behind {@link SmsProvider} so the
 * rest of the auth flow is provider-agnostic. The real credentials and the exact
 * approved DLT template + variable order will be supplied later; only this file
 * should need to change when they arrive.
 *
 * PRIVACY: this provider NEVER logs the OTP code or the raw phone number. On
 * failure it logs only a prefix of the phone HASH + a status, and the thrown
 * Error message contains neither the code nor the number.
 */
@Injectable()
export class Fast2SmsProvider implements SmsProvider {
  private readonly logger = new Logger(Fast2SmsProvider.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
  ) {}

  async sendOtp(input: { phoneE164: string; code: string; templateId?: string }): Promise<void> {
    // A caller with its own approved template (the company sign-in message) names it; the
    // worker sign-in template stays the default.
    await this.deliver(
      { phoneE164: input.phoneE164, templateId: input.templateId ?? this.config.FAST2SMS_DLT_TEMPLATE_ID, variables: [input.code] },
      "OTP",
    );
  }

  /**
   * #2787 — send any other approved DLT template (the first sign-in message to a moved company).
   * NOT part of {@link SmsProvider}: only the Campus import's `--notify` step calls it, with the
   * template id the operator supplies. `variables` fill the template's `{#var#}` slots in order
   * (pipe-separated on the wire); a variable may not itself contain a pipe. Same failure contract
   * and the same privacy rule as {@link sendOtp}: throws {@link SmsSendError} on a delivery failure
   * and never logs the number or a variable.
   */
  async sendTemplate(input: { phoneE164: string; templateId: string; variables: readonly string[] }): Promise<void> {
    if (input.variables.some((v) => v.includes("|"))) {
      throw new Error("a DLT template variable cannot contain a pipe");
    }
    await this.deliver(input, "template SMS");
  }

  private async deliver(
    input: { phoneE164: string; templateId: string | undefined; variables: readonly string[] },
    label: string,
  ): Promise<void> {
    const apiKey = this.config.FAST2SMS_API_KEY;
    const senderId = this.config.FAST2SMS_SENDER_ID;
    const templateId = input.templateId;
    // assertAuthConfig guarantees these are present in non-dev; guard anyway so a
    // misconfig fails CLOSED (throws) rather than sending a malformed request.
    if (!apiKey || !senderId || !templateId) {
      throw new Error("Fast2SMS provider is not fully configured");
    }

    const number = Fast2SmsProvider.toNationalNumber(input.phoneE164);
    const phoneHashPrefix = this.pii.hashPhone(input.phoneE164).slice(0, 8);

    // DLT route params. `variables_values` is the substitution for the approved
    // template's {#var#}. If the template carries multiple variables the order is
    // pipe-separated; today the OTP is a single variable. Tweak here when the
    // exact approved template/variable order is supplied.
    // Same parameter order as before #2787; a template with no variables sends none.
    const params = new URLSearchParams({
      route: this.config.FAST2SMS_ROUTE,
      sender_id: senderId,
      message: templateId,
      ...(input.variables.length > 0 ? { variables_values: input.variables.join("|") } : {}),
      numbers: number,
      flash: "0",
    });
    if (this.config.FAST2SMS_ENTITY_ID) {
      params.set("entity_id", this.config.FAST2SMS_ENTITY_ID);
    }

    let res: Response;
    try {
      res = await fetch(`${FAST2SMS_BULK_URL}?${params.toString()}`, {
        method: "POST",
        headers: {
          authorization: apiKey,
          "cache-control": "no-cache",
        },
      });
    } catch (err) {
      // Network/transport failure — never include the code or number. Typed
      // SmsSendError (F4): the auth flow emits worker.otp_send_failed from it.
      this.logger.error(
        `Fast2SMS request failed (transport) phone_hash=${phoneHashPrefix} reason=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new SmsSendError("transport", "SMS delivery failed (transport error)");
    }

    if (!res.ok) {
      this.logger.error(`Fast2SMS non-2xx phone_hash=${phoneHashPrefix} status=${res.status}`);
      throw new SmsSendError("http_error", `SMS delivery failed (HTTP ${res.status})`);
    }

    // Fast2SMS returns 200 with a JSON body even on logical failures; `return:false`
    // means it did NOT accept the message. An unparseable body is classified the same
    // way — the provider answered 200 but acceptance cannot be confirmed.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      this.logger.error(`Fast2SMS unparseable body phone_hash=${phoneHashPrefix}`);
      throw new SmsSendError("provider_rejected", "SMS delivery failed (bad provider response)");
    }
    if (
      typeof body === "object" &&
      body !== null &&
      "return" in body &&
      (body as { return: unknown }).return === false
    ) {
      this.logger.error(`Fast2SMS rejected phone_hash=${phoneHashPrefix} (return=false)`);
      throw new SmsSendError("provider_rejected", "SMS delivery failed (provider rejected)");
    }

    this.logger.log(`${label} sent phone_hash=${phoneHashPrefix} status=ok`);
  }

  /**
   * Reduce an E.164 phone to the 10-digit national number Fast2SMS expects:
   * strip a leading +91 / 91 country code and any non-digits.
   */
  static toNationalNumber(phoneE164: string): string {
    const digits = phoneE164.replace(/\D/g, "");
    if (digits.length > 10 && digits.startsWith("91")) {
      return digits.slice(digits.length - 10);
    }
    return digits.slice(-10);
  }
}

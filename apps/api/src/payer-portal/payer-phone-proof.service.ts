import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayerSmsSendCapExceededException } from "../common/otp-send-cap";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "../payers/payers.repository";
import {
  PayerPhoneProofsRepository,
  isPhoneProofTableMissing,
} from "../payers/payer-phone-proofs.repository";
import { PayerOtpService } from "../payers/payer-otp.service";
import { INDIAN_MOBILE_E164 } from "./payer-auth.service";
import {
  PHONE_PROOF_CONFLICT_REASONS,
  type PayerPhoneProofCodeResponse,
  type PayerPhoneProofStatusResponse,
  type PayerPhoneProofVerifiedResponse,
  type PhoneProofConflictReason,
} from "./payer-phone-proof.dto";

const UNAVAILABLE = "This is temporarily unavailable; please retry shortly";

/**
 * #2754 item 3 — a SIGNED-IN company proves the phone on its account, so that phone becomes a
 * sign-in credential for SMS codes (one account per proven phone, `payer_phone_proofs`).
 *
 *   status   — `{ proven }`: whether a proof names the account's CURRENT phone.
 *   request  — a code by SMS to the account's CURRENT stored phone, on the company template, under
 *              the SMS sign-in bounds (per-account cooldown, the per-number hourly cap shared with
 *              sign-in codes, the company-SMS daily ceiling; the controller adds the per-IP cap).
 *   verify   — the code (its own slot: never a sign-in code), then the proof row and
 *              `payer.phone_proven` in ONE transaction that re-checks the phone under the row lock.
 *
 * WHAT IT MAY SAY. Everything here is the caller's own account, so the answers are specific (no
 * neutral bodies): no phone, a phone SMS cannot prove, a phone that changed. "Linked to another
 * account" is said only on VERIFY, after the caller has proved they hold the phone — saying it on
 * the request would let any signed-in company type a number into `PATCH /payer/me` and learn
 * whether some other company has proven it.
 *
 * SWITCHED. All three routes 404 while `PAYER_SMS_OTP_ENABLED` is off (there is nothing to prove a
 * phone for). With the table missing (42P01, deploy ahead of the migration) the two POSTs answer 503
 * before any SMS goes out, and the status reads `{ proven: false }`. Logs and events carry ids and closed codes only — never the number or the code.
 */
@Injectable()
export class PayerPhoneProofService {
  private readonly logger = new Logger(PayerPhoneProofService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly payers: PayersRepository,
    private readonly proofs: PayerPhoneProofsRepository,
    private readonly otp: PayerOtpService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * `GET /payer/me/phone-proof` — is the account's CURRENT phone proven? Never a 503: a missing
   * table reads as `false` (the repository), so the screen just offers to prove the phone.
   */
  async proofStatus(payerId: string): Promise<PayerPhoneProofStatusResponse> {
    this.assertEnabled();
    return { proven: await this.proofs.isCurrentPhoneProven(payerId) };
  }

  /** `POST /payer/me/phone-proof` — send a proof code to the account's current phone. */
  async requestProof(payerId: string, ctx: RequestContext): Promise<PayerPhoneProofCodeResponse> {
    this.assertEnabled();
    const { phoneHash, phone } = await this.currentPhone(payerId);
    if (!INDIAN_MOBILE_E164.test(phone)) {
      // The SMS path's own rule (#2754 security review): Fast2SMS delivers to the last ten digits,
      // so a foreign number cannot be proven by it.
      throw PayerPhoneProofService.conflict(
        PHONE_PROOF_CONFLICT_REASONS.notProvable,
        "Only an Indian mobile number (+91) can be confirmed by SMS. Change the number first.",
      );
    }
    // Before any SMS: a code whose proof could not be stored is a wasted send.
    await this.failClosedOnMissingTable(payerId, "request", () =>
      this.proofs.assertTablePresent(payerId),
    );
    try {
      const issued = await this.otp.issuePhoneProof({ payerId, phoneHash, phone });
      return { status: "code_sent", resend_in_seconds: issued.resendInSeconds };
    } catch (err) {
      if (err instanceof PayerSmsSendCapExceededException) {
        // The company-SMS ceiling counts proof codes too: the same breach event as sign-in, then
        // the same 429 (signed in, so no neutral body is owed).
        await this.events.emit({
          event_name: "payer.sms_send_cap_exceeded",
          actor: { actor_type: "system" },
          subject: { subject_type: "payer" },
          payload: { cap: "global_daily", limit: err.breach.limit, window: err.breach.window },
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
      }
      throw err;
    }
  }

  /**
   * `POST /payer/me/phone-proof/verify` — check the code, then record the proof.
   *
   * 401 wrong / expired code (one message), 429 too many attempts, 409 `phone_changed` (the phone
   * moved since the code was sent), 409 `phone_linked_to_another_account` (the unique index
   * refused: another company holds this phone's proof — contact support), 503 Redis or the table.
   */
  async verifyProof(
    payerId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<PayerPhoneProofVerifiedResponse> {
    this.assertEnabled();
    const { phoneHash } = await this.currentPhone(payerId);
    // The code is bound to (account, phone hash): a sign-in code, another account's proof code or
    // a code sent to a number this account has since left all answer the same 401.
    await this.otp.verifyPhoneProof({ payerId, phoneHash, code });

    const outcome = await this.failClosedOnMissingTable(payerId, "verify", () =>
      this.proofs.recordSmsProof(payerId, phoneHash, async (tx: Database) => {
        await this.events.emit({
          event_name: "payer.phone_proven",
          actor: { actor_type: "payer", actor_id: payerId },
          subject: { subject_type: "payer", subject_id: payerId },
          payload: { payer_id: payerId, method: "sms_code" },
          tx,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
      }),
    );
    if (outcome === "held_elsewhere") {
      this.logger.warn(
        `payer phone proof refused: another account holds the proof payer=${payerId.slice(0, 8)}…`,
      );
      throw PayerPhoneProofService.conflict(
        PHONE_PROOF_CONFLICT_REASONS.heldElsewhere,
        "This phone number is linked to another BadaBhai account. Contact BadaBhai support to " +
          "move it to this account.",
      );
    }
    if (outcome === "phone_changed") {
      throw PayerPhoneProofService.conflict(
        PHONE_PROOF_CONFLICT_REASONS.phoneChanged,
        "The phone number on your account changed. Request a new code.",
      );
    }
    this.logger.log(`payer phone proven payer=${payerId.slice(0, 8)}… method=sms_code`);
    return { status: "proven" };
  }

  // ---------------------------------------------------------------------------

  /** Nothing to prove a phone FOR while company SMS sign-in is off: the routes do not exist. */
  private assertEnabled(): void {
    if (!this.config.PAYER_SMS_OTP_ENABLED) throw new NotFoundException("Not found");
  }

  /** The account's stored phone and its keyed hash; 409 `no_phone_on_account` when it has none. */
  private async currentPhone(payerId: string): Promise<{ phoneHash: string; phone: string }> {
    const row = await this.payers.findById(payerId);
    // A valid session whose payer row is gone → the neutral not-found `GET /payer/me` answers.
    if (!row) throw new NotFoundException("Payer account not found");
    if (row.phoneHash === null || row.phoneEnc === null) {
      throw PayerPhoneProofService.conflict(
        PHONE_PROOF_CONFLICT_REASONS.noPhone,
        "There is no phone number on this account. Add one first.",
      );
    }
    let phone: string;
    try {
      phone = this.pii.decrypt(row.phoneEnc);
    } catch {
      // Fail closed, generic: ciphertext and crypto internals are never surfaced.
      throw new InternalServerErrorException("Could not load account");
    }
    return { phoneHash: row.phoneHash, phone };
  }

  /** Run `work`; a missing proof table (42P01) is a 503, logged with the code, never a 500. */
  private async failClosedOnMissingTable<T>(
    payerId: string,
    op: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!isPhoneProofTableMissing(err)) throw err;
      this.logger.warn(
        `payer phone proof ${op} unavailable payer=${payerId.slice(0, 8)}… sqlstate=42P01 ` +
          "(payer_phone_proofs not migrated yet)",
      );
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
  }

  /** The house 409 body: `statusCode` / `error` / `message`, plus the machine-readable `reason`. */
  private static conflict(reason: PhoneProofConflictReason, message: string): ConflictException {
    return new ConflictException({ statusCode: 409, error: "Conflict", message, reason });
  }
}

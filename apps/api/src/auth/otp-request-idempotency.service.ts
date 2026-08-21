import { Injectable } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";

/**
 * Makes an OTP-send route idempotent under a client-supplied `Idempotency-Key` (#1019).
 *
 * THE BUG THIS EXISTS FOR. The worker app retries an idempotent write up to three times on a
 * TRANSPORT failure, reusing ONE key across all attempts (`AuthedClient`, ladder measured in
 * #999: t=0, t≈15.3s, t≈30.9s). `/auth/token/refresh` honoured that header; `/auth/otp/request`
 * did not. Our audience is on flaky links and a real Fast2SMS send can outlive the client's 15s
 * timeout, so the ordinary case was: server sends, response is lost, client retries with the
 * same key, server treats it as a brand-new request. One tap fanned out to as many as three
 * counted sends and three paid SMS, against FOUR separate counters — per-phone hourly (5),
 * per-phone daily (10), per-IP hourly, and the platform-wide daily breaker (2000).
 *
 * That is why the report was "429 after about two uses, on every number and every device": two
 * taps could exhaust a per-phone hourly cap of five, and the same amplification burned the
 * global breaker — which, once tripped, 429s EVERY worker on EVERY device until UTC midnight.
 *
 * NOW A THIN WRAPPER over {@link RequestIdempotency} (#1046). The reserve-run-store-replay
 * algorithm was never OTP-specific — it is the answer to "a POST whose response was lost" on any
 * route — and `POST /payer/credits` needed exactly the same thing to stop double-granting a
 * credit pack. Rather than copy logic whose correctness lives in the ORDER of four steps, the
 * core moved to `common/idempotency` and this class kept the OTP-specific policy: the phone is
 * the subject and must be hashed, and the key family stays `otp_idem`.
 *
 * THE STORED KEY IS BYTE-IDENTICAL to what this class wrote before the extraction —
 * `otp_idem:<scope>:<phoneHash>:<keyHash>` — so in-flight dedupe windows keep working across the
 * deploy that ships it, rather than every caller silently getting a fresh window mid-retry.
 *
 * PRIVACY (§2). The key namespace carries `hashPhone(phone)`, never the number itself — the same
 * rule `OtpService` follows for every one of its keys.
 *
 * SCOPED PER ROUTE AND PER PHONE, so a key captured from one flow cannot replay into another,
 * and login and PIN-reset never collide on a client that happens to reuse a UUID across them.
 */
@Injectable()
export class OtpRequestIdempotency {
  /**
   * Re-exported so existing callers and tests keep one name for the window. The value lives on
   * {@link RequestIdempotency}; duplicating the number here would let the two drift.
   */
  static readonly WINDOW_SECONDS = RequestIdempotency.WINDOW_SECONDS;

  constructor(
    private readonly pii: PiiCryptoService,
    private readonly idempotency: RequestIdempotency,
  ) {}

  /**
   * Run `work` at most once per `(scope, phone, idempotencyKey)`.
   *
   * With NO key the work runs unguarded, which is deliberate: the header is OPTIONAL on these
   * routes. `/auth/token/refresh` can demand it because the credential is in the body and every
   * caller is our own client; `/auth/otp/request` is the front door, and 400-ing a caller that
   * omits a header it was never asked for would be a breaking API change (§3) to fix a bug that
   * only affects callers who DO send one.
   *
   * `inFlight` supplies what a duplicate gets while the first attempt is still running — the
   * case the whole bug is made of, since the client's 15s timeout is shorter than a slow
   * Fast2SMS send. Answering it optimistically is correct HERE: either the in-flight attempt
   * lands and the worker has their code, or it does not and the cooldown lets them ask again.
   * (A financial route cannot answer optimistically — see `RunOnceOptions.inFlight`.)
   */
  async runOnce<T>(opts: {
    readonly scope: string;
    readonly phoneE164: string;
    readonly idempotencyKey?: string;
    readonly work: () => Promise<T>;
    readonly inFlight: () => T;
    /**
     * Encrypt the stored outcome at rest. Set it on any route whose response carries a
     * credential. Off by default so the send routes are unchanged, and so adding a route that
     * DOES carry one is a deliberate decision rather than an omission.
     */
    readonly secret?: boolean;
  }): Promise<T> {
    return this.idempotency.runOnce({
      namespace: "otp_idem",
      scope: opts.scope,
      // THE ONLY OTP-SPECIFIC LINE THAT MATTERS. The subject is a phone number, so it is hashed
      // before it can reach a Redis key; the generic seam does not hash, because a caller
      // passing an internal uuid must not have it double-hashed.
      subject: this.pii.hashPhone(opts.phoneE164),
      subjectLabel: "phone_hash",
      logLabel: "OTP",
      ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
      ...(opts.secret === undefined ? {} : { secret: opts.secret }),
      work: opts.work,
      inFlight: opts.inFlight,
    });
  }
}

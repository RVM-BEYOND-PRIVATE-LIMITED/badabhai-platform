import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { type ServerConfig, getRazorpayCredentials } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RAZORPAY_SIGNATURE_HEADER, verifyWebhookSignature } from "./razorpay-signature";
import type { RawBodyRequest } from "./razorpay-raw-body.middleware";

/**
 * The ONLY authentication on the public Razorpay webhook route.
 *
 * `POST /payments/razorpay/webhook` has no session, no bearer, and no IP allow-list —
 * Razorpay's servers call it from addresses we do not control. The HMAC signature over the
 * raw request bytes IS the credential, so this guard is the entire boundary between a
 * stranger's HTTP request and a credit grant. It is a guard (not an in-controller check)
 * so the protection is visible in the repo's authz contract test and cannot be lost in a
 * controller refactor.
 *
 * FAIL CLOSED, in this order:
 *  1. Real payments not fully configured ⇒ DENY. With the flag off there is no webhook
 *     secret, so nothing can be verified and nothing may be granted.
 *  2. No raw body captured (the middleware did not run, or something consumed the stream)
 *     ⇒ DENY. We refuse rather than fall back to re-serializing the parsed body, which
 *     would not be the bytes Razorpay signed.
 *  3. Missing / malformed / wrong signature ⇒ DENY.
 *
 * THE DENIAL IS UNIFORM AND DETAIL-FREE. Every failure above throws the identical
 * `UnauthorizedException` with one generic message: an attacker probing the endpoint
 * cannot tell "wrong secret" from "no raw body" from "payments disabled", so the response
 * is not an oracle for our configuration state.
 *
 * NOTHING IS LOGGED HERE. The body, the signature, and the header set are all withheld
 * from logs: the payload can carry provider-side buyer contact/card metadata (CLAUDE.md §2
 * #2), and an unauthenticated caller must never be able to write attacker-chosen content
 * into our log sink.
 */
@Injectable()
export class RazorpayWebhookGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const creds = getRazorpayCredentials(this.config);
    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    const signature = req.headers[RAZORPAY_SIGNATURE_HEADER];

    // `verifyWebhookSignature` is itself fail-closed on every one of these inputs; the
    // explicit null-credential check keeps the intent obvious at the call site.
    if (!creds || !verifyWebhookSignature(req.rawBody, signature, creds.webhookSecret)) {
      throw new UnauthorizedException("invalid signature");
    }
    return true;
  }
}

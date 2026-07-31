import { Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { UnlockService } from "./unlocks.service";
import { RazorpayWebhookGuard } from "./razorpay-webhook.guard";
import { RazorpayWebhookSchema, toPaymentEvent } from "./razorpay-webhook.dto";
import type { RawBodyRequest } from "./razorpay-raw-body.middleware";

/**
 * `POST /payments/razorpay/webhook` — the SOURCE OF TRUTH for real credit-pack captures.
 *
 * PUBLIC ROUTE. Razorpay calls it from servers we do not control, so it carries no session
 * and no bearer token. Its only credential is the HMAC signature over the raw request
 * bytes, enforced by {@link RazorpayWebhookGuard} before this controller runs.
 *
 * ALWAYS 200 FOR ANYTHING WE CAN RESOLVE. Razorpay retries non-2xx deliveries for hours, so
 * the status code is a control signal, not decoration:
 *  - handled, duplicate, replayed, unknown event type, unknown order, malformed body → 200
 *    (stop retrying; a replay must be a no-op, never a second grant and never a 500);
 *  - an INFRASTRUCTURE failure (DB down, the ledger's unique index firing) throws and
 *    surfaces as a 5xx, so Razorpay redelivers and the capture is never dropped. A
 *    redelivery once the problem clears finds the order already `paid` and no-ops.
 *
 * NOTHING FROM THE PAYLOAD IS LOGGED OR RETURNED. Razorpay's payment entity carries buyer
 * email / contact / card metadata; none of it is parsed into our DTO, none reaches a log,
 * and the response body is a fixed `{ received: true }` that reveals nothing about whether
 * the order existed, was already settled, or belongs to anyone.
 */
@Controller("payments/razorpay")
export class RazorpayWebhookController {
  constructor(private readonly unlocks: UnlockService) {}

  @Post("webhook")
  @UseGuards(RazorpayWebhookGuard)
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest,
    @Ctx() ctx: RequestContext,
  ): Promise<{ received: true }> {
    // The raw bytes were parsed by the raw-body middleware; validate the SHAPE here
    // (invariant #7). A body that does not match is treated as an unknown delivery and
    // no-ops at 200 rather than 400 — a shape we do not recognise is not worth a retry.
    const parsed = RazorpayWebhookSchema.safeParse(req.body);
    if (!parsed.success) return { received: true };

    // Every BUSINESS outcome (granted / failure recorded / duplicate / unknown order /
    // unknown event) is a 200. An INFRASTRUCTURE failure deliberately propagates: it throws
    // out of here, the global exceptions filter answers 5xx, and Razorpay redelivers. There
    // is no try/catch, because swallowing a DB failure into a 200 would tell Razorpay we
    // handled a capture we did not.
    await this.unlocks.handleRazorpayEvent(toPaymentEvent(parsed.data), ctx);
    return { received: true };
  }
}

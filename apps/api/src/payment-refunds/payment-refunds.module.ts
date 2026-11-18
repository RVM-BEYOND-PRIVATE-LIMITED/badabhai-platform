import { Module } from "@nestjs/common";
import { CreditRulesModule } from "../credit-rules/credit-rules.module";
import { RazorpayClient } from "../unlocks/razorpay.client";
import { CREDIT_NOTE_ISSUER, NoCreditNotes } from "./credit-note-issuer";
import { PaymentRefundsRepository } from "./payment-refunds.repository";
import { PaymentRefundsService } from "./payment-refunds.service";

/**
 * #2750 item 10 — admin refunds of real paid packs. The admin routes are AdminModule's
 * (`AdminPaymentRefundsController`) and the refund webhooks reach the service through the Razorpay
 * webhook controller (UnlocksModule), both through the exported service.
 *
 * RazorpayClient is provided here as well as in UnlocksModule: it is a stateless seam over the SDK
 * (credentials from config, the SDK built lazily), and providing it here keeps this module free of
 * any dependency on UnlocksModule, which imports this one. The credit-note issuer is
 * {@link NoCreditNotes} until #2749's invoices bind a real one (refunds stay off until then).
 * DATABASE, SERVER_CONFIG and EventsService come from global modules.
 */
@Module({
  imports: [CreditRulesModule],
  providers: [
    PaymentRefundsRepository,
    PaymentRefundsService,
    RazorpayClient,
    { provide: CREDIT_NOTE_ISSUER, useClass: NoCreditNotes },
  ],
  exports: [PaymentRefundsService],
})
export class PaymentRefundsModule {}

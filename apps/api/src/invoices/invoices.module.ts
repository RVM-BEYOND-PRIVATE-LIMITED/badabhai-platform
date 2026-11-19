import { Module } from "@nestjs/common";
import { PayersModule } from "../payers/payers.module";
import { StorageModule } from "../storage/storage.module";
import { InvoiceCreditNotes } from "./invoice-credit-notes.service";
import { InvoiceDocumentsService } from "./invoice-documents.service";
import { InvoiceIssuer } from "./invoice-issuer.service";
import { InvoicesRepository } from "./invoices.repository";
import { InvoicesService } from "./invoices.service";
import { PayerInvoicesController } from "./payer-invoices.controller";

/**
 * #2749 part 4 — GST invoices and credit notes (migration 0188).
 *
 *  - {@link InvoiceIssuer}: the invoice in the settle's transaction (UnlocksModule's settle hook).
 *  - {@link InvoiceCreditNotes}: the credit note in the refund's transaction, bound to
 *    `CREDIT_NOTE_ISSUER` by PaymentRefundsModule.
 *  - {@link InvoicesService}: billing details, the invoice list, the downloads and the real
 *    checkout's invoice gate (PayerPortalModule's `POST /payer/credits/order`).
 *  - {@link InvoiceDocumentsService}: the PDF (WeasyPrint) in the private `INVOICES_BUCKET`.
 *
 * Imports PayersModule (PayerAuthGuard and the tenant resolver) and StorageModule. PdfRenderer
 * (PdfModule), PiiCryptoService, EventsService, DATABASE and SERVER_CONFIG are @Global. It imports
 * nothing that imports it back (UnlocksModule, PaymentRefundsModule and PayerPortalModule import
 * this one), so no cycle.
 */
@Module({
  imports: [PayersModule, StorageModule],
  controllers: [PayerInvoicesController],
  providers: [
    InvoicesRepository,
    InvoiceIssuer,
    InvoiceCreditNotes,
    InvoiceDocumentsService,
    InvoicesService,
  ],
  exports: [InvoiceIssuer, InvoiceCreditNotes, InvoicesService, InvoiceDocumentsService],
})
export class InvoicesModule {}

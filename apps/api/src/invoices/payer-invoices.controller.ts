import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import { CurrentPayer, PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PutBillingDetailsSchema, type PutBillingDetailsDto } from "./invoices.dto";
import { InvoicesService } from "./invoices.service";

/**
 * The company's GST invoices and billing details (#2749 part 4). HTTP only.
 *
 * `PayerAuthGuard` ONLY, exactly like the credit-purchase routes (owner ruling 2026-10-07: any
 * authenticated payer may buy credits, whatever its org role), so whoever may buy may save the
 * billing details a purchase needs and read the invoices it produced. The payer is the SESSION
 * payer; the service resolves the tenant key (a team shares one set of details and one list).
 * Another company's invoice or credit note id is the same neutral 404 as an unknown one.
 *
 * `no-store` on every route: they return a company's GSTIN and address, or a signed link to a tax
 * document. The signed URL is never logged or emitted.
 */
@Controller("payer")
@UseGuards(PayerAuthGuard)
export class PayerInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  /** `{ saved, state_code, gstin, legal_name, address }` — nulls when nothing is saved. */
  @Get("billing-details")
  @Header("Cache-Control", "no-store")
  getBillingDetails(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.invoices.getBillingDetails(payer.id);
  }

  /** Save (replace) the company's billing details. Writes `payer.billing_details_updated`. */
  @Put("billing-details")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  putBillingDetails(
    @Body(new ZodValidationPipe(PutBillingDetailsSchema)) dto: PutBillingDetailsDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    return this.invoices.putBillingDetails(payer.id, dto, ctx);
  }

  /** The company's invoices, newest first, each with its credit note (or null). */
  @Get("invoices")
  @Header("Cache-Control", "no-store")
  listInvoices(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.invoices.listInvoices(payer.id);
  }

  /** `{ url, expires_in_seconds }`. 404 neutral; 503 `INVOICE_PDF_UNAVAILABLE`. */
  @Get("invoices/:invoiceId/download")
  @Header("Cache-Control", "no-store")
  downloadInvoice(
    @Param("invoiceId", new ParseUUIDPipe()) invoiceId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    return this.invoices.downloadInvoice(payer.id, invoiceId);
  }

  /** `{ url, expires_in_seconds }`. 404 neutral; 503 `INVOICE_PDF_UNAVAILABLE`. */
  @Get("credit-notes/:creditNoteId/download")
  @Header("Cache-Control", "no-store")
  downloadCreditNote(
    @Param("creditNoteId", new ParseUUIDPipe()) creditNoteId: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ) {
    return this.invoices.downloadCreditNote(payer.id, creditNoteId);
  }
}

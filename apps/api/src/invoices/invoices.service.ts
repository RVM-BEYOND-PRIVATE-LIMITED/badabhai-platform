import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerBillingDetailsRow } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { usableSeller } from "./invoice-issuer.service";
import { isInvoiceTestMode } from "./test-mode";
import { sqlStateOf } from "../common/db-error";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { invoicesUnavailable } from "./invoice-credit-notes.service";
import { InvoiceDocumentsService, type SignedDocument } from "./invoice-documents.service";
import type { BillingDetailsView, InvoiceListItem, PutBillingDetailsDto } from "./invoices.dto";
import { InvoicesRepository } from "./invoices.repository";

const UNDEFINED_TABLE = "42P01";

const NOT_SAVED: BillingDetailsView = Object.freeze({
  saved: false,
  state_code: null,
  gstin: null,
  legal_name: null,
  address: null,
});

/**
 * The company side of GST invoices (#2749 part 4): billing details saved once per company and
 * reused (owner ruling 2026-11-18), the invoice list, the two downloads, and the real-checkout
 * gate.
 *
 * TENANCY. Every read and write is keyed by the TENANT KEY the session payer resolves to
 * (`PayerTenantScopeService`, ADR-0053), never a body or path value: a team shares one set of
 * billing details and one invoice list, as it shares one wallet. Another tenant's invoice id is
 * the same neutral 404 as an unknown one.
 *
 * PRIVACY. The GSTIN, legal name and address are encrypted at rest (the `payers.org_name_enc` key)
 * and decrypted only to answer the company that saved them and to print its invoices. They never
 * reach a log or an event; `payer.billing_details_updated` carries the state and `has_gstin`.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly repo: InvoicesRepository,
    private readonly tenancy: PayerTenantScopeService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    private readonly documents: InvoiceDocumentsService,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "PAYMENTS_PROVIDER_KEY">,
  ) {}

  /** `GET /payer/billing-details`. */
  async getBillingDetails(payerId: string): Promise<BillingDetailsView> {
    const scope = await this.tenancy.resolve(payerId);
    const row = await this.repo.billingDetails(scope.tenantKey);
    return row ? this.toView(row) : NOT_SAVED;
  }

  /**
   * `PUT /payer/billing-details`: save (replace) the company's details and record
   * `payer.billing_details_updated` in the same transaction. Returns what was saved.
   */
  async putBillingDetails(
    payerId: string,
    dto: PutBillingDetailsDto,
    ctx: RequestContext,
  ): Promise<BillingDetailsView> {
    const scope = await this.tenancy.resolve(payerId);
    const enc = (v: string | null | undefined): string | null =>
      v === null || v === undefined ? null : this.pii.encrypt(v);
    const gstin = dto.gstin ?? null;
    const row = await this.repo.withTransaction(async (tx) => {
      const saved = await this.repo.upsertBillingDetails(tx, {
        payerId: scope.tenantKey,
        stateCode: dto.state_code,
        gstinEnc: enc(gstin),
        legalNameEnc: enc(dto.legal_name),
        addressEnc: enc(dto.address),
        updatedBy: scope.actorPayerId,
      });
      await this.events.emit({
        event_name: "payer.billing_details_updated",
        actor: { actor_type: "payer", actor_id: scope.actorPayerId },
        subject: { subject_type: "payer", subject_id: scope.tenantKey },
        payload: {
          payer_id: scope.tenantKey,
          state_code: dto.state_code,
          has_gstin: gstin !== null,
        },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tx,
      });
      return saved;
    });
    return this.toView(row);
  }

  /** `GET /payer/invoices`: the company's invoices, newest first, each with its credit note. */
  async listInvoices(payerId: string): Promise<{ invoices: InvoiceListItem[] }> {
    const scope = await this.tenancy.resolve(payerId);
    const rows = await this.repo.listForPayer(scope.tenantKey);
    return {
      invoices: rows.map(({ invoice, creditNote }) => ({
        id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        issued_at: invoice.issuedAt.toISOString(),
        description: invoice.description,
        supply_type: invoice.supplyType,
        taxable_paise: invoice.taxablePaise,
        cgst_paise: invoice.cgstPaise,
        sgst_paise: invoice.sgstPaise,
        igst_paise: invoice.igstPaise,
        total_paise: invoice.totalPaise,
        credit_note:
          creditNote === null
            ? null
            : {
                id: creditNote.id,
                credit_note_number: creditNote.creditNoteNumber,
                issued_at: creditNote.issuedAt.toISOString(),
                total_paise: creditNote.totalPaise,
              },
      })),
    };
  }

  /** `GET /payer/invoices/:id/download`: a short-lived link. 404 neutral; 503 typed. */
  async downloadInvoice(payerId: string, invoiceId: string): Promise<SignedDocument> {
    const scope = await this.tenancy.resolve(payerId);
    const invoice = await this.repo.findInvoiceForPayer(invoiceId, scope.tenantKey);
    if (!invoice) throw new NotFoundException();
    return this.documents.signInvoice(invoice);
  }

  /** `GET /payer/credit-notes/:id/download`: the same, for a credit note. */
  async downloadCreditNote(payerId: string, creditNoteId: string): Promise<SignedDocument> {
    const scope = await this.tenancy.resolve(payerId);
    const found = await this.repo.findCreditNoteForPayer(creditNoteId, scope.tenantKey);
    if (!found) throw new NotFoundException();
    return this.documents.signCreditNote(found.creditNote, found.invoice);
  }

  /**
   * The real checkout's invoice gate (`POST /payer/credits/order`, only once the route is open
   * for the company): every payment needs a GST invoice, so a new order is refused —
   *  - 503 `INVOICES_UNAVAILABLE` while there is no usable seller row (none, or its GSTIN fails the
   *    check character), or the tables are missing: fails closed, no order and no money;
   *  - 409 `BILLING_DETAILS_REQUIRED` while the company has not saved its billing details.
   * The mock route (`POST /payer/credits`) is not gated: it takes no money and issues nothing.
   * Neither is TEST MODE (a `rzp_test_` key id, the runbook's rehearsal): a test payment moves no
   * money and gets no invoice, so it needs no seller row and no billing details.
   */
  async assertCheckoutInvoiceable(payerId: string): Promise<void> {
    if (isInvoiceTestMode(this.config)) return;
    const scope = await this.tenancy.resolve(payerId);
    try {
      if (!usableSeller(await this.repo.activeSeller()).ok) throw invoicesUnavailable();
      if (!(await this.repo.billingDetails(scope.tenantKey))) {
        throw new ConflictException({
          code: "BILLING_DETAILS_REQUIRED",
          message: "Save your company's billing details before buying credits",
        });
      }
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.error("invoice tables are missing (migration not applied); real checkout refused");
        throw invoicesUnavailable();
      }
      throw err;
    }
  }

  private toView(row: PayerBillingDetailsRow): BillingDetailsView {
    const dec = (v: string | null): string | null => (v === null ? null : this.pii.decrypt(v));
    return {
      saved: true,
      state_code: row.stateCode,
      gstin: dec(row.gstinEnc),
      legal_name: dec(row.legalNameEnc),
      address: dec(row.addressEnc),
    };
  }
}

import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { CreditNoteRow, InvoiceRow } from "@badabhai/db";
import { PdfRenderer } from "../common/pdf/pdf-renderer.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { SERVER_CONFIG } from "../config/config.module";
import { StorageService } from "../storage/storage.service";
import { buildTaxDocumentHtml, type TaxDocumentView } from "./invoice-html";
import { InvoicesRepository } from "./invoices.repository";

/** A short-lived link to a stored tax document. The URL is never logged or emitted. */
export interface SignedDocument {
  readonly url: string;
  readonly expires_in_seconds: number;
}

/** The opaque object keys: the financial year and our row id, nothing else. */
export function invoiceObjectKey(invoice: Pick<InvoiceRow, "financialYear" | "id">): string {
  return `invoices/${invoice.financialYear}/${invoice.id}.pdf`;
}

export function creditNoteObjectKey(note: Pick<CreditNoteRow, "financialYear" | "id">): string {
  return `credit-notes/${note.financialYear}/${note.id}.pdf`;
}

/** 503 with a typed code: the PDF cannot be produced or served right now. */
function pdfUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "INVOICE_PDF_UNAVAILABLE",
    message: "The document cannot be produced right now; please try again later",
  });
}

/**
 * Renders, stores and signs GST invoice and credit-note PDFs (#2749 part 4). WeasyPrint through
 * the shared {@link PdfRenderer} (null when degraded), the private `INVOICES_BUCKET` through
 * {@link StorageService}. A document is rendered once: after the settle commits (best effort) or on
 * its first download, then stored; every later download signs the stored object.
 *
 * The buyer's details are decrypted only here, only to print them. Logs carry ids and error
 * classes, never a value, the HTML or a URL.
 */
@Injectable()
export class InvoiceDocumentsService {
  private readonly logger = new Logger(InvoiceDocumentsService.name);

  constructor(
    private readonly repo: InvoicesRepository,
    private readonly pdf: PdfRenderer,
    private readonly storage: StorageService,
    private readonly pii: PiiCryptoService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * After a settle committed: render and store the invoice's PDF. BEST EFFORT — never throws and is
   * not awaited by the settle: a failure leaves `pdf_storage_key` null and the first download
   * renders it.
   */
  renderInvoiceInBackground(invoiceId: string): void {
    void (async () => {
      try {
        const invoice = await this.repo.findInvoice(invoiceId);
        if (!invoice || invoice.pdfStorageKey !== null) return;
        await this.storeInvoice(invoice);
      } catch (err) {
        this.logger.warn(
          `invoice PDF not rendered after settle invoice=${invoiceId} (${errorClass(err)}); the first download renders it`,
        );
      }
    })();
  }

  /** A signed link to the invoice's PDF, rendering and storing it first when needed. 503 typed. */
  async signInvoice(invoice: InvoiceRow): Promise<SignedDocument> {
    try {
      const key = invoice.pdfStorageKey ?? (await this.storeInvoice(invoice));
      if (key === null) throw pdfUnavailable();
      return await this.sign(key);
    } catch (err) {
      if (err instanceof ServiceUnavailableException && isTyped(err)) throw err;
      this.logger.warn(`invoice PDF unavailable invoice=${invoice.id} (${errorClass(err)})`);
      throw pdfUnavailable();
    }
  }

  /** A signed link to the credit note's PDF, rendering and storing it first when needed. */
  async signCreditNote(note: CreditNoteRow, invoice: InvoiceRow): Promise<SignedDocument> {
    try {
      const key = note.pdfStorageKey ?? (await this.storeCreditNote(note, invoice));
      if (key === null) throw pdfUnavailable();
      return await this.sign(key);
    } catch (err) {
      if (err instanceof ServiceUnavailableException && isTyped(err)) throw err;
      this.logger.warn(`credit note PDF unavailable credit_note=${note.id} (${errorClass(err)})`);
      throw pdfUnavailable();
    }
  }

  /** Render + upload + record. Null when the renderer is degraded (no PDF this run). */
  private async storeInvoice(invoice: InvoiceRow): Promise<string | null> {
    const bytes = await this.pdf.renderHtmlToPdf(
      buildTaxDocumentHtml(this.view(invoice, null)),
      "invoice",
    );
    if (bytes === null) return null;
    const key = invoiceObjectKey(invoice);
    await this.storage.uploadPdf(key, bytes, this.config.INVOICES_BUCKET);
    await this.repo.markInvoicePdf(invoice.id, key);
    return key;
  }

  private async storeCreditNote(note: CreditNoteRow, invoice: InvoiceRow): Promise<string | null> {
    const bytes = await this.pdf.renderHtmlToPdf(
      buildTaxDocumentHtml(this.view(invoice, note)),
      "credit-note",
    );
    if (bytes === null) return null;
    const key = creditNoteObjectKey(note);
    await this.storage.uploadPdf(key, bytes, this.config.INVOICES_BUCKET);
    await this.repo.markCreditNotePdf(note.id, key);
    return key;
  }

  private async sign(key: string): Promise<SignedDocument> {
    const ttl = this.config.INVOICE_SIGNED_URL_TTL_SECONDS;
    const url = await this.storage.createSignedUrl(key, ttl, this.config.INVOICES_BUCKET);
    return { url, expires_in_seconds: ttl };
  }

  /** The template's view of an invoice, or of a credit note against it. Decrypts the buyer. */
  view(invoice: InvoiceRow, note: CreditNoteRow | null): TaxDocumentView {
    const dec = (token: string | null): string | null => (token === null ? null : this.pii.decrypt(token));
    const amounts = note ?? invoice;
    return {
      kind: note === null ? "invoice" : "credit_note",
      number: note === null ? invoice.invoiceNumber : note.creditNoteNumber,
      issuedAt: note === null ? invoice.issuedAt : note.issuedAt,
      originalInvoice:
        note === null ? null : { number: invoice.invoiceNumber, issuedAt: invoice.issuedAt },
      seller: {
        legalName: invoice.sellerLegalName,
        address: invoice.sellerAddress,
        gstin: invoice.sellerGstin,
        pan: invoice.sellerPan,
        stateCode: invoice.sellerStateCode,
      },
      buyer: {
        legalName: dec(invoice.buyerLegalNameEnc),
        address: dec(invoice.buyerAddressEnc),
        gstin: dec(invoice.buyerGstinEnc),
        stateCode: invoice.buyerStateCode,
      },
      sacCode: invoice.sacCode,
      description: invoice.description,
      supplyType: invoice.supplyType,
      gstRateBps: invoice.gstRateBps,
      taxablePaise: amounts.taxablePaise,
      cgstPaise: amounts.cgstPaise,
      sgstPaise: amounts.sgstPaise,
      igstPaise: amounts.igstPaise,
      totalPaise: amounts.totalPaise,
    };
  }
}

function isTyped(err: ServiceUnavailableException): boolean {
  const body = err.getResponse();
  return typeof body === "object" && body !== null && "code" in body;
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}

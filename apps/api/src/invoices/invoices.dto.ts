import { z } from "zod";
import {
  gstinStateCode,
  isGstStateCode,
  isValidGstin,
  normalizeGstinInput,
} from "@badabhai/pricing";

/** A company's legal name, as printed on its invoices. */
const LEGAL_NAME_MAX = 200;
/** A billing address, as printed (line breaks kept). */
const ADDRESS_MAX = 500;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .nullable()
    .optional();

/**
 * `PUT /payer/billing-details` (#2749 part 4). STRICT: no other key. A full replace: a field left
 * out (or null) is cleared.
 *
 *  - `state_code`: a GST state / UT code from the GSTN list (`GST_STATES`), required — it is the
 *    place of supply on every invoice.
 *  - `gstin`: optional. Normalised (upper-case, spaces removed); the 15-character shape AND its
 *    check character; its first two digits must be `state_code`.
 *  - `legal_name` and `address`: required with a GSTIN (a registered buyer's invoice names them),
 *    optional without.
 *
 * Error messages name the field, never echo the value.
 */
export const PutBillingDetailsSchema = z
  .object({
    state_code: z
      .string()
      .refine((v) => isGstStateCode(v), { message: "Not a GST state code" }),
    gstin: z
      .string()
      .transform(normalizeGstinInput)
      .refine((v) => isValidGstin(v), { message: "Not a valid GSTIN" })
      .nullable()
      .optional(),
    legal_name: optionalText(LEGAL_NAME_MAX),
    address: optionalText(ADDRESS_MAX),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.gstin === null || body.gstin === undefined) return;
    if (gstinStateCode(body.gstin) !== body.state_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gstin"],
        message: "The GSTIN's first two digits must be the state code",
      });
    }
    if (!body.legal_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legal_name"],
        message: "A legal name is required with a GSTIN",
      });
    }
    if (!body.address) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: "An address is required with a GSTIN",
      });
    }
  });
export type PutBillingDetailsDto = z.infer<typeof PutBillingDetailsSchema>;

/** `GET` / `PUT /payer/billing-details`. All nulls when nothing is saved. */
export interface BillingDetailsView {
  readonly saved: boolean;
  readonly state_code: string | null;
  readonly gstin: string | null;
  readonly legal_name: string | null;
  readonly address: string | null;
}

/** One invoice in `GET /payer/invoices`. */
export interface InvoiceListItem {
  readonly id: string;
  readonly invoice_number: string;
  readonly issued_at: string;
  readonly description: string;
  readonly supply_type: "intra" | "inter";
  readonly taxable_paise: number;
  readonly cgst_paise: number;
  readonly sgst_paise: number;
  readonly igst_paise: number;
  readonly total_paise: number;
  readonly credit_note: {
    readonly id: string;
    readonly credit_note_number: string;
    readonly issued_at: string;
    readonly total_paise: number;
  } | null;
}

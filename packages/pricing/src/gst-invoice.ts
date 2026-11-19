/**
 * The pure arithmetic behind a GST invoice and credit note (#2749 part 4, owner rulings
 * 2026-11-18). No I/O, no clock of its own: every function takes what it needs.
 *
 *  - {@link splitGstForSupply}: the GST into CGST + SGST (inside the seller's state) or IGST.
 *  - {@link financialYearOf}: the Indian financial year (1 April – 31 March, IST) of an instant.
 *  - {@link formatDocumentNumber}: `BB/2026-27/0001` — prefix, financial year, serial.
 *  - {@link rupeesInWords}: the total in words, Indian system (lakh, crore).
 */

/** Inside the seller's state (CGST + SGST) or across states (IGST). */
export type GstSupplyType = "intra" | "inter";

/** The tax lines of one document, in paise. Exactly one of the two shapes is non-zero. */
export interface GstSplit {
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

const PAISE_PER_RUPEE = 100;

/**
 * Split a whole-rupee GST for the supply type (owner ruling 2026-11-18):
 *  - `intra`: CGST + SGST, each a whole rupee, summing to the GST. When the GST is an odd number of
 *    rupees, CGST takes the extra rupee (₹181 → CGST ₹91 + SGST ₹90).
 *  - `inter`: IGST = the GST.
 *
 * Throws a `RangeError` for a GST that is negative, not a safe integer, or not a whole rupee: the
 * tax is rounded to the rupee before it gets here (`gstPriceLine`), so anything else is a bug.
 */
export function splitGstForSupply(gstPaise: number, supplyType: GstSupplyType): GstSplit {
  if (!Number.isSafeInteger(gstPaise) || gstPaise < 0) {
    throw new RangeError("splitGstForSupply expects a non-negative integer number of paise");
  }
  if (gstPaise % PAISE_PER_RUPEE !== 0) {
    throw new RangeError("splitGstForSupply expects a whole-rupee GST");
  }
  if (supplyType === "inter") return { cgstPaise: 0, sgstPaise: 0, igstPaise: gstPaise };
  const rupees = gstPaise / PAISE_PER_RUPEE;
  const cgstRupees = Math.ceil(rupees / 2);
  return {
    cgstPaise: cgstRupees * PAISE_PER_RUPEE,
    sgstPaise: (rupees - cgstRupees) * PAISE_PER_RUPEE,
    igstPaise: 0,
  };
}

/** Intra-state when the buyer's place of supply is the seller's own state; inter-state otherwise. */
export function supplyTypeFor(sellerStateCode: string, placeOfSupplyCode: string): GstSupplyType {
  return sellerStateCode === placeOfSupplyCode ? "intra" : "inter";
}

/** India has no daylight saving: IST is UTC+05:30 all year. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The Indian financial year an instant falls in, as `YYYY-YY` (`2026-27`): 1 April 00:00 IST to
 * 31 March 23:59:59.999 IST. 2027-03-31 23:59 IST → `2026-27`; 2027-04-01 00:00 IST → `2027-28`.
 */
export function financialYearOf(at: Date): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("financialYearOf expects a valid date");
  const ist = new Date(ms + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1; // April is month 3
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Rule 46(b): an invoice or credit-note number is at most 16 characters. */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16;
/** The serial is zero-padded to 4 digits (`0001`) and grows wider past 9999. */
const SERIAL_PAD = 4;

/**
 * `<prefix>/<financial year>/<serial>`: `BB/2026-27/0001`, `CN/2026-27/0001`. The serial is
 * zero-padded to 4 digits and printed wider past 9999. Throws a `RangeError` for a serial that is
 * not a positive integer or a number longer than {@link MAX_DOCUMENT_NUMBER_LENGTH}; the caller
 * issues nothing then (the counter rolls back with it).
 */
export function formatDocumentNumber(prefix: string, financialYear: string, serial: number): string {
  if (!Number.isSafeInteger(serial) || serial < 1) {
    throw new RangeError("a document serial is a positive integer");
  }
  const number = `${prefix}/${financialYear}/${String(serial).padStart(SERIAL_PAD, "0")}`;
  if (number.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    throw new RangeError(
      `a document number may hold at most ${MAX_DOCUMENT_NUMBER_LENGTH} characters`,
    );
  }
  return number;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
] as const;
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
] as const;

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] as string;
  const tens = TENS[Math.floor(n / 10)] as string;
  const ones = n % 10;
  return ones === 0 ? tens : `${tens} ${ONES[ones] as string}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds] as string} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(" ");
}

/** A non-negative integer in words, Indian system: crore, lakh, thousand, hundred. */
function integerInWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore > 0) parts.push(`${integerInWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/**
 * An amount of paise in words, Indian system: 1,17,900 paise → `Rupees One Thousand One Hundred
 * Seventy Nine Only`; 1,00,050 → `Rupees One Thousand and Fifty Paise Only`. Throws a `RangeError`
 * for a negative or unsafe amount.
 */
export function rupeesInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new RangeError("rupeesInWords expects a non-negative integer number of paise");
  }
  const rupees = Math.floor(paise / PAISE_PER_RUPEE);
  const rest = paise % PAISE_PER_RUPEE;
  const head = `Rupees ${integerInWords(rupees)}`;
  return rest === 0 ? `${head} Only` : `${head} and ${belowHundred(rest)} Paise Only`;
}

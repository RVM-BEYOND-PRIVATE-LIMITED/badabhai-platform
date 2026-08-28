/**
 * The worker's number, as a sheet prints it (R10 §2.4).
 *
 * THE GAP THIS CLOSES. `workers.phone_e164` stores E.164 ciphertext, the render processor
 * decrypts it and passes it straight into `{{phone}}`, and NOTHING formatted it anywhere in
 * `apps/api/src/resume`. So production printed `+919876543210` while the ratified sample prints
 * `+91 98765 43210` — and every fixture in the repo carried the grouped form by hand, so no test
 * could see the difference. Nine packets of sheets were reviewed against a formatting the product
 * could not produce.
 *
 * INDIAN GROUPING, NOT A GENERAL PHONE LIBRARY. `+91 XXXXX XXXXX` is how the number is read aloud,
 * written on a gate pass and dialled in this market, and it is what both ratified samples print.
 * A dependency that formats every country's numbers would be a larger surface for one string.
 *
 * ANYTHING IT DOES NOT RECOGNISE PASSES THROUGH UNCHANGED. A worker with a number this does not
 * match still gets his digits on his sheet: a résumé without a reachable number is useless, so
 * the failure mode is "unformatted", never "absent". That is the same degrade the decrypt path
 * already takes one layer up.
 */

/** `+91 98765 43210`, or the input untouched when it is not a recognisable Indian mobile. */
export function formatWorkerPhone(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  const trimmed = phone.trim();
  if (trimmed === "") return null;

  // Digits only, so a number stored as "+91-98765-43210" or "+91 9876543210" normalises to the
  // same ten digits before grouping. The leading `+` is re-added below rather than preserved,
  // because the sheet's format is fixed and the stored one is not.
  const digits = trimmed.replace(/\D/g, "");

  // 91 + ten digits, with or without the plus. An Indian mobile never starts below 6, which is
  // what keeps a 12-digit landline or an accidental double-prefix from being grouped as one.
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  // A bare ten-digit mobile, which is how a worker types it and how some older rows were stored.
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return trimmed;
}

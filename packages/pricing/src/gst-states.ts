/**
 * The GST state and union-territory codes a place of supply can carry (#2749 part 4) — the GSTN
 * list, current as of 2026. PURE data.
 *
 * A code is the first two digits of a GSTIN registered in that state, and the "place of supply"
 * line on an invoice prints the name and the code: `Haryana (06)`. Two retired codes are left out
 * on purpose, so a company cannot save one as its state today: `25` (Daman and Diu, merged into
 * `26` in 2020) and `28` (the undivided Andhra Pradesh; `37` since 2014). `96` (Centre
 * jurisdiction) is a tax-administration code, never a buyer's state, and is left out too.
 *
 * Campus keeps a free-text-name → code map for the same list (`lib/gst/state-code-map.ts`); here
 * the company picks the code, so only code → name is needed.
 */
export const GST_STATES: Readonly<Record<string, string>> = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
});

/** Every code a company may save as its billing state, ascending. */
export const GST_STATE_CODES: readonly string[] = Object.freeze(Object.keys(GST_STATES).sort());

/** True for a two-digit code in {@link GST_STATES}. */
export function isGstStateCode(value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GST_STATES, value);
}

/** The state's name for a code, or null for a code not in the list. */
export function gstStateName(code: string): string | null {
  return isGstStateCode(code) ? (GST_STATES[code] as string) : null;
}

/** ₹ with two decimals from integer paise (tax lines: "GST ₹180.00"). Client-safe: no fetches. */
export function paiseToInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

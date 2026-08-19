/// India-only phone composition for the `/payer/*` contract.
///
/// The backend validates every phone with `e164PhoneSchema`
/// (`/^\+[1-9]\d{7,14}$/`), so a bare national number like `8946991002` is
/// rejected with a 400. Payers enter the 10 national digits; the `+91` is added
/// HERE at submit so the user never has to type it (and can never fat-finger it).
///
/// Mirrors the worker app's `phone_format.dart`, including its deliberate choice
/// NOT to police the leading digit or operator series — the server is the sole
/// authority on reachability, and a client-side guess would lock out a legitimate
/// payer whose number series the app has never heard of.
library;

/// India dial code. The platform is India-only (Fast2SMS / DLT), so this is fixed
/// chrome on the phone field rather than a country picker.
const String kIndiaDialCode = '+91';

/// Digits in an Indian national mobile number — what the payer types.
const int kNationalMobileDigits = 10;

/// Normalises loosely-typed Indian mobile input to E.164, or `null` when it is not
/// exactly 10 national digits (after stripping obvious chrome the user may paste).
///
/// Tolerant so the same number entered any of these ways yields `+918946991002`:
///   `8946991002`, `89469 91002`, `8946-991002`, `08946991002`, `918946991002`,
///   `+91 8946991002`.
/// Anything that does not reduce to 10 digits returns `null` — the caller shows an
/// inline error instead of sending a number the server will only 400.
String? normalizeIndianMobileToE164(String raw) {
  var digits = raw.replaceAll(RegExp(r'\D'), '');
  // Shed a pasted country/trunk prefix so it is not double-counted as national.
  if (digits.length == 12 && digits.startsWith('91')) {
    digits = digits.substring(2);
  } else if (digits.length == 11 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  if (digits.length != kNationalMobileDigits) return null;
  return '$kIndiaDialCode$digits';
}

/// True when [raw] reduces to a complete 10-digit national number — the submit
/// gate. Does not police the leading digit (see the library note).
bool isValidIndianMobile(String raw) =>
    normalizeIndianMobileToE164(raw) != null;

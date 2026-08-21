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

/// Reduce loosely-typed / pasted input to the 10 NATIONAL digits for the phone
/// FIELD: strip non-digits, drop a pasted `91` country prefix (12 digits) or a
/// leading trunk `0` (11 digits) FIRST, then cap at 10.
///
/// This exists because the field must not blindly cap at 10 raw digits: pasting
/// `+91 8946991002` digit-strips to `918946991002` (12), and a naive 10-cap keeps
/// the FIRST ten (`9189469910`) — a wrong number that [normalizeIndianMobileToE164]
/// then accepts as a valid-looking E.164 and silently saves (the payer's OTP would
/// go to a number they don't own). Stripping the prefix before the cap makes the
/// same paste land on the correct `8946991002`.
///
/// NOTE: this CAPS (for live display); it never validates. [normalizeIndianMobileToE164]
/// stays the strict source of truth — it returns null unless the input reduces to
/// EXACTLY 10 digits, so an over-long paste is rejected, not truncated-then-accepted.
String toNationalDigits(String raw) {
  var digits = raw.replaceAll(RegExp(r'\D'), '');
  if (digits.length == 12 && digits.startsWith('91')) {
    digits = digits.substring(2);
  } else if (digits.length == 11 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  return digits.length > kNationalMobileDigits
      ? digits.substring(0, kNationalMobileDigits)
      : digits;
}

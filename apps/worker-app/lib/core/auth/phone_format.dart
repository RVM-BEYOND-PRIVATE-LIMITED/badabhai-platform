/// India dial code. The app is India-only (Fast2SMS + DLT templates), so this is
/// fixed chrome on the phone fields rather than a country picker.
const String kIndiaDialCode = '+91';

/// Digits in an Indian national mobile number, i.e. what the worker types.
const int kNationalNumberDigits = 10;

/// Composes the E.164 number the auth contract expects from the [national]
/// digits the field holds.
///
/// The phone fields used to seed '+91' INTO the controller, so a worker could
/// backspace it away — and the raw text went to requestOtp() verbatim, which
/// sent a malformed number and quietly cost them an OTP. `+91` is now fixed
/// chrome the field renders, the controller holds only the 10 national digits,
/// and E.164 is composed here at submit.
///
/// Defensive strip: the field's formatters already permit digits only, but a
/// caller that ever passes formatted text must not produce '+91 98765 43210'.
String toE164(String national) =>
    '$kIndiaDialCode${national.replaceAll(RegExp(r'\D'), '')}';

/// True when [national] is a complete 10-digit number — the CTA gate. Deliberate
/// minimum: it does NOT police the leading digit or any operator range. The
/// server is the authority on whether a number is reachable, and a client-side
/// guess would lock out a legitimate worker whose series the app has never heard
/// of.
bool isCompleteNationalNumber(String national) =>
    national.replaceAll(RegExp(r'\D'), '').length == kNationalNumberDigits;

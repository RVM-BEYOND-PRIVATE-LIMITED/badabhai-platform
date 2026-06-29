import 'auth_failure.dart';

/// Worker-facing copy for each auth error code, per locale.
///
/// Warm "bada bhai" Hinglish (design-system voice) with an English fallback.
/// PURE DATA — PASS 2's UI looks up `authErrorMessage(failure, locale)`; this file
/// has no Flutter import and no logic beyond the lookup.
///
/// EXPANDABLE + FLAGGED FOR REAL l10n: these strings are interim and should move
/// into the app's proper l10n/ARB pipeline before launch. `mr`/`bho` are seeded
/// from the Hindi line where a vetted translation is not yet available — flagged
/// here so a translator can fill them in.
///
/// Some messages carry a `{n}` (attempts left) or `{t}` placeholder (a
/// human-friendly retry window) that `authErrorMessage` fills from the
/// [AuthFailure] metadata.
const Map<String, Map<String, String>> kAuthErrorMessages =
    <String, Map<String, String>>{
  AuthErrorCode.pinLocked: <String, String>{
    'hi': 'Bahut galat tries — {t} baad dobara try karein.',
    'mr': 'Bahut galat tries — {t} baad dobara try karein.', // TODO l10n: mr
    'bho': 'Bahut galat tries — {t} baad dobara try karein.', // TODO l10n: bho
    'en': 'Too many wrong tries. Try again in {t}.',
  },
  AuthErrorCode.pinInvalid: <String, String>{
    'hi': 'Galat PIN ({n} tries bachi).',
    'mr': 'Galat PIN ({n} tries bachi).', // TODO l10n: mr
    'bho': 'Galat PIN ({n} tries bachi).', // TODO l10n: bho
    'en': 'Wrong PIN ({n} tries left).',
  },
  AuthErrorCode.requiresOtp: <String, String>{
    'hi': 'Surakshit rakhne ke liye dobara login karein.',
    'mr': 'Surakshit rakhne ke liye dobara login karein.', // TODO l10n: mr
    'bho': 'Surakshit rakhne ke liye dobara login karein.', // TODO l10n: bho
    'en': 'Please log in again to keep your account safe.',
  },
  AuthErrorCode.refreshReuseDetected: <String, String>{
    'hi': 'Surakshit rakhne ke liye dobara login karein.',
    'mr': 'Surakshit rakhne ke liye dobara login karein.', // TODO l10n: mr
    'bho': 'Surakshit rakhne ke liye dobara login karein.', // TODO l10n: bho
    'en': 'Please log in again to keep your account safe.',
  },
  AuthErrorCode.deviceRevoked: <String, String>{
    'hi': 'Yeh device hata diya gaya — dobara login karein.',
    'mr': 'Yeh device hata diya gaya — dobara login karein.', // TODO l10n: mr
    'bho': 'Yeh device hata diya gaya — dobara login karein.', // TODO l10n: bho
    'en': 'This device was removed. Please log in again.',
  },
  AuthErrorCode.otpRateLimited: <String, String>{
    'hi': 'Thodi der baad try karein.',
    'mr': 'Thodi der baad try karein.', // TODO l10n: mr
    'bho': 'Thodi der baad try karein.', // TODO l10n: bho
    'en': 'Please try again in a little while.',
  },
  AuthErrorCode.otpInvalid: <String, String>{
    'hi': 'Galat code. Dobara daalein.',
    'mr': 'Galat code. Dobara daalein.', // TODO l10n: mr
    'bho': 'Galat code. Dobara daalein.', // TODO l10n: bho
    'en': 'Wrong code. Please re-enter.',
  },
  AuthErrorCode.tokenExpired: <String, String>{
    'hi': 'Session khatam ho gaya — dobara login karein.',
    'mr': 'Session khatam ho gaya — dobara login karein.', // TODO l10n: mr
    'bho': 'Session khatam ho gaya — dobara login karein.', // TODO l10n: bho
    'en': 'Your session expired. Please log in again.',
  },
  AuthErrorCode.network: <String, String>{
    'hi': 'Internet nahi mil raha. Dobara try karein.',
    'mr': 'Internet nahi mil raha. Dobara try karein.', // TODO l10n: mr
    'bho': 'Internet nahi mil raha. Dobara try karein.', // TODO l10n: bho
    'en': "Can't reach the server. Please try again.",
  },
  AuthErrorCode.unknown: <String, String>{
    'hi': 'Kuch gadbad ho gayi. Dobara try karein.',
    'mr': 'Kuch gadbad ho gayi. Dobara try karein.', // TODO l10n: mr
    'bho': 'Kuch gadbad ho gayi. Dobara try karein.', // TODO l10n: bho
    'en': 'Something went wrong. Please try again.',
  },
};

/// Resolves the localized message for [failure] in [locale], filling the `{n}`
/// (attempts-left) and `{t}` (retry window) placeholders from the failure's
/// metadata. Falls back: requested locale → Hindi → English → the failure's own
/// generic message. PASS 2's UI calls this; it never displays the raw server
/// message.
String authErrorMessage(AuthFailure failure, String locale) {
  final Map<String, String>? byLocale = kAuthErrorMessages[failure.code];
  final String template = byLocale?[locale] ??
      byLocale?['hi'] ??
      byLocale?['en'] ??
      failure.message;
  return template
      .replaceAll('{n}', failure.attemptsLeft?.toString() ?? '0')
      .replaceAll('{t}', _humanizeRetry(failure.retryAfter));
}

/// Renders a retry window as worker-friendly copy ("30 second", "2 minute").
String _humanizeRetry(Duration? retryAfter) {
  if (retryAfter == null) return 'thodi der';
  final int seconds = retryAfter.inSeconds;
  if (seconds < 60) return '$seconds second';
  final int minutes = (seconds / 60).ceil();
  return '$minutes minute';
}

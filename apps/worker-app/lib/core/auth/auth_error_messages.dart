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
/// There are NO placeholders: the real backend sends no attempts-left / retry
/// metadata, so PIN copy is neutral and rate-limit / unavailable / weak-PIN
/// prefer the server `message` when present (see [authErrorMessage]).
const Map<String, Map<String, String>> kAuthErrorMessages =
    <String, Map<String, String>>{
  AuthErrorCode.otpInvalid: <String, String>{
    'hi': 'Galat code. Dobara daalein.',
    'mr': 'Galat code. Dobara daalein.', // TODO l10n: mr
    'bho': 'Galat code. Dobara daalein.', // TODO l10n: bho
    'en': 'Wrong code. Please re-enter.',
  },
  AuthErrorCode.otpRateLimited: <String, String>{
    'hi': 'OTP bhejne ki limit ho gayi — thodi der baad dobara try karein.',
    'mr': 'OTP bhejne ki limit ho gayi — thodi der baad dobara try karein.', // TODO l10n: mr
    'bho': 'OTP bhejne ki limit ho gayi — thodi der baad dobara try karein.', // TODO l10n: bho
    'en': 'OTP send limit reached. Please try again after some time.',
  },
  AuthErrorCode.pinVerifyFailed: <String, String>{
    'hi': 'PIN sahi nahi — dobara try karein, ya \'PIN bhool gaye?\'',
    'mr':
        'PIN sahi nahi — dobara try karein, ya \'PIN bhool gaye?\'', // TODO l10n: mr
    'bho':
        'PIN sahi nahi — dobara try karein, ya \'PIN bhool gaye?\'', // TODO l10n: bho
    'en': "PIN didn't match — try again, or tap 'Forgot PIN?'",
  },
  AuthErrorCode.pinWeak: <String, String>{
    'hi': 'Yeh PIN kamzor hai — thoda mushkil PIN chunein.',
    'mr': 'Yeh PIN kamzor hai — thoda mushkil PIN chunein.', // TODO l10n: mr
    'bho': 'Yeh PIN kamzor hai — thoda mushkil PIN chunein.', // TODO l10n: bho
    'en': 'That PIN is too weak. Please choose a stronger one.',
  },
  AuthErrorCode.reauthRequired: <String, String>{
    'hi': 'Surakshit rakhne ke liye dobara login karein.',
    'mr': 'Surakshit rakhne ke liye dobara login karein.', // TODO l10n: mr
    'bho': 'Surakshit rakhne ke liye dobara login karein.', // TODO l10n: bho
    'en': 'Please log in again to keep your account safe.',
  },
  AuthErrorCode.unavailable: <String, String>{
    'hi': 'Service abhi busy hai. Thodi der baad try karein.',
    'mr': 'Service abhi busy hai. Thodi der baad try karein.', // TODO l10n: mr
    'bho': 'Service abhi busy hai. Thodi der baad try karein.', // TODO l10n: bho
    'en': 'Service is busy right now. Please try again shortly.',
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
  // Honest parse-failure copy: the server replied but in a shape we could not
  // read — say so, never a false "check internet". (Sole caller today:
  // AuthApi.listDevices on a missing/non-list `devices` key.)
  AuthErrorCode.contractError: <String, String>{
    'hi': 'Device list theek se nahi mili — dobara try karein.',
    'mr': 'Device list theek se nahi mili — dobara try karein.', // TODO l10n: mr
    'bho': 'Device list theek se nahi mili — dobara try karein.', // TODO l10n: bho
    'en': "Couldn't read the device list. Please try again.",
  },
};

/// Codes whose backend `message` is meaningful + safe to surface directly when
/// present (rate-limit windows, provider-unavailable detail, weak-PIN reason).
/// All other codes always use the curated localized copy above.
const Set<String> _preferServerMessage = <String>{
  AuthErrorCode.otpRateLimited,
  AuthErrorCode.unavailable,
  AuthErrorCode.pinWeak,
};

/// Resolves the localized message for [failure] in [locale].
///
/// For the few codes in [_preferServerMessage] the server's non-generic
/// [AuthFailure.message] is shown when present; otherwise the localized copy is
/// used. Falls back: requested locale → Hindi → English → the failure's own
/// generic message. PASS 2's UI calls this; it never displays a raw server
/// message for codes outside [_preferServerMessage].
String authErrorMessage(AuthFailure failure, String locale) {
  if (_preferServerMessage.contains(failure.code) &&
      _isMeaningful(failure.message)) {
    return failure.message;
  }
  final Map<String, String>? byLocale = kAuthErrorMessages[failure.code];
  return byLocale?[locale] ??
      byLocale?['hi'] ??
      byLocale?['en'] ??
      failure.message;
}

/// A server message is "meaningful" when it isn't empty or the generic default
/// [AuthFailure] carries when none was parsed.
bool _isMeaningful(String message) =>
    message.isNotEmpty && message != 'Please try again.';

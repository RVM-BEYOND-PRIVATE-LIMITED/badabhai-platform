import 'package:play_install_referrer/play_install_referrer.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'pending_referral_store.dart';

/// The referrer query parameter our invite links carry, e.g.
/// `https://play.google.com/store/apps/details?id=…&referrer=bb_code%3Dabcdef012345`.
/// Same opaque 12-hex code as the `/i/<code>` deep link — PII-free.
const String kInstallReferrerCodeParam = 'bb_code';

/// Fetches Google Play's raw install-referrer string. Injected so tests never
/// touch the platform channel (it throws under `flutter test`).
typedef InstallReferrerFetch = Future<String?> Function();

Future<String?> _defaultFetch() async =>
    (await PlayInstallReferrer.installReferrer).installReferrer;

/// Extracts the referral code from a raw Play install-referrer string.
///
/// The referrer is a URL query string — `utm_source=whatsapp&bb_code=abc…` —
/// and Google Play hands it back either decoded or percent-encoded depending on
/// how it was attached, so both are tried. Returns null for anything that is not
/// a referrer carrying [kInstallReferrerCodeParam].
///
/// The 12-hex SHAPE is deliberately NOT checked here: [PendingReferralStore]
/// .capture is the single validator shared with the deep-link router, so the
/// shape rule can never drift between the two entry points.
String? referralCodeFromInstallReferrer(String? referrer) {
  if (referrer == null) return null;
  final String raw = referrer.trim();
  if (raw.isEmpty) return null;

  // Try as-is, then once-decoded. `splitQueryString` throws (ArgumentError /
  // FormatException) on a broken percent escape — a malformed referrer is a
  // "no code", never an exception into first launch.
  for (final String candidate in <String>[raw, _tryDecode(raw)]) {
    try {
      final Map<String, String> params = Uri.splitQueryString(candidate);
      final String? code = params[kInstallReferrerCodeParam]?.trim();
      if (code != null && code.isNotEmpty) return code;
    } catch (_) {
      // Not parseable in this form — fall through to the next candidate.
    }
  }
  return null;
}

String _tryDecode(String value) {
  try {
    return Uri.decodeComponent(value);
  } catch (_) {
    return value;
  }
}

/// B4 ATTRIBUTION — recovers a referral that the Play Store swallowed.
///
/// A worker who taps an invite link WITHOUT the app installed goes to Play, and
/// the referral dies there: the install has no deep-link intent, so
/// [PendingReferralStore] stays empty and the inviting agent is never credited.
/// This reads Play's install-referrer string once and puts the code back into
/// that same store, so the EXISTING post-consent drain
/// (`consent_repository_impl.dart` → `POST /referrals/attribute`) simply starts
/// receiving codes that used to be lost. NO new API call, no new endpoint.
///
/// ## Hard rules
///
/// 1. **Never blocks or slows first launch.** Called after the first frame,
///    unawaited. Every failure mode — no Play Store, no referrer, malformed
///    referrer, plugin missing (iOS / `flutter test`), Play Services down — is
///    swallowed and leaves the store untouched. Attribution is a best-effort
///    side-signal, never a gate.
/// 2. **Exactly once per install.** A persisted flag makes this a one-shot, so a
///    90-day-old referrer can never re-fire on a later cold start and re-attribute
///    a worker who has long since been credited.
/// 3. **Never clobbers a fresher deep link.** If a `/i/<code>` code is already
///    pending, that one wins: the worker tapped it in THIS session, whereas the
///    install referrer is a record of some earlier click.
/// 4. **PII-free.** The referrer string is parsed for one opaque code and is
///    never logged, stored raw, or sent anywhere.
class InstallReferrerReader {
  InstallReferrerReader({
    required PendingReferralStore store,
    InstallReferrerFetch? fetch,
    Future<SharedPreferences> Function()? prefs,
  })  : _store = store,
        _fetch = fetch ?? _defaultFetch,
        _prefs = prefs ?? SharedPreferences.getInstance;

  /// `bb_`-prefixed to match the `bb_locale` / `bb_pending_referral` convention.
  static const String kConsumedKey = 'bb_install_referrer_consumed';

  final PendingReferralStore _store;
  final InstallReferrerFetch _fetch;
  final Future<SharedPreferences> Function() _prefs;

  /// Reads the install referrer at most once per install and captures any
  /// [kInstallReferrerCodeParam] it carries. NEVER throws.
  ///
  /// The one-shot flag is set once the attempt COMPLETES — including when there
  /// was no referrer or no code in it. That is deliberate: "Play told us there is
  /// nothing" is a real answer, and re-asking on every cold start would spend a
  /// service binding forever on a signal that is only ever present right after an
  /// install. A fetch that THROWS is not an answer, so it leaves the flag unset
  /// and a later launch may try again.
  Future<void> consumeOnce() async {
    try {
      final SharedPreferences prefs = await _prefs();
      if (prefs.getBool(kConsumedKey) ?? false) return;

      // Rule 3: a deep link captured in this session outranks the install
      // referrer. Read the store's own key rather than `take()`, which would
      // CONSUME the pending code and hand it to nobody.
      final String? alreadyPending =
          prefs.getString(SharedPrefsPendingReferralStore.kKey);
      if (alreadyPending != null && alreadyPending.isNotEmpty) {
        await prefs.setBool(kConsumedKey, true);
        return;
      }

      final String? referrer = await _fetch();
      // The fetch answered, so this install has had its one look.
      await prefs.setBool(kConsumedKey, true);

      final String? code = referralCodeFromInstallReferrer(referrer);
      if (code == null) return;
      // `capture` is the single shape validator and never throws — junk is
      // dropped there rather than stored. Tag the leg so post-consent attribution
      // records this code arrived via Play's install referrer (observability).
      await _store.capture(code, source: ReferralSource.installReferrer);
    } catch (_) {
      // Best-effort by contract (rule 1). A missing plugin, an unavailable Play
      // Store, or a prefs error simply means "not attributed".
    }
  }
}

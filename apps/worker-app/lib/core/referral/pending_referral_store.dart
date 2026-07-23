import 'package:shared_preferences/shared_preferences.dart';

/// The 12-lowercase-hex referral-code shape shared by worker→worker (ADR-0020)
/// and agency (ADR-0022) invites, mirroring the backend regex `^[a-f0-9]{12}$`.
/// The code is OPAQUE — it carries no worker identity — so it is PII-free.
final RegExp _kReferralCodePattern = RegExp(r'^[a-f0-9]{12}$');

/// True only for a well-formed 12-hex referral code. The single validator both
/// [PendingReferralStore] implementations and the deep-link router share, so the
/// shape check can never drift between capture and consume.
bool isValidReferralCode(String? code) =>
    code != null && _kReferralCodePattern.hasMatch(code);

/// Holds a referral code captured from a `/i/<code>` deep link until it can be
/// attributed — AFTER consent, exactly once (a best-effort side-signal; see
/// [ApiClient.attributeReferral]).
///
/// The code is OPAQUE and PII-FREE, so it lives in PLAIN prefs (same posture as
/// the locale + notification-read state), NEVER secure storage. It survives a
/// cold start: captured at launch (the router deep-link redirect), consumed
/// post-consent even if the app was killed in between.
abstract interface class PendingReferralStore {
  /// Persists [code] IF it matches the 12-hex shape; ignores anything else.
  /// Best-effort — NEVER throws (a storage error just means "not captured"), so
  /// it is safe to fire-and-forget from the router redirect.
  Future<void> capture(String? code);

  /// Returns the pending code and CLEARS it (consumed exactly once), or null
  /// when nothing valid is pending. Best-effort — NEVER throws.
  Future<String?> take();
}

/// [PendingReferralStore] over `shared_preferences`.
///
/// Resolves [SharedPreferences] LAZILY on each call (like
/// SharedPrefsNotificationReadStore) rather than taking a pre-resolved instance,
/// so REGISTERING it never touches the platform channel — which keeps the
/// plugin-free widget-test graph (and any caller built before the async init)
/// from tripping the `shared_preferences` channel that never answers under
/// `flutter test`. Both methods additionally swallow a plugin error to honour
/// the best-effort contract.
class SharedPrefsPendingReferralStore implements PendingReferralStore {
  const SharedPrefsPendingReferralStore();

  /// `bb_`-prefixed to match the existing `bb_locale` key convention.
  static const String kKey = 'bb_pending_referral';

  @override
  Future<void> capture(String? code) async {
    if (!isValidReferralCode(code)) return;
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString(kKey, code!);
    } catch (_) {
      // Best-effort: a storage failure simply means the code is not captured.
    }
  }

  @override
  Future<String?> take() async {
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final String? code = prefs.getString(kKey);
      // Consume exactly once: clear whatever was there (valid or stale) before
      // returning, so a later app-open never re-attributes the same code.
      if (code != null) await prefs.remove(kKey);
      return isValidReferralCode(code) ? code : null;
    } catch (_) {
      // Best-effort: a storage failure must never surface to onboarding.
      return null;
    }
  }
}

/// In-memory [PendingReferralStore] — the seam unit tests inject, and the safe
/// default anywhere persistence is not wired. Loses the code on a cold start,
/// which is acceptable: attribution is a best-effort side-signal, not a gate.
class InMemoryPendingReferralStore implements PendingReferralStore {
  String? _code;

  @override
  Future<void> capture(String? code) async {
    if (isValidReferralCode(code)) _code = code;
  }

  @override
  Future<String?> take() async {
    final String? code = _code;
    _code = null;
    return code;
  }
}

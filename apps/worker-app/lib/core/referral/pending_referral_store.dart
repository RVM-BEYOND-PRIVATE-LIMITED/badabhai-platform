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

/// The closed set of install-source legs a captured referral can carry, mirroring
/// the server's `source` field on `POST /referrals/attribute`
/// (`app_link` | `install_referrer` | `custom_scheme` | `unknown`). Observability
/// only — the leg is opaque + PII-free and never blocks attribution. A captured
/// code whose leg is unknown simply OMITS the field (the server reads missing as
/// `unknown`), so only [known] legs are ever persisted/sent.
class ReferralSource {
  const ReferralSource._();

  /// The code arrived on an `https` App Link.
  static const String appLink = 'app_link';

  /// The code arrived through Google Play's install referrer (B4).
  static const String installReferrer = 'install_referrer';

  /// The code arrived on the `badabhai://` custom scheme.
  static const String customScheme = 'custom_scheme';

  /// No leg could be determined — sent as a MISSING field, never this literal.
  static const String unknown = 'unknown';

  /// The legs worth persisting/sending. `unknown` is deliberately excluded: it is
  /// expressed by OMITTING the field, so anything not in this set is dropped.
  static const Set<String> known = <String>{
    appLink,
    installReferrer,
    customScheme,
  };
}

/// A captured referral: the opaque 12-hex [code] plus, optionally, the
/// install-[source] leg it arrived through (one of [ReferralSource.known], or
/// null when undetermined). Both are PII-free.
class PendingReferral {
  const PendingReferral(this.code, {this.source});

  final String code;
  final String? source;
}

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
  /// [source] is the OPTIONAL install-source leg — persisted only when it is one
  /// of [ReferralSource.known], otherwise dropped (an undetermined leg is
  /// expressed by its absence). Best-effort — NEVER throws (a storage error just
  /// means "not captured"), so it is safe to fire-and-forget from the router
  /// redirect.
  Future<void> capture(String? code, {String? source});

  /// Returns the pending referral (code + source) and CLEARS it (consumed exactly
  /// once), or null when nothing valid is pending. Best-effort — NEVER throws.
  Future<PendingReferral?> takePending();

  /// Convenience: [takePending] but returns only the code (back-compat). Also
  /// consumes the pending referral. Best-effort — NEVER throws.
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

  /// Companion key for the install-source leg (see [ReferralSource]). Held
  /// alongside [kKey] and cleared with it, so the source can never outlive its
  /// code. A pre-existing capture (before this key existed) simply has no source.
  static const String kSourceKey = 'bb_pending_referral_source';

  @override
  Future<void> capture(String? code, {String? source}) async {
    if (!isValidReferralCode(code)) return;
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString(kKey, code!);
      // Only persist a KNOWN leg; an undetermined one is expressed by ABSENCE.
      // Always overwrite (set or clear) so a fresh capture never inherits a stale
      // source from a previous one.
      if (source != null && ReferralSource.known.contains(source)) {
        await prefs.setString(kSourceKey, source);
      } else {
        await prefs.remove(kSourceKey);
      }
    } catch (_) {
      // Best-effort: a storage failure simply means the code is not captured.
    }
  }

  @override
  Future<PendingReferral?> takePending() async {
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final String? code = prefs.getString(kKey);
      final String? source = prefs.getString(kSourceKey);
      // Consume exactly once: clear both (valid or stale) before returning, so a
      // later app-open never re-attributes the same code.
      if (code != null) await prefs.remove(kKey);
      if (source != null) await prefs.remove(kSourceKey);
      if (!isValidReferralCode(code)) return null;
      return PendingReferral(code!, source: source);
    } catch (_) {
      // Best-effort: a storage failure must never surface to onboarding.
      return null;
    }
  }

  @override
  Future<String?> take() async => (await takePending())?.code;
}

/// In-memory [PendingReferralStore] — the seam unit tests inject, and the safe
/// default anywhere persistence is not wired. Loses the code on a cold start,
/// which is acceptable: attribution is a best-effort side-signal, not a gate.
class InMemoryPendingReferralStore implements PendingReferralStore {
  String? _code;
  String? _source;

  @override
  Future<void> capture(String? code, {String? source}) async {
    if (isValidReferralCode(code)) {
      _code = code;
      // Only a KNOWN leg is retained; an undetermined one is expressed by null.
      _source = (source != null && ReferralSource.known.contains(source))
          ? source
          : null;
    }
  }

  @override
  Future<PendingReferral?> takePending() async {
    final String? code = _code;
    final String? source = _source;
    _code = null;
    _source = null;
    if (code == null) return null;
    return PendingReferral(code, source: source);
  }

  @override
  Future<String?> take() async => (await takePending())?.code;
}

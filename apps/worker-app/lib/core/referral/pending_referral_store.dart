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

/// WHICH LEG of the post-Dynamic-Links chain delivered a referral code (B4).
///
/// Firebase Dynamic Links died 2025-08-25, so attribution now rides three separate
/// transports, and they fail INDEPENDENTLY: App Links stop working if
/// `assetlinks.json` is mis-published, the Install Referrer stops if the Play
/// listing changes, the custom scheme stops if the manifest filter is dropped.
/// Without tagging which one delivered, a broken leg is invisible — the funnel just
/// quietly loses agents, which is the exact failure this workstream exists to end.
///
/// The wire values mirror the server's closed `InviteInstallSource` enum
/// (packages/event-schema) — a CLOSED set, so no client string can reach the spine.
enum ReferralSource {
  /// The app was installed and intercepted the verified `https://…/i/<code>` App Link.
  appLink('app_link'),

  /// A fresh install: the code came back from Play's Install Referrer on first run.
  installReferrer('install_referrer'),

  /// A `badabhai://i/<code>` deep link — the legacy/fallback leg.
  customScheme('custom_scheme'),

  /// Provenance not known (a code captured before this tagging existed).
  unknown('unknown');

  const ReferralSource(this.wire);

  /// The exact token the API expects. Never send `name` — it is camelCase.
  final String wire;

  /// Parse a persisted wire value back, defaulting to [unknown] for anything
  /// unrecognised (a prefs value written by an older build, or junk).
  static ReferralSource fromWire(String? wire) => ReferralSource.values.firstWhere(
        (ReferralSource s) => s.wire == wire,
        orElse: () => ReferralSource.unknown,
      );
}

/// A captured referral: the opaque code plus the leg that delivered it.
class PendingReferral {
  const PendingReferral(this.code, this.source);

  final String code;
  final ReferralSource source;
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
  /// Best-effort — NEVER throws (a storage error just means "not captured"), so
  /// it is safe to fire-and-forget from the router redirect.
  ///
  /// [source] records which leg delivered the code. It is OPTIONAL and defaults to
  /// [ReferralSource.unknown] so every pre-B4 call site keeps compiling and behaving
  /// exactly as before.
  ///
  /// The default is repeated HERE as well as in both implementations because Dart
  /// requires a non-nullable optional parameter to carry one in every declaration,
  /// including an abstract one — without it this file does not compile.
  Future<void> capture(
    String? code, {
    ReferralSource source = ReferralSource.unknown,
  });

  /// Returns the pending code and CLEARS it (consumed exactly once), or null
  /// when nothing valid is pending. Best-effort — NEVER throws.
  ///
  /// Kept returning a bare code so every existing caller and test is untouched;
  /// [takePending] is the source-aware form. Both consume — call ONE of them.
  Future<String?> take();

  /// Like [take], but also reports which leg delivered the code. Clears both.
  Future<PendingReferral?> takePending();
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

  /// The provenance of [kKey]'s code. A SEPARATE key rather than a composite value,
  /// so `InstallReferrerReader` can keep reading [kKey] directly to answer "is a
  /// fresher deep link already pending?" without having to parse anything.
  static const String kSourceKey = 'bb_pending_referral_source';

  @override
  Future<void> capture(
    String? code, {
    ReferralSource source = ReferralSource.unknown,
  }) async {
    if (!isValidReferralCode(code)) return;
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString(kKey, code!);
      await prefs.setString(kSourceKey, source.wire);
    } catch (_) {
      // Best-effort: a storage failure simply means the code is not captured.
    }
  }

  @override
  Future<String?> take() async => (await takePending())?.code;

  @override
  Future<PendingReferral?> takePending() async {
    try {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final String? code = prefs.getString(kKey);
      final String? source = prefs.getString(kSourceKey);
      // Consume exactly once: clear whatever was there (valid or stale) before
      // returning, so a later app-open never re-attributes the same code. The
      // source is cleared UNCONDITIONALLY alongside it — leaving a stale source
      // behind would mis-label the NEXT code captured without one.
      if (code != null) await prefs.remove(kKey);
      if (source != null) await prefs.remove(kSourceKey);
      if (!isValidReferralCode(code)) return null;
      return PendingReferral(code!, ReferralSource.fromWire(source));
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
  ReferralSource _source = ReferralSource.unknown;

  @override
  Future<void> capture(
    String? code, {
    ReferralSource source = ReferralSource.unknown,
  }) async {
    if (isValidReferralCode(code)) {
      _code = code;
      _source = source;
    }
  }

  @override
  Future<String?> take() async => (await takePending())?.code;

  @override
  Future<PendingReferral?> takePending() async {
    final String? code = _code;
    final ReferralSource source = _source;
    _code = null;
    _source = ReferralSource.unknown;
    return code == null ? null : PendingReferral(code, source);
  }
}

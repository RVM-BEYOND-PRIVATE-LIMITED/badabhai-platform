import 'package:shared_preferences/shared_preferences.dart';

/// Which version of the worker's résumé the Bada Bhai chat last OFFERED with its
/// "Resume download" tile (owner ruling, 2026-10-15).
///
/// The tile is offered on its own only for a résumé the worker has not been
/// offered yet — the first visit after profiling, or a résumé that changed (an
/// edit, a new one). Every other open of the chat stays quiet; the worker asking
/// for their résumé always brings it back. This store is what "not offered yet"
/// is measured against.
///
/// WHY THIS IS PERSISTED: the rule must hold across app restarts. Held in memory
/// only, every cold start would offer the same résumé again — exactly the
/// "the button is there every time I open the chat" the ruling removes.
///
/// The value is an opaque version token (`<résumé id>@<generated_at>`), never
/// worker content. Best-effort like the other session stores: every method
/// swallows a plugin error — a lost mark only costs one extra offer. Cleared on
/// logout so the next worker on a shared phone is offered their own résumé.
abstract interface class ResumeDownloadOfferStore {
  /// The version last offered, or null when none was. NEVER throws.
  Future<String?> lastOffered();

  /// Records [version] as offered. NEVER throws.
  Future<void> markOffered(String version);

  /// Forgets it. NEVER throws.
  Future<void> clear();
}

/// [ResumeDownloadOfferStore] over `shared_preferences`, resolved lazily per
/// call so registering it never touches the platform channel.
class SharedPrefsResumeDownloadOfferStore implements ResumeDownloadOfferStore {
  const SharedPrefsResumeDownloadOfferStore({
    Future<SharedPreferences> Function() prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final Future<SharedPreferences> Function() _prefs;

  /// `bb_`-prefixed to match the existing key convention.
  static const String kOfferedVersionKey = 'bb_resume_download_offered';

  @override
  Future<String?> lastOffered() async {
    try {
      final SharedPreferences prefs = await _prefs();
      return prefs.getString(kOfferedVersionKey);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> markOffered(String version) async {
    if (version.isEmpty) return;
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.setString(kOfferedVersionKey, version);
    } catch (_) {
      // Best-effort: a lost mark only costs one extra offer.
    }
  }

  @override
  Future<void> clear() async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.remove(kOfferedVersionKey);
    } catch (_) {
      // Best-effort: a teardown failure must never block sign-out.
    }
  }
}

/// In-memory [ResumeDownloadOfferStore]: the seam unit tests inject, and what
/// the chat falls back to in a graph that registers no persisted store — the
/// rule then holds for the life of the chat rather than not at all.
class InMemoryResumeDownloadOfferStore implements ResumeDownloadOfferStore {
  String? _version;

  @override
  Future<String?> lastOffered() async => _version;

  @override
  Future<void> markOffered(String version) async {
    if (version.isEmpty) return;
    _version = version;
  }

  @override
  Future<void> clear() async => _version = null;
}

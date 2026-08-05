import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/api/api_client.dart';
import '../../../core/session/session_repository.dart';
import '../domain/notification_prefs_repository.dart';

/// [NotificationPrefsRepository] backed by a local SharedPreferences cache plus a
/// best-effort server sync (GET to hydrate, PATCH to persist). The local cache is
/// what the toggle renders instantly; the server value is authoritative when it
/// is reachable (and is what the backend push-send path gates on).
///
/// PLAIN prefs is the right store: the on/off flag is not a credential (same
/// posture as the notification read-ids store). The key is per-DEVICE, so it is
/// cleared on logout ([onLogout]) to keep it from leaking across workers.
class NotificationPrefsRepositoryImpl implements NotificationPrefsRepository {
  NotificationPrefsRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  static const String _kEnabled = 'bb_notifications_enabled';

  /// In-memory memo, so a Settings rebuild does not re-hit prefs/network.
  bool? _cache;

  @override
  Future<bool> isEnabled() async {
    final String? token = _session.sessionToken;
    // Server-authoritative when we have a session AND the endpoint answers.
    if (token != null && token.isNotEmpty) {
      try {
        final bool remote = await _api.getNotificationPrefs(authToken: token);
        _cache = remote;
        await _writeLocal(remote);
        return remote;
      } catch (_) {
        // No endpoint yet / offline → fall back to the local value below.
      }
    }
    return _readLocal();
  }

  @override
  Future<void> setEnabled(bool enabled) async {
    // Local first so the toggle sticks even if the server sync fails.
    _cache = enabled;
    await _writeLocal(enabled);
    final String? token = _session.sessionToken;
    if (token != null && token.isNotEmpty) {
      try {
        await _api.updateNotificationPrefs(enabled: enabled, authToken: token);
      } catch (_) {
        // Best-effort: an older API without the route, or an offline device,
        // keeps the local choice; the next change retries the server write.
      }
    }
  }

  @override
  void onLogout() {
    _cache = null;
    unawaited(_clearLocal());
  }

  Future<bool> _readLocal() async {
    if (_cache != null) return _cache!;
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final bool value = prefs.getBool(_kEnabled) ?? true; // default ON
    _cache = value;
    return value;
  }

  Future<void> _writeLocal(bool value) async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kEnabled, value);
  }

  Future<void> _clearLocal() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kEnabled);
  }
}

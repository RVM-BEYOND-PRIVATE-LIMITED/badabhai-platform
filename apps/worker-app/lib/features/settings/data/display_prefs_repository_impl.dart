import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/api/api_client.dart';
import '../../../core/session/session_repository.dart';
import '../domain/display_prefs.dart';
import '../domain/display_prefs_repository.dart';

/// [DisplayPrefsRepository] backed by `…/me/display-prefs` plus a small
/// SharedPreferences cache. The cache is the first-paint value and the offline
/// queue; the server reply wins whenever it is reachable.
///
/// A 404 is the documented "the switch is closed / the route is absent" answer
/// and forces Light. A network failure is NOT: it keeps the cached choice, so a
/// worker on a bad connection does not watch the app flip to Light.
class DisplayPrefsRepositoryImpl implements DisplayPrefsRepository {
  DisplayPrefsRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  static const String _kChoice = 'bb_display_theme_choice';
  static const String _kOpen = 'bb_display_theme_open';
  static const String _kPending = 'bb_display_theme_pending';

  DisplayPrefs? _memo;

  @override
  Future<DisplayPrefs> read() async {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) {
      return _cachedOrDefault();
    }
    try {
      final Map<String, dynamic> json = await _api.getDisplayPrefs(
        authToken: token,
      );
      final DisplayPrefs prefs = DisplayPrefs.fromJson(json);
      _memo = prefs;
      await _writeCache(prefs);
      if (!prefs.themeOpen) {
        await _clearPending();
      } else {
        await flushPending();
      }
      return prefs;
    } on ApiException catch (e) {
      if (e.statusCode == 404) {
        // The route is absent or the switch is off: Light, no choice.
        await _clearCache();
        return DisplayPrefs.closed;
      }
      return _cachedOrDefault();
    } catch (_) {
      // Offline / 5xx: keep what the worker last saw.
      return _cachedOrDefault();
    }
  }

  @override
  Future<DisplayPrefs> write(DisplayTheme theme) async {
    // Local first: the toggle must stick even when the server is unreachable.
    final DisplayPrefs local = DisplayPrefs(theme: theme, themeOpen: true);
    _memo = local;
    await _writeCache(local);

    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) {
      await _setPending(true);
      return local;
    }
    try {
      final Map<String, dynamic> json = await _api.updateDisplayPrefs(
        theme: theme.wire,
        authToken: token,
      );
      final DisplayPrefs prefs = DisplayPrefs.fromJson(json);
      _memo = prefs;
      await _writeCache(prefs);
      await _setPending(false);
      return prefs;
    } on ApiException catch (e) {
      if (e.statusCode == 404) {
        // The switch closed between the GET and the PATCH: roll back to Light.
        await _clearCache();
        return DisplayPrefs.closed;
      }
      await _setPending(true);
      return local;
    } catch (_) {
      await _setPending(true);
      return local;
    }
  }

  @override
  Future<void> flushPending() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_kPending) != true) return;
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) return;
    final DisplayTheme choice = DisplayTheme.fromWire(
      prefs.getString(_kChoice),
    );
    try {
      final Map<String, dynamic> json = await _api.updateDisplayPrefs(
        theme: choice.wire,
        authToken: token,
      );
      final DisplayPrefs server = DisplayPrefs.fromJson(json);
      _memo = server;
      await _writeCache(server);
      await _setPending(false);
    } on ApiException catch (e) {
      if (e.statusCode == 404) {
        await _clearCache();
      }
      // Other statuses: keep the queue for the next resume.
    } catch (_) {
      // Still offline: keep the queue.
    }
  }

  @override
  void onLogout() {
    _memo = null;
    unawaited(_clearCache());
  }

  Future<DisplayPrefs> _cachedOrDefault() async {
    if (_memo != null) return _memo!;
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final bool open = prefs.getBool(_kOpen) ?? false;
    if (!open) {
      _memo = DisplayPrefs.closed;
      return _memo!;
    }
    final DisplayPrefs cached = DisplayPrefs(
      theme: DisplayTheme.fromWire(prefs.getString(_kChoice)),
      themeOpen: true,
    );
    _memo = cached;
    return cached;
  }

  Future<void> _writeCache(DisplayPrefs prefs) async {
    final SharedPreferences store = await SharedPreferences.getInstance();
    await store.setString(_kChoice, prefs.theme.wire);
    await store.setBool(_kOpen, prefs.themeOpen);
  }

  Future<void> _clearCache() async {
    _memo = null;
    final SharedPreferences store = await SharedPreferences.getInstance();
    await store.remove(_kChoice);
    await store.remove(_kOpen);
    await store.remove(_kPending);
  }

  Future<void> _setPending(bool pending) async {
    final SharedPreferences store = await SharedPreferences.getInstance();
    if (pending) {
      await store.setBool(_kPending, true);
    } else {
      await store.remove(_kPending);
    }
  }

  Future<void> _clearPending() => _setPending(false);
}

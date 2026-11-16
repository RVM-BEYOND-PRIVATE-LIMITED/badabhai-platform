import 'dart:async';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/auth/payer_http.dart';
import '../../../core/auth/payer_token_store.dart';
import '../domain/display_prefs.dart';
import '../domain/display_prefs_repository.dart';

/// [DisplayPrefsRepository] backed by `/payer/me/display-prefs` plus a small
/// SharedPreferences cache. The cache is the first-paint value and the offline
/// queue; the server reply wins whenever it is reachable.
///
/// A 404 is the documented "the switch is closed / the route is absent" answer
/// and forces Light. A network failure is NOT: it keeps the cached choice, so a
/// payer on a bad connection does not watch the app flip to Light.
class DisplayPrefsRepositoryImpl implements DisplayPrefsRepository {
  DisplayPrefsRepositoryImpl(this._http, this._tokens);

  final PayerHttp _http;
  final PayerTokenStore _tokens;

  static const String _kChoice = 'bb_payer_display_theme_choice';
  static const String _kOpen = 'bb_payer_display_theme_open';
  static const String _kPending = 'bb_payer_display_theme_pending';

  static const String _path = '/payer/me/display-prefs';

  DisplayPrefs? _memo;

  @override
  Future<DisplayPrefs> read() async {
    if (!_tokens.hasSession) return _cachedOrDefault();
    try {
      final PayerResponse res =
          await _http.send(PayerMethod.get, _path);
      if (res.statusCode == 404) {
        // The route is absent or the switch is off: Light, no choice.
        await _clearCache();
        return DisplayPrefs.closed;
      }
      if (!res.isSuccess) return _cachedOrDefault();
      final DisplayPrefs prefs = DisplayPrefs.fromJson(res.body);
      _memo = prefs;
      await _writeCache(prefs);
      if (!prefs.themeOpen) {
        await _clearPending();
      } else {
        await flushPending();
      }
      return prefs;
    } catch (_) {
      // Offline / timeout: keep what the payer last saw.
      return _cachedOrDefault();
    }
  }

  @override
  Future<DisplayPrefs> write(DisplayTheme theme) async {
    // Local first: the toggle must stick even when the server is unreachable.
    final DisplayPrefs local = DisplayPrefs(theme: theme, themeOpen: true);
    _memo = local;
    await _writeCache(local);

    if (!_tokens.hasSession) {
      await _setPending(true);
      return local;
    }
    try {
      final PayerResponse res = await _http.send(
        PayerMethod.patch,
        _path,
        body: <String, dynamic>{'theme': theme.wire},
      );
      if (res.statusCode == 404) {
        // The switch closed between the GET and the PATCH: roll back to Light.
        await _clearCache();
        return DisplayPrefs.closed;
      }
      if (!res.isSuccess) {
        await _setPending(true);
        return local;
      }
      final DisplayPrefs prefs = DisplayPrefs.fromJson(res.body);
      _memo = prefs;
      await _writeCache(prefs);
      await _setPending(false);
      return prefs;
    } catch (_) {
      await _setPending(true);
      return local;
    }
  }

  @override
  Future<void> flushPending() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_kPending) != true) return;
    if (!_tokens.hasSession) return;
    final DisplayTheme choice = DisplayTheme.fromWire(
      prefs.getString(_kChoice),
    );
    try {
      final PayerResponse res = await _http.send(
        PayerMethod.patch,
        _path,
        body: <String, dynamic>{'theme': choice.wire},
      );
      if (res.statusCode == 404) {
        await _clearCache();
        return;
      }
      if (!res.isSuccess) return;
      final DisplayPrefs server = DisplayPrefs.fromJson(res.body);
      _memo = server;
      await _writeCache(server);
      await _setPending(false);
    } catch (_) {
      // Still offline: keep the queue for the next resume.
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

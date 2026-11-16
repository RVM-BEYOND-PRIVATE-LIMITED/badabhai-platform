import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/features/account/data/display_prefs_repository_impl.dart';
import 'package:payer_app/features/account/domain/display_prefs.dart';

typedef _Handler = Future<http.Response> Function(http.Request request);

class _Harness {
  _Harness() {
    client = MockClient((http.Request request) {
      seen.add(request);
      return handler(request);
    });
    final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
    // ignore: discarded_futures
    tokens.save(accessToken: 'tok-abc', payerId: 'p', role: 'employer');
    repo = DisplayPrefsRepositoryImpl(
      PayerHttp(
        baseUrl: 'http://api.test',
        tokenStore: tokens,
        client: client,
      ),
      tokens,
    );
  }

  late final MockClient client;
  late final DisplayPrefsRepositoryImpl repo;
  final List<http.Request> seen = <http.Request>[];
  _Handler handler =
      (http.Request _) async => _json(<String, dynamic>{
            'theme': 'light',
            'theme_open': true,
          });
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('GET open returns and caches the server choice', () async {
    final _Harness h = _Harness();
    h.handler = (_) async => _json(<String, dynamic>{
          'theme': 'dark',
          'theme_open': true,
        });

    final DisplayPrefs prefs = await h.repo.read();
    expect(prefs.theme, DisplayTheme.dark);
    expect(prefs.themeOpen, isTrue);
    expect(h.seen.single.method, 'GET');
    expect(h.seen.single.url.path, '/payer/me/display-prefs');

    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getString('bb_payer_display_theme_choice'), 'dark');
    expect(store.getBool('bb_payer_display_theme_open'), isTrue);
  });

  test('GET 404 means Light and clears any kept choice', () async {
    final _Harness h = _Harness();
    h.handler = (_) async => _json(<String, dynamic>{}, 404);

    final DisplayPrefs prefs = await h.repo.read();
    expect(prefs, DisplayPrefs.closed);

    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getString('bb_payer_display_theme_choice'), isNull);
  });

  test('a network failure keeps the cached choice', () async {
    final _Harness h = _Harness();
    h.handler = (_) async => _json(<String, dynamic>{
          'theme': 'system',
          'theme_open': true,
        });
    await h.repo.read();

    h.handler = (_) async => throw http.ClientException('offline');
    final DisplayPrefs prefs = await h.repo.read();
    expect(prefs.theme, DisplayTheme.system);
    expect(prefs.themeOpen, isTrue);
  });

  test('PATCH saves the choice and returns the server reply', () async {
    final _Harness h = _Harness();
    h.handler = (http.Request req) async {
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      return _json(<String, dynamic>{
        'theme': body['theme'],
        'theme_open': true,
      });
    };

    final DisplayPrefs prefs = await h.repo.write(DisplayTheme.dark);
    expect(h.seen.single.method, 'PATCH');
    expect(jsonDecode(h.seen.single.body), <String, dynamic>{'theme': 'dark'});
    expect(prefs.theme, DisplayTheme.dark);
    expect(prefs.themeOpen, isTrue);
  });

  test('PATCH 404 rolls back to Light, no choice', () async {
    final _Harness h = _Harness();
    h.handler = (_) async => _json(<String, dynamic>{}, 404);

    final DisplayPrefs prefs = await h.repo.write(DisplayTheme.dark);
    expect(prefs, DisplayPrefs.closed);
  });

  test('an offline PATCH is queued and flushed on the next resume', () async {
    final _Harness h = _Harness();
    h.handler = (_) async => throw http.ClientException('offline');

    final DisplayPrefs local = await h.repo.write(DisplayTheme.dark);
    expect(local.theme, DisplayTheme.dark);
    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getBool('bb_payer_display_theme_pending'), isTrue);

    h.handler = (http.Request req) async {
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      return _json(<String, dynamic>{
        'theme': body['theme'],
        'theme_open': true,
      });
    };
    await h.repo.flushPending();
    expect(store.getBool('bb_payer_display_theme_pending'), isNull);
  });

  test('logout drops the cache', () async {
    final _Harness h = _Harness();
    h.handler = (_) async => _json(<String, dynamic>{
          'theme': 'dark',
          'theme_open': true,
        });
    await h.repo.read();
    h.repo.onLogout();
    // onLogout clears the device cache best-effort (the interface is void).
    await Future<void>.delayed(const Duration(milliseconds: 10));

    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getString('bb_payer_display_theme_choice'), isNull);
    expect(store.getBool('bb_payer_display_theme_open'), isNull);
  });
}

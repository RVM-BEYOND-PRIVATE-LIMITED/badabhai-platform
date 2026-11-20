import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/settings/data/display_prefs_repository_impl.dart';
import 'package:badabhai_worker_app/features/settings/domain/display_prefs.dart';

class _FakeApi extends ApiClient {
  _FakeApi() : super(baseUrl: 'test://display-prefs');

  Map<String, dynamic>? getReply;
  Map<String, dynamic>? patchReply;
  Object? getError;
  Object? patchError;
  int gets = 0;
  int patched = 0;
  String? lastTheme;

  @override
  Future<Map<String, dynamic>> getDisplayPrefs({
    required String authToken,
  }) async {
    gets++;
    if (getError != null) throw getError!;
    return getReply!;
  }

  @override
  Future<Map<String, dynamic>> updateDisplayPrefs({
    required String theme,
    required String authToken,
  }) async {
    patched++;
    lastTheme = theme;
    if (patchError != null) throw patchError!;
    return patchReply ?? <String, dynamic>{
      'theme': theme,
      'theme_open': true,
    };
  }
}

SessionRepository _session() {
  final SessionRepository session = SessionRepository();
  session.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 't');
  return session;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('GET open returns and caches the server choice', () async {
    final _FakeApi api = _FakeApi()
      ..getReply = <String, dynamic>{
        'theme': 'dark',
        'theme_open': true,
      };
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );

    final DisplayPrefs prefs = await repo.read();
    expect(prefs.theme, DisplayTheme.dark);
    expect(prefs.themeOpen, isTrue);

    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getString('bb_display_theme_choice'), 'dark');
    expect(store.getBool('bb_display_theme_open'), isTrue);
  });

  test('GET 404 means Light and clears any kept choice', () async {
    final _FakeApi api = _FakeApi()
      ..getError = ApiException(404, 'not found');
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );

    final DisplayPrefs prefs = await repo.read();
    expect(prefs, DisplayPrefs.closed);

    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getString('bb_display_theme_choice'), isNull);
  });

  test('a network failure keeps the cached choice', () async {
    final _FakeApi api = _FakeApi()
      ..getReply = <String, dynamic>{
        'theme': 'system',
        'theme_open': true,
      };
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );
    await repo.read();

    api.getError = Exception('offline');
    final DisplayPrefs prefs = await repo.read();
    expect(prefs.theme, DisplayTheme.system);
    expect(prefs.themeOpen, isTrue);
  });

  test('PATCH saves the choice and returns the server reply', () async {
    final _FakeApi api = _FakeApi();
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );

    final DisplayPrefs prefs = await repo.write(DisplayTheme.dark);
    expect(api.patched, 1);
    expect(api.lastTheme, 'dark');
    expect(prefs.theme, DisplayTheme.dark);
    expect(prefs.themeOpen, isTrue);
  });

  test('PATCH 404 rolls back to Light, no choice', () async {
    final _FakeApi api = _FakeApi()
      ..patchError = ApiException(404, 'closed');
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );

    final DisplayPrefs prefs = await repo.write(DisplayTheme.dark);
    expect(prefs, DisplayPrefs.closed);
  });

  test('an offline PATCH is queued and flushed on the next resume', () async {
    final _FakeApi api = _FakeApi()
      ..patchError = Exception('offline');
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );

    final DisplayPrefs local = await repo.write(DisplayTheme.dark);
    expect(local.theme, DisplayTheme.dark);
    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getBool('bb_display_theme_pending'), isTrue);

    api.patchError = null;
    await repo.flushPending();
    expect(api.patched, 2);
    expect(store.getBool('bb_display_theme_pending'), isNull);
  });

  test('logout drops the cache', () async {
    final _FakeApi api = _FakeApi()
      ..getReply = <String, dynamic>{
        'theme': 'dark',
        'theme_open': true,
      };
    final DisplayPrefsRepositoryImpl repo = DisplayPrefsRepositoryImpl(
      api,
      _session(),
    );
    await repo.read();
    repo.onLogout();
    // onLogout clears the device cache best-effort (the interface is void).
    await Future<void>.delayed(const Duration(milliseconds: 10));

    final SharedPreferences store = await SharedPreferences.getInstance();
    expect(store.getString('bb_display_theme_choice'), isNull);
    expect(store.getBool('bb_display_theme_open'), isNull);
  });
}

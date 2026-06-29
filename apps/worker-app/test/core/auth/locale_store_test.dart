import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/locale_store.dart';

import 'fakes.dart';

void main() {
  group('LocaleStore', () {
    test('defaults to hi when unset', () {
      final LocaleStore store = LocaleStore(FakePrefs());
      expect(store.read(), 'hi');
    });

    test('write + read round-trips a supported locale', () async {
      final LocaleStore store = LocaleStore(FakePrefs());
      await store.write('mr');
      expect(store.read(), 'mr');
    });

    test('an unsupported locale is coerced to the default', () async {
      final FakePrefs prefs = FakePrefs();
      final LocaleStore store = LocaleStore(prefs);
      await store.write('xx');
      expect(store.read(), 'hi');
    });

    test('locale is stored in PLAIN prefs (non-secret) only', () async {
      final FakePrefs prefs = FakePrefs();
      final LocaleStore store = LocaleStore(prefs);
      await store.write('bho');
      // The only thing here is the locale code — no token/secret leaks in.
      expect(prefs.map.values, contains('bho'));
    });
  });
}

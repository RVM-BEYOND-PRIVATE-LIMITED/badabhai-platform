import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/referral/pending_referral_store.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/notifications/data/notification_read_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../auth/fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SharedPrefsKnownWorkerFactsStore', () {
    setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{
          // A neighbouring key clearAll must never touch.
          'bb_locale': 'hi',
        }));

    test('round trip survives a cold start and stores fact NAMES only',
        () async {
      const SharedPrefsKnownWorkerFactsStore store =
          SharedPrefsKnownWorkerFactsStore();
      await store.record(WorkerFact.currentCity);
      await store.record(WorkerFact.currentCity);
      await store.record(WorkerFact.shift);

      const SharedPrefsKnownWorkerFactsStore reborn =
          SharedPrefsKnownWorkerFactsStore();
      expect(await reborn.knownFacts(),
          <WorkerFact>{WorkerFact.currentCity, WorkerFact.shift});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(prefs.getStringList(SharedPrefsKnownWorkerFactsStore.kKey),
          unorderedEquals(<String>['currentCity', 'shift']));
    });

    test('clearAll removes the facts and nothing else', () async {
      const SharedPrefsKnownWorkerFactsStore store =
          SharedPrefsKnownWorkerFactsStore();
      await store.record(WorkerFact.salary);

      await store.clearAll();

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), <String>{'bb_locale'});
      expect(await store.knownFacts(), isEmpty);
    });

    test('a storage failure is swallowed on every method', () async {
      final SharedPrefsKnownWorkerFactsStore broken =
          SharedPrefsKnownWorkerFactsStore(
        prefs: () async => throw StateError('plugin unavailable'),
      );

      await broken.record(WorkerFact.currentCity);
      await broken.clearAll();
      expect(await broken.knownFacts(), isEmpty);
    });
  });

  test('logout clears what the previous worker told us', () async {
    await locator.reset();
    addTearDown(locator.reset);
    final InMemoryKnownWorkerFactsStore facts =
        InMemoryKnownWorkerFactsStore(<WorkerFact>[WorkerFact.currentCity]);
    setupLocator(apiClient: MockApiClient(), secureStore: FakeSecureStore());
    await initAuthLocator(
      localeStore: LocaleStore(FakePrefs()),
      authApi: MockAuthApi(locator<SecureTokenStore>()),
      readStore: const SessionOnlyNotificationReadStore(),
      pendingReferral: InMemoryPendingReferralStore(),
      knownWorkerFactsStore: facts,
      persistentAuthEnabled: true,
    );
    final AuthSessionManager auth = locator<AuthSessionManager>();
    await auth.bootstrap();
    await auth.verifyOtp('+919876500001', '123456');
    await auth.setPin('1234');

    await auth.logout();
    await Future<void>.delayed(Duration.zero);

    expect(await facts.knownFacts(), isEmpty);
  });
}

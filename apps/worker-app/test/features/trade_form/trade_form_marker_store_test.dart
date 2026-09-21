import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/referral/pending_referral_store.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/notifications/data/notification_read_store.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_marker_store.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/form_fact_registry.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/auth/fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('InMemoryTradeFormMarkerStore', () {
    test('round trip: a recorded marker reads back', () async {
      final InMemoryTradeFormMarkerStore store = InMemoryTradeFormMarkerStore();

      await store.markCompleted(TradeFormMarkerType.preferences);
      await store.markCompleted(TradeFormMarkerType.employment);

      expect(await store.completedMarkers(), <TradeFormMarkerType>{
        TradeFormMarkerType.preferences,
        TradeFormMarkerType.employment,
      });
    });

    test('clearAll forgets every marker', () async {
      final InMemoryTradeFormMarkerStore store = InMemoryTradeFormMarkerStore();
      await store.markCompleted(TradeFormMarkerType.preferences);

      await store.clearAll();

      expect(await store.completedMarkers(), isEmpty);
    });
  });

  group('SharedPrefsTradeFormMarkerStore', () {
    setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{
          // A neighbouring key clearAll must never touch.
          'bb_locale': 'hi',
          // A key sharing the prefix — clearAll's defensive sweep wipes it too.
          'bb_trade_form_markers:cnc_turner:qp_cnc_turning': <String>[
            'preferences',
          ],
        }));

    test('round trip survives a cold start (a fresh store instance)', () async {
      const SharedPrefsTradeFormMarkerStore store =
          SharedPrefsTradeFormMarkerStore();
      await store.markCompleted(TradeFormMarkerType.preferences);
      await store.markCompleted(TradeFormMarkerType.qualifications);

      const SharedPrefsTradeFormMarkerStore reborn =
          SharedPrefsTradeFormMarkerStore();
      expect(await reborn.completedMarkers(), <TradeFormMarkerType>{
        TradeFormMarkerType.preferences,
        TradeFormMarkerType.qualifications,
      });
    });

    test('persists marker TYPES only — never a value the worker entered',
        () async {
      const SharedPrefsTradeFormMarkerStore store =
          SharedPrefsTradeFormMarkerStore();
      await store.markCompleted(TradeFormMarkerType.preferences);
      await store.markCompleted(TradeFormMarkerType.preferences);

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(
        prefs.getStringList(SharedPrefsTradeFormMarkerStore.kKey),
        <String>['preferences'],
      );
    });

    test('clearAll removes every marker key and nothing else', () async {
      const SharedPrefsTradeFormMarkerStore store =
          SharedPrefsTradeFormMarkerStore();
      await store.markCompleted(TradeFormMarkerType.employment);

      await store.clearAll();

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), <String>{'bb_locale'});
      expect(await store.completedMarkers(), isEmpty);
    });

    test('a storage failure is swallowed on every method', () async {
      final SharedPrefsTradeFormMarkerStore broken =
          SharedPrefsTradeFormMarkerStore(
        prefs: () async => throw StateError('plugin unavailable'),
      );

      await broken.markCompleted(TradeFormMarkerType.preferences);
      await broken.clearAll();
      expect(await broken.completedMarkers(), isEmpty);
    });
  });

  group('locator wiring', () {
    late MockApiClient api;
    late InMemoryTradeFormMarkerStore store;
    late AuthSessionManager auth;

    setUp(() async {
      await locator.reset();
      api = MockApiClient();
      store = InMemoryTradeFormMarkerStore();
      setupLocator(apiClient: api, secureStore: FakeSecureStore());
      await initAuthLocator(
        localeStore: LocaleStore(FakePrefs()),
        authApi: MockAuthApi(locator<SecureTokenStore>()),
        readStore: const SessionOnlyNotificationReadStore(),
        pendingReferral: InMemoryPendingReferralStore(),
        tradeFormMarkerStore: store,
        persistentAuthEnabled: true,
      );
      auth = locator<AuthSessionManager>();
      await auth.bootstrap();
      await auth.verifyOtp('+919876500001', '123456');
      await auth.setPin('1234');
    });

    tearDown(() => locator.reset());

    test('the TradeFormCubit factory resumes past a marker the store recorded',
        () async {
      api.mockHasTradeForm = true;
      // Every question the mock form serves before its markers, answered.
      for (final String key in <String>[
        'turning_machine',
        'material_worked',
        'drawing_reading',
      ]) {
        await api.submitTradeFormAnswer(
          authToken: 'unused',
          body: <String, dynamic>{
            'question_key': key,
            'answer': <String, dynamic>{'kind': 'declined'},
          },
        );
      }
      await store.markCompleted(TradeFormMarkerType.preferences);

      final TradeFormCubit cubit = locator<TradeFormCubit>();
      await cubit.load();

      expect(cubit.state.currentStep, isA<TradeFormEmploymentStep>());
      await cubit.close();
    });

    test('logout clears the store, so the next worker on this phone starts '
        'clean', () async {
      await store.markCompleted(TradeFormMarkerType.preferences);
      expect(auth.status, AuthStatus.authenticated);

      await auth.logout();
      await Future<void>.delayed(Duration.zero);

      expect(auth.status, AuthStatus.loggedOut);
      expect(await store.completedMarkers(), isEmpty);
    });
  });
}

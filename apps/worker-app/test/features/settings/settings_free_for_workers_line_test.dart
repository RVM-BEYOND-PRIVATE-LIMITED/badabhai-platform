// #2748 item 7a — the "free for workers" line in Settings: the same line the
// sign-up screen shows, behind the same switch, which ships off.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/free_for_workers_line.dart';
import 'package:badabhai_worker_app/features/settings/presentation/settings_screen.dart';

import '../../core/auth/fakes.dart';
import '../../support/kit_matrix.dart';

class _MockApiClient extends Mock implements ApiClient {}

void main() {
  final Finder line = find.text(kFreeForWorkersText);

  void switchOn() => BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
    BbRemoteConfig.kKeyFreeForWorkersLineVisible: true,
  });

  setUp(() async {
    // The notifications row reads SharedPreferences when it has no session.
    SharedPreferences.setMockInitialValues(<String, Object>{});
    BbRemoteConfig.instance.debugReset();
    final _MockApiClient api = _MockApiClient();
    await locator.reset();
    setupLocator(apiClient: api, secureStore: FakeSecureStore());
    locator<SessionRepository>().setWorker(
      phone: '+910000000000',
      workerId: 'w1',
      sessionToken: 'tok',
    );
    // The employer-contact row loads server truth on mount.
    when(
      () => api.getConsentState(authToken: any(named: 'authToken')),
    ).thenAnswer(
      (_) async => const ConsentStateDto(
        consentId: 'c1',
        purposes: <String>[
          'profiling',
          'employer_sharing',
          'employer_messaging',
        ],
      ),
    );
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  Future<void> pumpSettings(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const SettingsScreen()),
    );
    await tester.pump();
  }

  testWidgets('switched off (the default): no free line', (
    WidgetTester tester,
  ) async {
    await pumpSettings(tester);

    // Down to the footer, past where the line would sit.
    await tester.scrollUntilVisible(
      find.textContaining('Made in India'),
      200,
      scrollable: find.byType(Scrollable),
    );
    expect(line, findsNothing);
    expect(find.byType(FreeForWorkersLine), findsNothing);
  });

  testWidgets('switched on: the line shows above the footer', (
    WidgetTester tester,
  ) async {
    switchOn();
    await pumpSettings(tester);

    // Down to the footer: the line sits just above it.
    await tester.scrollUntilVisible(
      find.textContaining('Made in India'),
      200,
      scrollable: find.byType(Scrollable),
    );
    expect(line, findsOneWidget);
    expect(
      tester.getTopLeft(line).dy,
      lessThan(tester.getTopLeft(find.textContaining('Made in India')).dy),
    );
  });

  group('switched on, on every device size and system font', () {
    setUp(switchOn);

    kitMatrixTest(
      'Settings with the free line',
      () => const SettingsScreen(),
      primary: () => find.text(kFreeForWorkersText),
    );
  });
}

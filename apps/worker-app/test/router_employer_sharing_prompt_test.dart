// The one-time employer-sharing prompt hooks into the HOME SHELL — the only
// place a signed-in worker past onboarding lands — so it can never interrupt
// consent -> chat profiling or the PIN screens. These drive the REAL route
// table with a gate whose server answer is stubbed.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/data/employer_sharing_prompt_store.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_contact.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_sharing_prompt_gate.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/employer_sharing_prompt_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class _MockConsentRepository extends Mock implements ConsentRepository {}

Future<void> _pumpUntil(WidgetTester tester, Finder finder,
    {int maxFrames = 50}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 400));
      return;
    }
  }
  expect(finder, findsWidgets,
      reason: 'timed out (${maxFrames * 100}ms) waiting for $finder');
}

Future<void> _settleFrames(WidgetTester tester, [int frames = 20]) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  late _MockConsentRepository repo;

  /// Swaps the app's gate for one over [repo], signed in as `w1`.
  void installGate() {
    locator.unregister<EmployerSharingPromptGate>();
    locator.registerLazySingleton<EmployerSharingPromptGate>(
      () => EmployerSharingPromptGate(
        repository: repo,
        store: InMemoryEmployerSharingPromptStore(),
        isSignedIn: () => true,
        workerId: () => 'w1',
      ),
    );
  }

  void serverSays({required bool due}) =>
      when(() => repo.employerContactState()).thenAnswer(
        (_) async => EmployerContactInfo(
          enabled: !due,
          purposes: const <String>['profiling'],
          consentId: 'c1',
          consentVersion: due ? '2026-08-28' : '2026-11-04',
        ),
      );

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    repo = _MockConsentRepository();
    installGate();
  });
  tearDown(() async => locator.reset());

  Future<GoRouter> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final GoRouter router = buildAppRouter();
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
    await tester.pump();
    return router;
  }

  testWidgets('the shell opens the prompt for a due worker, once per launch', (
    WidgetTester tester,
  ) async {
    serverSays(due: true);
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, find.byType(EmployerSharingPromptScreen));
    expect(find.byType(EmployerSharingPromptScreen), findsOneWidget);

    await tester.ensureVisible(find.text('Abhi nahi'));
    await tester.tap(find.text('Abhi nahi'));
    await _pumpUntil(tester, find.byType(ProfileTabScreen));
    expect(find.byType(EmployerSharingPromptScreen), findsNothing);

    // Leave the shell and come back: the shell remounts, the gate does not
    // ask the server again this launch.
    router.go(Routes.invite);
    await _settleFrames(tester);
    router.go(Routes.profile);
    await _settleFrames(tester);
    expect(find.byType(EmployerSharingPromptScreen), findsNothing);
    verify(() => repo.employerContactState()).called(1);
  });

  testWidgets('a worker who is not due never sees it', (
    WidgetTester tester,
  ) async {
    serverSays(due: false);
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, find.byType(ProfileTabScreen));
    await _settleFrames(tester);

    expect(find.byType(EmployerSharingPromptScreen), findsNothing);
    verify(() => repo.employerContactState()).called(1);
  });

  testWidgets('the onboarding consent step never triggers it', (
    WidgetTester tester,
  ) async {
    serverSays(due: true);
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.consent);
    await _pumpUntil(tester, find.byType(ConsentScreen));
    await _settleFrames(tester);

    expect(find.byType(EmployerSharingPromptScreen), findsNothing);
    verifyNever(() => repo.employerContactState());
  });
}

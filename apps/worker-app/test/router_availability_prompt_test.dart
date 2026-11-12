// #2748 item 1d — the availability ask hooks into the HOME SHELL, the only
// place a signed-in worker past onboarding lands, behind a Remote Config switch
// that ships off. These drive the REAL route table, with the work-preferences
// reads and write stubbed.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkAvailabilityDto, WorkPrefOptionsDto, WorkPreferencesDto;
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_gate.dart';
import 'package:badabhai_worker_app/features/availability_prompt/presentation/availability_prompt_sheet.dart';
import 'package:badabhai_worker_app/features/consent/data/employer_sharing_prompt_store.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_contact.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_sharing_prompt_gate.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/employer_sharing_prompt_screen.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

class _MockConsentRepository extends Mock implements ConsentRepository {}

Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  int maxFrames = 50,
}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 400));
      return;
    }
  }
  expect(
    finder,
    findsWidgets,
    reason: 'timed out (${maxFrames * 100}ms) waiting for $finder',
  );
}

Future<void> _settleFrames(WidgetTester tester, [int frames = 20]) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  late _MockProfileEditRepository prefs;

  final Finder sheet = find.text(kAvailabilityPromptTitle);

  /// Swaps the app's work-preferences repository and the gate for ones over
  /// [prefs], signed in as `w1`. The gate keeps its REAL Remote Config switch.
  void installAvailabilityGate() {
    locator.unregister<ProfileEditRepository>();
    locator.registerLazySingleton<ProfileEditRepository>(() => prefs);
    locator.unregister<AvailabilityPromptGate>();
    locator.registerLazySingleton<AvailabilityPromptGate>(
      () => AvailabilityPromptGate(
        repository: prefs,
        isSignedIn: () => true,
        workerId: () => 'w1',
      ),
    );
  }

  void switchOn() => BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
    BbRemoteConfig.kKeyAvailabilityPromptEnabled: true,
  });

  void storedAvailability(WorkAvailabilityDto? availability) => when(
    () => prefs.loadWorkPreferences(),
  ).thenAnswer((_) async => WorkPreferencesDto(availability: availability));

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    prefs = _MockProfileEditRepository();
    when(() => prefs.loadWorkPreferenceOptions()).thenAnswer(
      (_) async => const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
        availabilityStatus: <String, String>{
          'immediate': 'Immediately',
          'within_week': 'Within a week',
          'within_month': 'Within a month',
          'serving_notice': 'Serving notice',
        },
      ),
    );
    when(() => prefs.saveWorkPreferences(any())).thenAnswer((_) async {});
    installAvailabilityGate();
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  Future<GoRouter> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final GoRouter router = buildAppRouter();
    await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
    );
    await tester.pump();
    return router;
  }

  testWidgets(
    'switched on: an empty availability is asked once on shell entry, and '
    'not again this session after "Abhi nahi"',
    (WidgetTester tester) async {
      switchOn();
      storedAvailability(null);
      final GoRouter router = await pumpApp(tester);

      router.go(Routes.profile);
      await _pumpUntil(tester, sheet);
      expect(sheet, findsOneWidget);

      await tester.tap(find.text(kAvailabilityPromptNotNowLabel));
      await _settleFrames(tester);
      expect(sheet, findsNothing);
      expect(find.byType(ProfileTabScreen), findsOneWidget);

      // Leave the shell and come back: the shell remounts, the gate does not
      // ask the server again this launch.
      router.go(Routes.invite);
      await _settleFrames(tester);
      router.go(Routes.profile);
      await _settleFrames(tester);
      expect(sheet, findsNothing);
      verify(() => prefs.loadWorkPreferences()).called(1);
      verifyNever(() => prefs.saveWorkPreferences(any()));
    },
  );

  testWidgets('a pick is saved through PUT /workers/me/work-preferences', (
    WidgetTester tester,
  ) async {
    switchOn();
    storedAvailability(null);
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, sheet);
    await tester.tap(find.text('Within a month'));
    await tester.pump();
    await tester.tap(find.byKey(kAvailabilityPromptSaveKey));
    await _settleFrames(tester);

    verify(
      () => prefs.saveWorkPreferences(<String, dynamic>{
        'touched_only': true,
        'availability': <String, dynamic>{
          'status': 'within_month',
          'available_from': null,
          'notice_period_days': null,
        },
      }),
    ).called(1);
    expect(sheet, findsNothing);
    expect(find.text(kAvailabilityPromptSavedMessage), findsOneWidget);
  });

  testWidgets('switched off (the default): never asks, and reads nothing', (
    WidgetTester tester,
  ) async {
    storedAvailability(null);
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, find.byType(ProfileTabScreen));
    await _settleFrames(tester);

    expect(sheet, findsNothing);
    verifyNever(() => prefs.loadWorkPreferences());
  });

  testWidgets('a worker whose availability is set is never asked', (
    WidgetTester tester,
  ) async {
    switchOn();
    storedAvailability(const WorkAvailabilityDto(status: 'immediate'));
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, find.byType(ProfileTabScreen));
    await _settleFrames(tester);

    expect(sheet, findsNothing);
    verify(() => prefs.loadWorkPreferences()).called(1);
    verifyNever(() => prefs.loadWorkPreferenceOptions());
  });

  testWidgets('the onboarding consent step never triggers it', (
    WidgetTester tester,
  ) async {
    switchOn();
    storedAvailability(null);
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.consent);
    await _pumpUntil(tester, find.byType(ConsentScreen));
    await _settleFrames(tester);

    expect(sheet, findsNothing);
    verifyNever(() => prefs.loadWorkPreferences());
  });

  testWidgets(
    'never stacked on the employer-sharing prompt: one prompt per shell '
    'entry',
    (WidgetTester tester) async {
      final _MockConsentRepository consent = _MockConsentRepository();
      when(() => consent.employerContactState()).thenAnswer(
        (_) async => const EmployerContactInfo(
          enabled: false,
          purposes: <String>['profiling'],
          consentId: 'c1',
          consentVersion: '2026-08-28',
        ),
      );
      locator.unregister<EmployerSharingPromptGate>();
      locator.registerLazySingleton<EmployerSharingPromptGate>(
        () => EmployerSharingPromptGate(
          repository: consent,
          store: InMemoryEmployerSharingPromptStore(),
          isSignedIn: () => true,
          workerId: () => 'w1',
        ),
      );
      switchOn();
      storedAvailability(null);
      final GoRouter router = await pumpApp(tester);

      router.go(Routes.profile);
      await _pumpUntil(tester, find.byType(EmployerSharingPromptScreen));
      expect(sheet, findsNothing);
      verifyNever(() => prefs.loadWorkPreferences());

      await tester.ensureVisible(find.text('Abhi nahi'));
      await tester.tap(find.text('Abhi nahi'));
      await _pumpUntil(tester, find.byType(ProfileTabScreen));
      await _settleFrames(tester);
      expect(
        sheet,
        findsNothing,
        reason: 'the employer prompt already had this entry',
      );

      // The NEXT shell entry is the availability prompt's turn.
      router.go(Routes.invite);
      await _settleFrames(tester);
      router.go(Routes.profile);
      await _pumpUntil(tester, sheet);
      expect(find.byType(EmployerSharingPromptScreen), findsNothing);
    },
  );
}

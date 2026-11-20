// #2753 item 5 — the monthly "still looking?" card hooks into the HOME SHELL,
// the only place a signed-in worker past onboarding lands, so it can never
// interrupt consent -> chat profiling or the PIN screens. These drive the REAL
// route table with the server answer stubbed.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/still_looking/domain/still_looking_repository.dart';
import 'package:badabhai_worker_app/features/still_looking/presentation/widgets/still_looking_sheet.dart';
import 'package:badabhai_worker_app/router.dart';

class _FakeStillLookingRepository implements StillLookingRepository {
  int reads = 0;
  int answers = 0;
  StillLookingAnswer? lastAnswer;

  @override
  Future<StillLookingDto> read() async {
    reads += 1;
    return StillLookingDto(
      due: answers == 0,
      checkId: answers == 0 ? 'check-1' : null,
      availabilityNeedsAnswer: false,
      lastActiveOn: '2026-11-20',
      notRecentlyActive: false,
    );
  }

  @override
  Future<StillLookingDto> answer(StillLookingAnswer answer) async {
    answers += 1;
    lastAnswer = answer;
    return const StillLookingDto(
      due: false,
      availabilityNeedsAnswer: false,
      lastActiveOn: '2026-11-20',
      notRecentlyActive: false,
    );
  }
}

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

void main() {
  late _FakeStillLookingRepository stillLooking;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    stillLooking = _FakeStillLookingRepository();
    locator.unregister<StillLookingRepository>();
    locator.registerLazySingleton<StillLookingRepository>(() => stillLooking);
  });

  tearDown(() async {
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

  testWidgets('a due check opens the monthly card once on shell entry; one tap '
      'answers it', (WidgetTester tester) async {
    final GoRouter router = await pumpApp(tester);

    router.go(Routes.profile);
    await _pumpUntil(tester, find.text(kStillLookingTitle));
    expect(find.text(kStillLookingTitle), findsOneWidget);
    expect(find.text(kStillLookingYesLabel), findsOneWidget);

    await tester.tap(find.byKey(kStillLookingYesKey));
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    expect(find.text(kStillLookingTitle), findsNothing);
    expect(stillLooking.answers, 1);
    expect(stillLooking.lastAnswer, StillLookingAnswer.yes);

    // A second shell entry does not re-ask: the server now says not due.
    router.go(Routes.invite);
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    router.go(Routes.profile);
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text(kStillLookingTitle), findsNothing);
    expect(stillLooking.answers, 1);
  });
}

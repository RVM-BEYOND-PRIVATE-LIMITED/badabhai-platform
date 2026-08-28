// The consent screen has TWO arrivals, and they must not behave the same way.
//
// ONBOARDING (the default, #381): consent is the first step, there is no back
// button, and accepting continues into /name → the profiling interview.
//
// RECOVERY (pushed with a [ConsentReturnIntent]): a worker was in the middle of
// using a screen — today, writing a feedback report — and it pushed consent to
// unblock itself. That worker is already onboarded. Replacing the stack left
// them on a consent page with no back button, and accepting carried them into
// the name step and an interview they finished long ago. So this arrival gets a
// back arrow and pops its outcome instead.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';

class _MockConsentRepository extends Mock implements ConsentRepository {}

void main() {
  late _MockConsentRepository repo;

  setUpAll(() => registerFallbackValue(const <String>[]));

  setUp(() async {
    await locator.reset();
    repo = _MockConsentRepository();
    when(() => repo.acceptConsent(purposes: any(named: 'purposes')))
        .thenAnswer((_) async {});
    locator.registerFactory<ConsentCubit>(() => ConsentCubit(repo));
  });

  tearDown(() => locator.reset());

  /// The real route wiring: /caller pushes /consent, optionally handing over the
  /// recovery marker, and /name stands in for the onboarding continuation.
  ///
  /// [ConsentScreen.fromExtra] is the SAME entry point `router.dart` uses, so
  /// the rule that reads the marker is under test here rather than restated —
  /// a test that constructed `ConsentScreen(returnToCaller: true)` directly
  /// would never notice that rule being dropped.
  Future<GoRouter> pump(WidgetTester tester, {required bool recovery}) async {
    final GoRouter router = GoRouter(
      initialLocation: '/caller',
      routes: <RouteBase>[
        GoRoute(
          path: '/caller',
          builder: (_, __) => Scaffold(
            body: Builder(
              builder: (BuildContext c) => TextButton(
                onPressed: () => c.push('/consent',
                    extra: recovery ? const ConsentReturnIntent() : null),
                child: const Text('OPEN CONSENT'),
              ),
            ),
          ),
        ),
        GoRoute(
          path: '/consent',
          builder: (_, GoRouterState s) => ConsentScreen.fromExtra(s.extra),
        ),
        GoRoute(
          path: '/name',
          builder: (_, __) =>
              const Scaffold(body: Center(child: Text('NAME STEP'))),
        ),
      ],
    );
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
    await tester.tap(find.text('OPEN CONSENT'));
    await tester.pumpAndSettle();
    return router;
  }

  Future<void> agreeAndContinue(WidgetTester tester) async {
    // The DPDP voice notice (#1270) is long enough that the checkbox now sits
    // below the fold on the test surface — scroll it into view first, exactly
    // what a real worker does before ticking it.
    await tester.ensureVisible(find.byType(Checkbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
  }

  group('the ONBOARDING arrival is untouched (#381)', () {
    testWidgets('no back button — a gate you pass through once', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);
      expect(find.text('Your privacy'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_back), findsNothing);
    });

    testWidgets('accepting continues into the name step', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);
      await agreeAndContinue(tester);

      expect(find.text('NAME STEP'), findsOneWidget);
      verify(() => repo.acceptConsent(
          purposes: <String>['profiling', 'resume_generation', 'voice_processing']))
          .called(1);
    });
  });

  group('the RECOVERY arrival can be declined and never hijacks onboarding', () {
    testWidgets('it offers a way back', (WidgetTester tester) async {
      await pump(tester, recovery: true);
      expect(find.byIcon(Icons.arrow_back), findsOneWidget,
          reason: 'a worker pushed here mid-task must be able to decline');
    });

    testWidgets('the back arrow returns false to the caller and records NOTHING',
        (WidgetTester tester) async {
      await pump(tester, recovery: true);

      await tester.tap(find.byIcon(Icons.arrow_back));
      await tester.pumpAndSettle();

      expect(find.text('OPEN CONSENT'), findsOneWidget);
      expect(find.text('Your privacy'), findsNothing);
      // Backing out is not consent. Nothing may be written on the way out.
      verifyNever(() => repo.acceptConsent(purposes: any(named: 'purposes')));
    });

    testWidgets('accepting POPS back to the caller — never on into /name', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: true);
      await agreeAndContinue(tester);

      // The consent itself is still recorded exactly once — the recovery path
      // changes where the worker LANDS, never whether consent was given.
      verify(() => repo.acceptConsent(
          purposes: <String>['profiling', 'resume_generation', 'voice_processing']))
          .called(1);
      expect(find.text('NAME STEP'), findsNothing,
          reason: 'an onboarded worker must not be walked back through '
              'onboarding to send one piece of feedback');
      expect(find.text('OPEN CONSENT'), findsOneWidget);
    });
  });
}

// The consent screen has TWO arrivals, and they must not behave the same way.
//
// ONBOARDING (the default, #381): consent is the first step, there is no back
// button, and accepting continues into the chat profiling step — the chat asks
// for the name (#1864) and for the resume (#2188) itself, so /resume-upload is
// no longer the handover (it stays registered for menu/deep-links and older
// builds).
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
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/employer_sharing_notice.dart';

class _MockConsentRepository extends Mock implements ConsentRepository {}

class _MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// What the screen's one tick grants (2026-11-04).
const List<String> _kPurposes = <String>[
  'profiling',
  'resume_generation',
  'voice_processing',
  'employer_sharing',
  'employer_messaging',
];

void main() {
  late _MockConsentRepository repo;

  setUpAll(() {
    registerFallbackValue(const <String>[]);
    registerFallbackValue(false);
  });

  setUp(() async {
    await locator.reset();
    repo = _MockConsentRepository();
    when(
      () => repo.acceptConsent(
        purposes: any(named: 'purposes'),
        age18Plus: any(named: 'age18Plus'),
      ),
    ).thenAnswer((_) async {});
    locator.registerFactory<ConsentCubit>(() => ConsentCubit(repo));
  });

  tearDown(() => locator.reset());

  /// The real route wiring: /caller pushes /consent, optionally handing over the
  /// recovery marker, and /chat stands in for the onboarding continuation.
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
                onPressed: () => c.push(
                  '/consent',
                  extra: recovery ? const ConsentReturnIntent() : null,
                ),
                child: const Text('OPEN CONSENT'),
              ),
            ),
          ),
        ),
        GoRoute(
          path: '/consent',
          builder: (_, GoRouterState s) => ConsentScreen.fromExtra(s.extra),
        ),
        // #2188 — consent hands straight to the chat profiling step; the chat
        // asks for the name (#1864) and for the resume itself. `/name` stays
        // declared here so this test can still assert nothing goes there.
        GoRoute(
          path: '/chat',
          builder: (_, __) =>
              const Scaffold(body: Center(child: Text('CHAT STEP'))),
        ),
        GoRoute(
          path: '/resume-upload',
          builder: (_, __) =>
              const Scaffold(body: Center(child: Text('UPLOAD STEP'))),
        ),
        GoRoute(
          path: '/name',
          builder: (_, __) =>
              const Scaffold(body: Center(child: Text('NAME STEP'))),
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
    );
    await tester.tap(find.text('OPEN CONSENT'));
    await tester.pumpAndSettle();
    return router;
  }

  Future<void> agreeAndContinue(
    WidgetTester tester, {
    bool over18 = true,
  }) async {
    // The DPDP voice notice (#1270) is long enough that the checkbox now sits
    // below the fold on the test surface — scroll it into view first, exactly
    // what a real worker does before ticking it.
    await tester.ensureVisible(find.text('Haan, 18+ hoon'));
    await tester.pumpAndSettle();
    if (over18) {
      await tester.tap(find.text('Haan, 18+ hoon'));
    } else {
      await tester.tap(find.text('Nahi'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Haan').last);
    }
    await tester.pump();
    await tester.ensureVisible(find.byType(Checkbox));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.tap(find.text('Aage Badhein'));
    await tester.pumpAndSettle();
  }

  group('the ONBOARDING arrival is untouched (#381)', () {
    testWidgets('no back button — a gate you pass through once', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);
      expect(find.text('YOUR PRIVACY'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_back_rounded), findsNothing);
      // Icon-agnostic too: no 'Wapas' back control of ANY glyph.
      expect(find.byTooltip('Wapas'), findsNothing);
    });

    testWidgets('accepting continues into the chat profiling step', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);
      await agreeAndContinue(tester);

      // #2188 — consent hands straight to the chat; the name form is retired
      // (the chat asks instead) and the upload comes from the chat's own
      // resume chips, not from this handover.
      expect(find.text('CHAT STEP'), findsOneWidget);
      expect(
        find.text('NAME STEP'),
        findsNothing,
        reason: 'the name form is retired — the chat asks instead',
      );
      expect(
        find.text('UPLOAD STEP'),
        findsNothing,
        reason: 'the upload is offered inside the chat now, not here',
      );
      verify(
        () => repo.acceptConsent(
          purposes: _kPurposes,
          age18Plus: true,
        ),
      ).called(1);
    });
  });

  group(
    'the RECOVERY arrival can be declined and never hijacks onboarding',
    () {
      testWidgets('it offers a way back', (WidgetTester tester) async {
        await pump(tester, recovery: true);
        expect(
          find.byIcon(Icons.arrow_back_rounded),
          findsOneWidget,
          reason: 'a worker pushed here mid-task must be able to decline',
        );
        expect(find.byTooltip('Wapas'), findsOneWidget);
      });

      testWidgets(
        'the back arrow returns false to the caller and records NOTHING',
        (WidgetTester tester) async {
          await pump(tester, recovery: true);

          await tester.tap(find.byIcon(Icons.arrow_back_rounded));
          await tester.pumpAndSettle();

          expect(find.text('OPEN CONSENT'), findsOneWidget);
          expect(find.text('YOUR PRIVACY'), findsNothing);
          // Backing out is not consent. Nothing may be written on the way out.
          verifyNever(
            () => repo.acceptConsent(
              purposes: any(named: 'purposes'),
              age18Plus: any(named: 'age18Plus'),
            ),
          );
        },
      );

      testWidgets('accepting POPS back to the caller — never on into /name', (
        WidgetTester tester,
      ) async {
        await pump(tester, recovery: true);
        await agreeAndContinue(tester);

        // The consent itself is still recorded exactly once — the recovery path
        // changes where the worker LANDS, never whether consent was given.
        verify(
          () => repo.acceptConsent(
            purposes: _kPurposes,
            age18Plus: true,
          ),
        ).called(1);
        expect(
          find.text('NAME STEP'),
          findsNothing,
          reason:
              'an onboarded worker must not be walked back through '
              'onboarding to send one piece of feedback',
        );
        expect(find.text('OPEN CONSENT'), findsOneWidget);
      });
    },
  );

  group('the 18+ age question gates every new consent', () {
    testWidgets('cannot continue with only the DPDP tick', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);

      await tester.ensureVisible(find.byType(Checkbox));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Checkbox));
      await tester.pump();

      await tester.ensureVisible(find.text('Aage Badhein'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Aage Badhein'));
      await tester.pumpAndSettle();

      expect(find.text('CHAT STEP'), findsNothing);
      verifyNever(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      );
    });

    testWidgets('"Nahi" asks for confirmation first', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);

      await tester.ensureVisible(find.text('Nahi'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nahi'));
      await tester.pumpAndSettle();

      expect(find.text('Pakka?'), findsOneWidget);
      expect(
        find.text(
          'Pakka? 18 saal se kam hone par abhi profile nahi ban sakti.',
        ),
        findsOneWidget,
      );

      // Backing out leaves the answer unset: the gate still holds.
      await tester.tap(find.text('Nahi').last);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byType(Checkbox));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Checkbox));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage Badhein'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Aage Badhein'));
      await tester.pumpAndSettle();

      expect(find.text('CHAT STEP'), findsNothing);
      verifyNever(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      );
    });

    testWidgets(
      'confirmed under-18 sends false, shows the terminal screen, and discards '
      'the local session on acknowledge',
      (WidgetTester tester) async {
        when(
          () => repo.acceptConsent(
            purposes: any(named: 'purposes'),
            age18Plus: any(named: 'age18Plus'),
          ),
        ).thenThrow(const AgeBelowMinimumFailure());
        final _MockAuthSessionManager auth = _MockAuthSessionManager();
        when(auth.discardSession).thenAnswer((_) async {});
        locator.registerSingleton<AuthSessionManager>(auth);

        await pump(tester, recovery: false);
        await agreeAndContinue(tester, over18: false);

        expect(find.text('18 saal ke baad aana'), findsOneWidget);
        expect(find.text('Aage Badhein'), findsNothing);
        verify(
          () => repo.acceptConsent(
            purposes: _kPurposes,
            age18Plus: false,
          ),
        ).called(1);

        await tester.tap(find.text('Theek hai'));
        await tester.pumpAndSettle();
        verify(() => auth.discardSession()).called(1);
      },
    );
  });

  // 2026-11-04 — the employer-sharing notice is its own card, and the ONE tick
  // below both cards grants both.
  group('the employer-sharing card (approved 2026-11-04)', () {
    testWidgets('renders the approved heading and key bold claims verbatim', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);

      expect(find.byType(EmployerSharingNotice), findsOneWidget);
      expect(
        find.text('Companies aapki profile dekh sakti hain'),
        findsOneWidget,
      );
      for (final String claim in <String>[
        'Aapka naam, phone number aur photo nahi dikhta.',
        'Agar koi company paise dekar aapki profile unlock karti hai, to 14 '
            'din tak:',
        'Woh aapko BadaBhai ke andar message kar sakti hai.',
      ]) {
        expect(find.text(claim, findRichText: true), findsOneWidget,
            reason: claim);
      }
      // Full verbatim parity with the doc: employer_sharing_notice_test.dart.
    });

    testWidgets('sits between the shield and the voice card', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);
      final double employer =
          tester.getTopLeft(find.byType(EmployerSharingNotice)).dy;
      final double voice = tester
          .getTopLeft(find.text('Aapki awaaz record karne ki ijaazat'))
          .dy;
      final double shield = tester.getTopLeft(find.byIcon(Icons.shield_outlined)).dy;
      expect(shield, lessThan(employer));
      expect(employer, lessThan(voice));
    });

    testWidgets('the voice notice still renders, untouched', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);
      expect(find.text('Aapki awaaz record karne ki ijaazat'), findsOneWidget);
      for (final String line in <String>[
        'Aapki awaaz record hoti hai aur humaare paas save rehti hai.',
        'Us recording ko likhne ke liye hum use Sarvam naam ki ek doosri '
            'company ko bhejte hain.',
        'Recording hamesha ke liye save rehti hai — hum use apne aap nahi '
            'hataate.',
        'Aapki awaaz ka istemaal kisi AI ko sikhaane ke liye nahi kiya jaata.',
        'Dhyaan dein: Agar aap ijaazat nahi dete, tab bhi aap poora interview '
            'type karke de sakte hain. Kuch bhi kam nahi hota — sirf mic band '
            'rehta hai.',
      ]) {
        expect(find.text(line, findRichText: true), findsOneWidget,
            reason: line);
      }
    });

    testWidgets('ONE tick (with the age answer) gates the submit, below both cards', (
      WidgetTester tester,
    ) async {
      await pump(tester, recovery: false);

      expect(find.byType(Checkbox), findsOneWidget);
      expect(find.text('I agree'), findsOneWidget);
      final double tick = tester.getTopLeft(find.byType(Checkbox)).dy;
      final double voice = tester
          .getTopLeft(find.text('Aapki awaaz record karne ki ijaazat'))
          .dy;
      expect(tick, greaterThan(voice), reason: 'the tick covers both cards');

      // Age answered, tick untouched: the CTA does nothing and nothing is recorded.
      await tester.ensureVisible(find.text('Haan, 18+ hoon'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Haan, 18+ hoon'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage Badhein'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Aage Badhein'));
      await tester.pumpAndSettle();
      verifyNever(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      );
      expect(find.text('CHAT STEP'), findsNothing);

      // The 'I agree' label is a tap target too, and one tick covers both cards.
      await tester.ensureVisible(find.text('I agree'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('I agree'));
      await tester.pump();
      await tester.tap(find.text('Aage Badhein'));
      await tester.pumpAndSettle();
      verify(() => repo.acceptConsent(purposes: _kPurposes, age18Plus: true))
          .called(1);
      expect(find.text('CHAT STEP'), findsOneWidget);
    });
  });
}

// D13 — the Profile tab across every shape a worker actually owns: 320x568 to a
// 768x1024 tablet and a landscape phone, at system font scales 1.0 / 1.5 / 2.0
// (the app now honours the phone's font size up to 2.0, chrome clamped at 1.3).
//
// It also pins the v3 rulings this screen carries:
//  - R2: no BbChatAction in the header; the yellow bubble means FEEDBACK and
//    carries the route the worker was on;
//  - R13: the content column stops at 600 and centres on a tablet;
//  - D6: every tappable thing clears 48dp;
//  - D11: no raw id, slug or enum ever reaches the screen.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_alerts_action.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chat_action.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/cubit/profile_tab_cubit.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/widgets/profile_identity_card.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';

import '../../support/kit_matrix.dart';

class _MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

class _FakeResumeEditRepository implements ResumeEditRepository {
  _FakeResumeEditRepository(this.name);

  final String name;

  @override
  Future<ResumeSafeFields> load() async => ResumeSafeFields(
    displayName: name,
    showPhoto: true,
    nightShiftReady: false,
  );

  @override
  Future<bool> save(ResumeSafeFields fields) async => false;

  @override
  void onLogout() {}
}

/// What the summary call does on this run.
enum _Load { ready, failed, hang }

/// A profile with every block populated — the widest layout the screen has.
const ProfileSummary _rich = ProfileSummary(
  tradeLabel: 'CNC Turner/Operator',
  city: 'Pimpri-Chinchwad',
  verified: true,
  strengthSignals: 4,
  strengthMax: 9,
  missingFields: <String>['salary', 'photo'],
  skills: <String>[
    'CNC operating',
    'GD&T / technical drawing reading',
    'Tool offset setting',
    'Program editing (G & M codes)',
    'Fanuc control operation',
    'Micrometer / Vernier / gauge usage',
    'Fixture / job setup',
    'Turning (lathe operation)',
    'Milling',
    'Drilling',
    'Tapping / threading',
    'Grinding (surface / cylindrical)',
    'Deburring / finishing',
    'CNC programming',
    'CMM operation',
    'Quality control (QC)',
  ],
  machines: <String>[
    'CNC Lathe / Turning Center',
    'Vertical Machining Center (VMC)',
    'Cylindrical Grinder',
    'CNC Grinder',
  ],
  experienceYears: 12.5,
  educationLevel: 'ITI',
  educationField: 'Mechanical',
  profileStatus: 'confirmed',
);

/// The honest floor: nothing extracted yet, nothing to show but the invitation.
const ProfileSummary _bare = ProfileSummary(strengthSignals: 0);

/// Raw taxonomy ids and a token-ish education level, exactly as a sloppy
/// extraction can leave them on the wire.
const ProfileSummary _rawIds = ProfileSummary(
  tradeLabel: 'role_cnc_turner_operator',
  city: 'Pune',
  strengthSignals: 5,
  strengthMax: 9,
  missingFields: <String>['photo'],
  skills: <String>['skill_milling', 'skill_drawing_reading'],
  machines: <String>['mach_vmc'],
  experienceYears: 3,
  educationLevel: 'below_10',
  profileStatus: 'draft',
);

void main() {
  late _MockProfileSummaryRepository repo;
  _Load mode = _Load.ready;
  ProfileSummary current = _rich;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = _MockProfileSummaryRepository();
    when(() => repo.summary(includeDisplayExtras: true)).thenAnswer((_) async {
      switch (mode) {
        case _Load.failed:
          throw const NetworkFailure();
        case _Load.hang:
          // A load that never resolves — the real loading state, not a frame of
          // one. Nothing here schedules a timer, so the test can still finish.
          await Completer<void>().future;
          throw StateError('unreachable');
        case _Load.ready:
          return current;
      }
    });
    locator.registerFactory<ProfileTabCubit>(() => ProfileTabCubit(repo));
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
  });

  tearDown(() async {
    mode = _Load.ready;
    current = _rich;
    await locator.reset();
  });

  Widget build({_Load load = _Load.ready, ProfileSummary summary = _rich}) {
    mode = load;
    current = summary;
    return const ProfileTabScreen();
  }

  Future<void> pumpAt(
    WidgetTester tester, {
    required Size size,
    double scale = 1.0,
    ProfileSummary summary = _rich,
  }) async {
    setKitSurface(tester, size);
    await tester.pumpWidget(
      kitTestApp(build(summary: summary), textScale: scale),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  kitMatrixTest(
    'a full profile survives every shape',
    () => build(),
    primary: () => find.text('Logout'),
  );

  kitMatrixTest(
    'an empty profile survives every shape',
    () => build(summary: _bare),
    // #1579 — the empty skills section hides entirely now, so the footer
    // proves the screen survived instead.
    primary: () => find.text('Logout'),
  );

  kitMatrixTest(
    'the failed state survives every shape',
    () => build(load: _Load.failed),
    primary: () => find.text('Try again'),
  );

  kitMatrixTest(
    'the loading state survives every shape',
    () => build(load: _Load.hang),
    primary: () => find.byType(CircularProgressIndicator),
  );

  testWidgets('tablet: the content column stops at 600 and centres', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, size: const Size(768, 1024));

    expect(
      widthOf(tester, find.byType(ProfileIdentityCard)),
      lessThanOrEqualTo(600),
    );
    // And it is not squeezed either — the cap centres a real column.
    expect(widthOf(tester, find.byType(ProfileIdentityCard)), greaterThan(400));
  });

  testWidgets('every tappable thing clears the 48dp worker touch floor', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, size: const Size(360, 640));
    await expectKitTapTargets(tester);
  });

  testWidgets(
    'no raw id, slug or status enum reaches the screen — every label is '
    'humanized at the edge',
    (WidgetTester tester) async {
      await pumpAt(tester, size: const Size(390, 844), summary: _rawIds);

      for (final String raw in <String>[
        'role_cnc_turner_operator',
        'skill_milling',
        'skill_drawing_reading',
        'mach_vmc',
        'below_10',
        'draft',
        'extracted',
        'confirmed',
        'none',
      ]) {
        expect(
          find.textContaining(raw, findRichText: true),
          findsNothing,
          reason: 'a raw value ($raw) reached a worker-facing screen',
        );
      }

      // The humanized forms are what a worker sees instead.
      expect(find.text('CNC Turner/Operator'), findsOneWidget);
      expect(find.text('Milling'), findsOneWidget);
      expect(find.text('Vertical Machining Center (VMC)'), findsOneWidget);
      expect(find.text('Padhai: 10th se kam'), findsOneWidget);
      // An unconfirmed profile says so in approved caps, not in the raw enum.
      expect(find.text('DRAFT'), findsOneWidget);
    },
  );

  testWidgets(
    'a confirmed profile shows NO status pill (no approved label yet, C28) and '
    'never the word none',
    (WidgetTester tester) async {
      await pumpAt(tester, size: const Size(390, 844));

      expect(find.text('DRAFT'), findsNothing);
      expect(find.text('CONFIRMED'), findsNothing);
      expect(find.text('WORKER PROFILE'), findsOneWidget);
    },
  );

  testWidgets(
    'a very long name at 320x568 @2.0 ellipsizes instead of overflowing',
    (WidgetTester tester) async {
      const String longName = 'Ramchandra Vishwanath Deshpande Kulkarni Patil';
      // The name is an OPTIONAL read (R5) — registering the source is what
      // turns it on; every other test here runs without it, fail-silent.
      locator.registerSingleton<ResumeEditRepository>(
        _FakeResumeEditRepository(longName),
      );

      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(kitTestApp(build(), textScale: 2.0));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      final Text title = tester.widget<Text>(find.text(longName));
      expect(title.maxLines, 2);
      expect(title.overflow, TextOverflow.ellipsis);
    },
  );

  testWidgets(
    'the header carries the bell and NO chat action (R2: one glyph, one '
    'meaning), and Feedback pushes /feedback with the route the worker was on',
    (WidgetTester tester) async {
      setKitSurface(tester, const Size(390, 844));
      final GoRouter router = GoRouter(
        initialLocation: '/profile',
        routes: <RouteBase>[
          GoRoute(path: '/profile', builder: (_, __) => build()),
          GoRoute(
            path: '/profile/settings',
            builder: (_, __) =>
                const Scaffold(body: Center(child: Text('settings-screen'))),
          ),
          GoRoute(
            path: '/feedback',
            builder: (BuildContext context, GoRouterState state) => Scaffold(
              body: Center(child: Text('feedback-from:${state.extra}')),
            ),
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byType(BbAlertsAction), findsOneWidget);
      expect(find.byType(BbChatAction), findsNothing);

      await tester.tap(find.byTooltip('Feedback'));
      await tester.pumpAndSettle();
      expect(find.text('feedback-from:/profile'), findsOneWidget);

      router.pop();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      expect(find.text('settings-screen'), findsOneWidget);
    },
  );
}

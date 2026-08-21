import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/features/applications/domain/applications_repository.dart';
import 'package:badabhai_worker_app/features/applications/presentation/applied_jobs_screen.dart';
import 'package:badabhai_worker_app/features/applications/presentation/cubit/applications_cubit.dart';

class MockApplicationsRepository extends Mock implements ApplicationsRepository {}

AppliedJob _job(
  String id, {
  String? area,
  required String title,
  // Default is a LEGACY trade slug — the production shape (all 17 rows carry a
  // non-empty jobs.trade_key and no matched_skill_label). Pass an `mskill_*` id to
  // exercise the MATCH_V1 guard.
  String tradeKey = 'cnc_operator',
  String? skillLabel,
}) =>
    AppliedJob(
      jobId: id,
      tradeKey: tradeKey,
      title: title,
      city: 'Pune',
      area: area,
      action: 'applied',
      reason: null,
      sourceSurface: 'feed',
      rank: null,
      createdAt: DateTime(2026, 6, 1),
      updatedAt: DateTime(2026, 6, 1),
      matchedSkillLabel: skillLabel,
    );

/// Wires a fake repo into the locator + a minimal router (applied + the
/// job-detail / jobs targets the screen navigates to), pumps, and settles the
/// async load (without pumpAndSettle — the loading spinner animates forever).
Future<void> _pump(WidgetTester tester, List<AppliedJob> applied) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockApplicationsRepository repo = MockApplicationsRepository();
  when(() => repo.appliedJobs()).thenAnswer((_) async => applied);
  locator.registerFactory<ApplicationsCubit>(() => ApplicationsCubit(repo));

  final GoRouter router = GoRouter(
    initialLocation: '/profile/applied',
    routes: <RouteBase>[
      GoRoute(
          path: '/profile/applied',
          builder: (_, __) => const AppliedJobsScreen()),
      GoRoute(
          path: '/jobs/detail/:jobId',
          builder: (_, GoRouterState s) =>
              Scaffold(body: Text('DETAIL ${s.pathParameters['jobId']}'))),
      GoRoute(
          path: '/jobs',
          builder: (_, __) => const Scaffold(body: Text('JOBS FEED'))),
    ],
  );

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
  await tester.pump(); // first frame: loading
  await tester.pump(); // load() future resolves → ready/empty
}

void main() {
  tearDown(() async => locator.reset());

  test('#1051: AppliedJob.fromJson on the REAL applications payload — trade_key '
      'present, NO matched_skill_label — so the fallback trade line is what shows',
      () {
    // The exact shape GET /workers/me/applications returns: it projects
    // `trade_key` and never sends `matched_skill_label`. A label-only read left
    // this null and dropped the trade line for every legacy row (#1051). This is
    // the fromJson coverage #1027's fixture-built tests were missing.
    final AppliedJob job = AppliedJob.fromJson(<String, dynamic>{
      'job_id': 'j1',
      'trade_key': 'cnc_operator',
      'title': 'CNC Operator',
      'city': 'Pune',
      'area': 'Pimpri',
      'action': 'applied',
      'source_surface': 'feed',
      'created_at': '2026-06-01T00:00:00Z',
      'updated_at': '2026-06-01T00:00:00Z',
    });
    expect(job.matchedSkillLabel, isNull,
        reason: 'the applications API sends no label');
    expect(job.tradeKey, 'cnc_operator',
        reason: 'the legacy slug the subtitle falls back to');
  });

  testWidgets(
      'WA-1 regression: THREE applications render as THREE rows — the list '
      'must never collapse to one', (WidgetTester tester) async {
    await _pump(tester, <AppliedJob>[
      _job('a1', area: 'Pimpri', title: 'CNC Operator'),
      _job('a2', area: null, title: 'VMC Operator'),
      _job('a3', area: 'Waluj', title: 'Welder'),
    ]);

    expect(find.text('CNC Operator'), findsOneWidget);
    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.text('Welder'), findsOneWidget);
    // Exactly one row per application — three cards, no dedupe, no take(1).
    expect(find.byType(BbJobCard), findsNWidgets(3));
  });

  testWidgets(
      'subtitle prefers the matched-skill LABEL, falls back to the legacy '
      'trade_key (#1051), never an mskill_ id', (WidgetTester tester) async {
    await _pump(tester, <AppliedJob>[
      // V1 row that carries a label.
      _job('a1',
          area: 'Pimpri', title: 'CNC Operator', skillLabel: 'MIG Welder'),
      // LEGACY row — the production shape: a trade_key slug, no label. Its trade
      // line MUST survive (this is exactly what #1027 regressed and #1051 fixes).
      _job('a2', area: null, title: 'VMC Operator'), // tradeKey 'cnc_operator'
    ]);

    expect(find.text('MIG Welder · Pimpri, Pune'), findsOneWidget);
    expect(find.text('cnc_operator · Pune'), findsOneWidget);
    // The internal `mskill_*` trade_key must NEVER be rendered (#1027).
    expect(find.textContaining('mskill_'), findsNothing);
  });

  testWidgets('#1027: an mskill_ id is never rendered — the subtitle drops to '
      'place alone', (WidgetTester tester) async {
    await _pump(tester, <AppliedJob>[
      _job('a1', area: 'Pimpri', title: 'CNC Operator', tradeKey: 'mskill_cnc_op'),
    ]);

    expect(find.text('Pimpri, Pune'), findsOneWidget); // subtitle = place only
    expect(find.textContaining('mskill_'), findsNothing);
  });

  testWidgets('empty state shows the Hinglish copy + a CTA', (
    WidgetTester tester,
  ) async {
    await _pump(tester, <AppliedJob>[]);
    expect(find.text('Abhi tak koi job apply nahi ki'), findsOneWidget);
    expect(find.text('Jobs dekhein'), findsOneWidget);
  });

  testWidgets('row tap navigates to job-detail with the correct jobId', (
    WidgetTester tester,
  ) async {
    await _pump(tester, <AppliedJob>[_job('a1', area: 'Pimpri', title: 'CNC Operator')]);

    await tester.tap(find.text('CNC Operator'));
    await tester.pumpAndSettle(); // detail screen has no perpetual animation

    expect(find.text('DETAIL a1'), findsOneWidget);
  });

  test('appliedRelativeLabel formats coarse Hinglish relative time', () {
    final DateTime now = DateTime(2026, 6, 10, 12, 0);
    expect(appliedRelativeLabel(now.subtract(const Duration(seconds: 5)), now: now),
        'Applied · abhi');
    expect(appliedRelativeLabel(now.subtract(const Duration(minutes: 5)), now: now),
        'Applied · 5 minute pehle');
    expect(appliedRelativeLabel(now.subtract(const Duration(hours: 3)), now: now),
        'Applied · 3 ghante pehle');
    expect(appliedRelativeLabel(now.subtract(const Duration(days: 2)), now: now),
        'Applied · 2 din pehle');
  });
}

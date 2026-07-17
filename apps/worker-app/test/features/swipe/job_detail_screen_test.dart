import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/swipe/data/jobs_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/domain/jobs_repository.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/cubit/job_detail_cubit.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/job_detail_screen.dart';

/// The REAL job-detail surface (ADR-0024 addendum, 2026-07-16): every present
/// field renders, every null field HIDES its row, and NOTHING employer-shaped
/// can appear — asserted against the real canned mock data, not fixtures the
/// test invented.
///
/// Plus the WA-2 applied-CTA gate: opened from an Applied-jobs row, the detail
/// receives the row's REAL recorded `action` (GET /workers/me/applications)
/// via [JobDetail.applicationAction] — an already-applied job shows
/// "Aapne apply kar diya ✓" and NEVER an apply action, and the gate must
/// SURVIVE the full-detail fetch-swap (the wire body never carries the
/// decision; the cubit reattaches it). Opened from the feed (undecided,
/// post-WA-1), the normal "Apply karein" CTA renders.

class _MockSwipeRepository extends Mock implements SwipeRepository {}

class _MockJobsRepository extends Mock implements JobsRepository {}

/// Builds a [JobDetailCubit] over REAL repositories + [api], with a session
/// carrying the bearer token worker-scoped routes need (mirrors the
/// swipe_jobs_screen_test harness).
JobDetailCubit _cubit(ApiClient api, JobDetail light) {
  final SessionRepository session = SessionRepository()
    ..setWorker(
      phone: '+910000000000',
      workerId: 'worker-1',
      sessionToken: 'test-token',
    );
  return JobDetailCubit(
    JobsRepositoryImpl(api, session),
    SwipeRepositoryImpl(api, session),
    light,
  );
}

/// Mounts the detail screen behind a home marker so `context.pop('applied')`
/// has somewhere to land. Returns the router so tests can push the detail.
(Widget, GoRouter) _harness(JobDetailCubit cubit, JobDetail light) {
  final GoRouter router = GoRouter(
    initialLocation: '/home',
    routes: <RouteBase>[
      GoRoute(
        path: '/home',
        builder: (_, __) =>
            const Scaffold(body: Center(child: Text('HOME'))),
      ),
      GoRoute(
        path: '/detail',
        builder: (_, __) => JobDetailScreen(detail: light, cubit: cubit),
      ),
    ],
  );
  return (MaterialApp.router(routerConfig: router), router);
}

/// WA-2 harness — exercises the screen's LOCATOR create-path (no cubit seam),
/// exactly as production constructs it. The stubbed [JobsRepository] returns a
/// WIRE-shaped full detail (rich fields, NO applicationAction — `GET
/// /jobs/:jobId` never carries the worker's decision), so these tests also
/// prove the applied gate survives the fetch-swap via the cubit's reattach.
Future<void> _pumpViaLocator(WidgetTester tester, JobDetail light) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final _MockJobsRepository jobs = _MockJobsRepository();
  when(() => jobs.jobDetail(light.jobId)).thenAnswer(
    (_) async => JobDetail(
      jobId: light.jobId,
      title: light.title,
      city: light.city,
      area: light.area,
      payMin: 16000,
      payMax: 26000,
      shift: 'day',
    ),
  );
  locator.registerLazySingleton<JobsRepository>(() => jobs);
  locator.registerLazySingleton<SwipeRepository>(() => _MockSwipeRepository());

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.light(),
    home: JobDetailScreen(detail: light),
  ));
  await tester.pumpAndSettle();
}

/// Every Text in the tree, joined — for whole-surface "nothing
/// employer-shaped" assertions.
String _allText(WidgetTester tester) {
  return tester
      .widgetList<Text>(find.byType(Text))
      .map((Text t) => t.data ?? t.textSpan?.toPlainText() ?? '')
      .join(' ');
}

void main() {
  // The light detail the Feed row hands over for mock-job-0001 (fully
  // populated in MockApiClient's canned details).
  const JobDetail lightFull = JobDetail(
    jobId: 'mock-job-0001',
    title: 'CNC Operator',
    city: 'Pune',
    area: 'Chakan',
  );

  // mock-job-0004 states nothing beyond the feed facts — every optional row
  // must stay hidden.
  const JobDetail lightMinimal = JobDetail(
    jobId: 'mock-job-0004',
    title: 'Fitter',
    city: 'Aurangabad',
    area: 'Waluj',
  );

  testWidgets(
      'renders every present section from the REAL canned detail — and '
      'nothing employer-shaped anywhere', (WidgetTester tester) async {
    final JobDetailCubit cubit = _cubit(MockApiClient(), lightFull);
    final (Widget app, GoRouter router) = _harness(cubit, lightFull);
    await tester.pumpWidget(app);
    router.push('/detail');
    // Two zero-duration pumps: one for the router notification, one for the
    // pushed page's first frame — no wall time passes, so the mock fetch
    // (300ms canned latency) is still in flight.
    await tester.pump();
    await tester.pump();

    // Instant header from the light detail while the fetch runs.
    expect(find.text('CNC Operator'), findsOneWidget);
    expect(find.text('Chakan, Pune'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await tester.pumpAndSettle();

    // Full posting: pay band (full format), shift, experience window,
    // needed-by, description, requirement chips, benefit lines.
    expect(find.text('₹16,000–26,000/mo'), findsOneWidget);
    expect(find.text('Day shift'), findsOneWidget);
    expect(find.text('0–2 yrs experience'), findsOneWidget);
    expect(find.text('Turant chahiye'), findsOneWidget);
    expect(find.textContaining('CNC lathe par production ka kaam'),
        findsOneWidget);
    expect(find.text('Fanuc control'), findsOneWidget);
    expect(find.text('ITI / Diploma'), findsOneWidget);

    // Benefits sit below the fold — the ListView builds children lazily, so
    // scroll them into view before asserting.
    await tester.scrollUntilVisible(
      find.text('Canteen'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('PF + ESI'), findsOneWidget);
    expect(find.text('Overtime pay'), findsOneWidget);
    expect(find.text('Canteen'), findsOneWidget);

    // NOTHING employer-shaped, asserted on the REAL canned data: no company
    // row exists on this screen at all, no "Pvt Ltd"-style string, no
    // verified badge, no spots-left.
    expect(find.textContaining('Pvt'), findsNothing);
    expect(find.textContaining('Ltd'), findsNothing);
    expect(find.byIcon(Icons.verified), findsNothing);
    expect(find.textContaining('spots'), findsNothing);
    final String surface = _allText(tester);
    expect(surface.contains('Pvt'), isFalse);
    expect(surface.contains('Works'), isFalse);
    expect(surface.contains('Industries'), isFalse);
    expect(surface.contains('payer'), isFalse);
    // No phone/email-shaped strings on the whole surface either.
    expect(RegExp(r'\d{7,}').hasMatch(surface.replaceAll(',', '')), isFalse);
    expect(surface.contains('@'), isFalse);
  });

  testWidgets('a null field HIDES its row — the minimal canned job shows '
      'only the real header', (WidgetTester tester) async {
    final JobDetailCubit cubit = _cubit(MockApiClient(), lightMinimal);
    final (Widget app, GoRouter router) = _harness(cubit, lightMinimal);
    await tester.pumpWidget(app);
    router.push('/detail');
    await tester.pumpAndSettle();

    expect(find.text('Fitter'), findsOneWidget);
    expect(find.text('Waluj, Aurangabad'), findsOneWidget);

    // Every optional row hidden — never a placeholder, never an invention.
    expect(find.textContaining('₹'), findsNothing);
    expect(find.textContaining('shift'), findsNothing);
    expect(find.textContaining('experience'), findsNothing);
    expect(find.textContaining('chahiye'), findsNothing);
    expect(find.text('KAAM KE BAARE MEIN'), findsNothing);
    expect(find.text('REQUIREMENTS'), findsNothing);
    expect(find.text('BENEFITS'), findsNothing);
    // And still nothing employer-shaped.
    expect(find.byIcon(Icons.verified), findsNothing);
    expect(find.textContaining('spots'), findsNothing);
  });

  testWidgets(
      'a failed fetch keeps the light header and offers a quiet retry that '
      'then loads the full posting', (WidgetTester tester) async {
    int calls = 0;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        calls++;
        if (calls == 1) {
          return http.Response(
              jsonEncode(<String, dynamic>{'message': 'boom'}), 500);
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'job_id': 'mock-job-0001',
            'trade_key': 'cnc_operator',
            'title': 'CNC Operator',
            'city': 'Pune',
            'area': 'Chakan',
            'pay_min': 16000,
            'pay_max': 26000,
            'shift': 'day',
          }),
          200,
        );
      }),
    );
    final JobDetailCubit cubit = _cubit(api, lightFull);
    final (Widget app, GoRouter router) = _harness(cubit, lightFull);
    await tester.pumpWidget(app);
    router.push('/detail');
    await tester.pumpAndSettle();

    // The light facts are NEVER wiped by the failure.
    expect(find.text('CNC Operator'), findsOneWidget);
    expect(find.text('Chakan, Pune'), findsOneWidget);
    expect(find.text('Poori jaankari load nahi hui.'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(calls, 2);
    expect(find.text('₹16,000–26,000/mo'), findsOneWidget);
    expect(find.text('Day shift'), findsOneWidget);
    expect(find.text('Poori jaankari load nahi hui.'), findsNothing);
  });

  testWidgets('the Apply CTA still works — pops back with the applied result',
      (WidgetTester tester) async {
    final JobDetailCubit cubit = _cubit(MockApiClient(), lightFull);
    final (Widget app, GoRouter router) = _harness(cubit, lightFull);
    await tester.pumpWidget(app);
    router.push('/detail');
    await tester.pumpAndSettle();

    await tester.tap(find.text('Apply karein'));
    await tester.pumpAndSettle();

    // MockApiClient's applyToJob succeeded → the screen popped to home.
    expect(find.text('HOME'), findsOneWidget);
    expect(find.text('Apply karein'), findsNothing);
  });

  // ── WA-2: the CTA is gated on the worker's OWN application state ──────────
  group('WA-2 applied-CTA gate (locator create-path)', () {
    tearDown(() async => locator.reset());

    testWidgets(
        'an ALREADY-APPLIED job shows the Hinglish applied status and never '
        'an apply action — even AFTER the full-detail fetch-swap',
        (WidgetTester tester) async {
      await _pumpViaLocator(
        tester,
        const JobDetail(
          jobId: 'j1',
          title: 'CNC Operator',
          city: 'Pune',
          area: 'Pimpri',
          // The REAL action from the applications API.
          applicationAction: 'applied',
        ),
      );

      // Gated on the real recorded action, rendered in the DS's warm Hinglish
      // (L-2) — the raw wire enum never reaches the UI.
      expect(find.text('Aapne apply kar diya ✓'), findsOneWidget);
      expect(find.textContaining('Status:'), findsNothing);
      // Never an apply action for an applied job — no CTA, no button at all.
      expect(find.text('Apply karein'), findsNothing);
      expect(find.byType(BbButton), findsNothing);
      // The fetch-swap landed (the rich pay row proves it) and the gate
      // SURVIVED it — the wire body carried no decision; the cubit reattached
      // the opening surface's one.
      expect(find.text('₹16,000–26,000/mo'), findsOneWidget);
    });

    testWidgets(
        'an undecided job (feed hand-over, no action) keeps the apply CTA',
        (WidgetTester tester) async {
      await _pumpViaLocator(
        tester,
        const JobDetail(jobId: 'j2', title: 'VMC Operator', city: 'Pune'),
      );

      expect(find.text('Apply karein'), findsOneWidget);
      expect(find.text('Aapne apply kar diya ✓'), findsNothing);
    });
  });
}

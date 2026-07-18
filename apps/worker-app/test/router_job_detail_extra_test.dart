// #380 — `/jobs/detail/:jobId` must not red-screen when it is reached without
// the tapped row's `JobDetail` riding along as `extra`.
//
// The route is PATH-addressable and `extra` is in-memory only (go_router never
// serializes it), so a deep link, a notification tap, or state restoration
// lands on `/jobs/detail/<id>` with `extra == null`. The builder used to do
// `s.extra! as JobDetail`, which threw "Null check operator used on a null
// value" and red-screened. There is no worker-facing job-detail endpoint to
// re-fetch `:jobId` from and we must never synthesise a job from an id, so the
// only truthful degradation is a bounce to the feed.
//
// These tests drive the REAL app router (`buildAppRouter`), so they exercise the
// production route table — not a stand-in harness. Auth is deliberately NOT
// wired, which makes the auth redirect inert (see `_maybeAuth` in router.dart)
// and leaves the job-detail guard as the only redirect in play.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/job_detail_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// Mounts the real router and returns it so a test can drive `go(...)` with and
/// without `extra` (a plain `context.go` from a widget cannot express "no extra"
/// as precisely).
Future<GoRouter> _pumpApp(WidgetTester tester) async {
  final GoRouter router = buildAppRouter();
  await tester.pumpWidget(MaterialApp.router(routerConfig: router));
  await tester.pump();
  return router;
}

void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
  });

  testWidgets(
      'path-only navigation to /jobs/detail/:jobId bounces to the feed '
      'instead of throwing (#380)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final GoRouter router = await _pumpApp(tester);

    // Exactly what a deep link / notification tap / restored session produces:
    // the path, no `extra`. Before the fix this threw inside the route builder.
    router.go('${Routes.jobDetail}/job-abc');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull,
        reason: 'an extra-less job-detail navigation must never throw');
    expect(find.byType(JobDetailScreen), findsNothing);
    expect(find.byType(SwipeJobsScreen), findsOneWidget,
        reason: 'the worker should land on the feed, which owns the real rows');
  });

  testWidgets('a navigation carrying a real JobDetail still opens the detail '
      'screen (#380 regression guard)', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final GoRouter router = await _pumpApp(tester);

    // The two production call-sites (feed row + applied row) always pass a
    // typed JobDetail — the guard must not break them.
    router.go(
      '${Routes.jobDetail}/job-abc',
      extra: const JobDetail(jobId: 'job-abc', title: 'CNC Operator'),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
    expect(find.byType(JobDetailScreen), findsOneWidget);
  });
}

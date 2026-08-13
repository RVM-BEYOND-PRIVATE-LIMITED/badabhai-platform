import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/job_search/data/job_search_repository_impl.dart';
import 'package:badabhai_worker_app/features/job_search/presentation/cubit/job_search_cubit.dart';
import 'package:badabhai_worker_app/features/job_search/presentation/job_search_screen.dart';

/// One search-result row in the API's JSON shape (snake_case).
Map<String, dynamic> _job({
  required String id,
  String title = 'CNC Operator',
  String city = 'Kota',
  String state = 'Rajasthan',
  String? matchedSkill = 'CNC Operator',
}) =>
    <String, dynamic>{
      'job_id': id,
      'title': title,
      'city': city,
      'state': state,
      'pay_min': 18000,
      'pay_max': 28000,
      'shift': 'day',
      'matched_skill_label': matchedSkill,
      'published_at': '2026-08-01T00:00:00Z',
    };

String _envelope(List<Map<String, dynamic>> jobs) => jsonEncode(<String, dynamic>{
      'jobs': jobs,
      'page': 1,
      'limit': 20,
      'has_more': false,
    });

/// A [JobSearchCubit] over a REAL repository + [ApiClient] backed by [client],
/// with a session carrying the bearer worker-scoped routes need. No network.
JobSearchCubit _cubit(MockClient client) {
  final SessionRepository session = SessionRepository()
    ..setWorker(
      phone: '+910000000000',
      workerId: 'worker-1',
      sessionToken: 'test-token',
    );
  final ApiClient api = ApiClient(baseUrl: 'http://test', client: client);
  return JobSearchCubit(JobSearchRepositoryImpl(api, session));
}

/// Mounts the search screen at `/jobs/search` plus a job-detail stand-in that a
/// result tap navigates to (mirrors how the feed opens the shared detail route).
Widget _harness(JobSearchCubit cubit) {
  final GoRouter router = GoRouter(
    initialLocation: '/jobs/search',
    routes: <RouteBase>[
      GoRoute(
        path: '/jobs/search',
        builder: (_, __) => JobSearchScreen(cubit: cubit),
      ),
      GoRoute(
        path: '/jobs/detail/:jobId',
        builder: (_, GoRouterState s) => Scaffold(
          body: Center(child: Text('DETAIL ${s.pathParameters['jobId']}')),
        ),
      ),
    ],
  );
  return MaterialApp.router(routerConfig: router);
}

const Key _titleField = Key('jobSearchTitleField');
const Key _locationField = Key('jobSearchLocationField');
const Key _submit = Key('jobSearchSubmitButton');

Future<void> _runSearch(WidgetTester tester) async {
  await tester.enterText(find.byKey(_titleField), 'CNC operator');
  await tester.enterText(find.byKey(_locationField), 'Kota, Rajasthan');
  await tester.tap(find.byKey(_submit));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders both inputs + the search button, and the idle prompt',
      (WidgetTester tester) async {
    final JobSearchCubit cubit =
        _cubit(MockClient((http.Request req) async => http.Response(_envelope(<Map<String, dynamic>>[]), 200)));

    await tester.pumpWidget(_harness(cubit));
    await tester.pumpAndSettle();

    expect(find.byKey(_titleField), findsOneWidget);
    expect(find.byKey(_locationField), findsOneWidget);
    expect(find.byKey(_submit), findsOneWidget);
    // Idle: prompt the worker to search rather than showing a blank list. The
    // subtitle is unique to the idle state (the title matches the toolbar).
    expect(
      find.text('Job title aur city daalein — jaise CNC operator, Kota.'),
      findsOneWidget,
    );
  });

  testWidgets('a search renders result cards from the API', (
    WidgetTester tester,
  ) async {
    http.Request? captured;
    final JobSearchCubit cubit = _cubit(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        _envelope(<Map<String, dynamic>>[
          _job(id: 'job-1', title: 'CNC Operator'),
          _job(id: 'job-2', title: 'Welder'),
        ]),
        200,
      );
    }));

    await tester.pumpWidget(_harness(cubit));
    await tester.pumpAndSettle();
    await _runSearch(tester);

    // Worker-scoped search carried the bearer + the parsed city/state.
    expect(captured?.url.path, '/jobs/search');
    expect(captured?.headers['authorization'], 'Bearer test-token');
    expect(captured?.url.queryParameters['city'], 'Kota');
    expect(captured?.url.queryParameters['state'], 'Rajasthan');

    expect(find.text('CNC Operator'), findsOneWidget);
    expect(find.text('Welder'), findsOneWidget);
    expect(find.text('Kota, Rajasthan'), findsWidgets); // place line on each card
    // Match-note parity with the feed: the server's matched-skill label renders.
    expect(find.textContaining('milta-julta'), findsWidgets);
  });

  testWidgets('empty results show the honest no-jobs state', (
    WidgetTester tester,
  ) async {
    final JobSearchCubit cubit = _cubit(
      MockClient((http.Request req) async =>
          http.Response(_envelope(<Map<String, dynamic>>[]), 200)),
    );

    await tester.pumpWidget(_harness(cubit));
    await tester.pumpAndSettle();
    await _runSearch(tester);

    expect(find.text('Koi job nahi mili.'), findsOneWidget);
  });

  testWidgets('the search header HIDES on scroll-down and REVEALS on scroll-up',
      (WidgetTester tester) async {
    // Enough results to make the list scrollable so the floating app bar can
    // collapse.
    final List<Map<String, dynamic>> many = List<Map<String, dynamic>>.generate(
      20,
      (int i) => _job(id: 'job-$i', title: 'CNC Operator $i'),
    );
    final JobSearchCubit cubit = _cubit(
      MockClient((http.Request req) async => http.Response(_envelope(many), 200)),
    );

    await tester.pumpWidget(_harness(cubit));
    await tester.pumpAndSettle();
    await _runSearch(tester);

    // Both inputs are visible while expanded.
    expect(find.byKey(_titleField), findsOneWidget);
    expect(find.byKey(_locationField), findsOneWidget);
    final double expandedTop = tester.getTopLeft(find.byKey(_titleField)).dy;

    // Scroll the RESULTS up (finger drags up) -> the search bar collapses away.
    await tester.drag(find.text('CNC Operator 0'), const Offset(0, -400));
    await tester.pumpAndSettle();
    final double collapsedTop = tester.getTopLeft(find.byKey(_titleField)).dy;
    expect(collapsedTop, lessThan(expandedTop)); // moved up / hidden

    // Scroll back down (finger drags down) -> snap the search bar back in.
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 600));
    await tester.pumpAndSettle();
    final double revealedTop = tester.getTopLeft(find.byKey(_titleField)).dy;
    expect(revealedTop, greaterThan(collapsedTop)); // came back
  });

  testWidgets('tapping a result opens the shared job-detail route', (
    WidgetTester tester,
  ) async {
    final JobSearchCubit cubit = _cubit(MockClient((http.Request req) async {
      return http.Response(
        _envelope(<Map<String, dynamic>>[_job(id: 'job-1', title: 'CNC Operator')]),
        200,
      );
    }));

    await tester.pumpWidget(_harness(cubit));
    await tester.pumpAndSettle();
    await _runSearch(tester);

    // The title is a ≥48px button (#362) — tap it to open the detail.
    await tester.tap(find.text('CNC Operator'));
    await tester.pumpAndSettle();

    expect(find.text('DETAIL job-1'), findsOneWidget);
  });
}

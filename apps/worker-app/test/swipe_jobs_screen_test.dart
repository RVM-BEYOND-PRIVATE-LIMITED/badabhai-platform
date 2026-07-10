import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/router.dart';

/// A single seeded feed job in the API's JSON shape (snake_case).
Map<String, dynamic> _job({
  required String id,
  String trade = 'cnc_operator',
  String title = 'CNC Operator',
  String city = 'Pune',
  String? area = 'Chakan',
  int rank = 1,
}) {
  return <String, dynamic>{
    'job_id': id,
    'trade_key': trade,
    'title': title,
    'city': city,
    'area': area,
    'rank': rank,
  };
}

/// Builds a [SwipeBloc] over a REAL [SwipeRepositoryImpl] + [ApiClient] backed by
/// [client], with a session carrying the bearer token worker-scoped routes need.
SwipeBloc _bloc(MockClient client) {
  final SessionRepository session = SessionRepository()
    ..setWorker(
      phone: '+910000000000',
      workerId: 'worker-1',
      sessionToken: 'test-token',
    );
  final ApiClient api = ApiClient(baseUrl: 'http://test', client: client);
  return SwipeBloc(SwipeRepositoryImpl(api, session));
}

/// Mounts the Feed at `/jobs` with an injected bloc, plus the routes its actions
/// reach: `/consent` (403) and `/jobs/detail/:id` (title tap). Apply/skip now stay
/// on the Feed and confirm with a SnackBar (no Applied screen navigation).
Widget _harness(SwipeBloc bloc) {
  Widget marker(String t) => Scaffold(body: Center(child: Text(t)));
  final GoRouter router = GoRouter(
    initialLocation: '/jobs',
    routes: <RouteBase>[
      GoRoute(path: '/jobs', builder: (_, __) => SwipeJobsScreen(bloc: bloc)),
      GoRoute(
        path: '/jobs/detail/:jobId',
        builder: (_, GoRouterState s) =>
            marker('DETAIL ${s.pathParameters['jobId']}'),
      ),
      GoRoute(path: Routes.consent, builder: (_, __) => const ConsentScreen()),
    ],
  );
  return MaterialApp.router(routerConfig: router);
}

void main() {
  // The 403 scenario navigates to the real ConsentScreen, which resolves its
  // cubit from get_it — so the locator must be wired. Idempotent.
  setUpAll(setupLocator);

  testWidgets('renders the head job card with title, place and mock fields', (
    WidgetTester tester,
  ) async {
    http.Request? captured;
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'jobs': <Map<String, dynamic>>[
            _job(id: 'job-1', title: 'VMC Operator', city: 'Pune'),
          ],
        }),
        200,
      );
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    // Worker-scoped feed request carried the bearer token (PII-free path).
    expect(captured?.url.path, '/feed');
    expect(captured?.headers['authorization'], 'Bearer test-token');
    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.text('Chakan, Pune'), findsOneWidget);
    expect(find.byKey(const Key('swipeApplyButton')), findsOneWidget);
    expect(find.byKey(const Key('swipeSkipButton')), findsOneWidget);
  });

  testWidgets('empty feed shows the no-more-jobs state', (
    WidgetTester tester,
  ) async {
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'jobs': <Map<String, dynamic>>[]}),
        200,
      );
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    expect(find.text('No more jobs right now.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Refresh'), findsOneWidget);
  });

  testWidgets('network error on load shows a retry', (
    WidgetTester tester,
  ) async {
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      throw Exception('no network');
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    expect(find.text('Jobs load nahi hue.'), findsOneWidget);
    // The thrown Exception maps to UnknownFailure — the honest reason mapper
    // renders its copy (not a false "check internet").
    expect(
      find.text('Kuch gadbad ho gayi. Dobara try karein.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });

  testWidgets('Apply commits, hits the apply endpoint and toasts (no nav)', (
    WidgetTester tester,
  ) async {
    http.Request? applyReq;
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      if (req.url.path == '/feed') {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[
              _job(id: 'job-1', title: 'First Job', rank: 1),
              _job(id: 'job-2', title: 'Second Job', rank: 2),
            ],
          }),
          200,
        );
      }
      applyReq = req; // assert OUTSIDE the handler (inner expect would throw)
      return http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'application_id': 'app-1',
          'action': 'applied',
        }),
        200,
      );
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('swipeApplyButton')));
    await tester.pumpAndSettle();

    expect(applyReq?.url.path, '/applications/job-1/apply');
    expect(applyReq?.headers['authorization'], 'Bearer test-token');
    // J3: stays on the Feed (advances the deck), confirms with a SnackBar.
    expect(find.text('Applied'), findsOneWidget);
    expect(find.text('Second Job'), findsOneWidget);
  });

  testWidgets('Skip commits, hits the skip endpoint, toasts and advances', (
    WidgetTester tester,
  ) async {
    String? skipPath;
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      if (req.url.path == '/feed') {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[
              _job(id: 'job-1', title: 'First Job', rank: 1),
              _job(id: 'job-2', title: 'Second Job', rank: 2),
            ],
          }),
          200,
        );
      }
      skipPath = req.url.path;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'application_id': 'app-1',
          'action': 'skipped',
        }),
        200,
      );
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    expect(find.text('First Job'), findsOneWidget);

    await tester.tap(find.byKey(const Key('swipeSkipButton')));
    await tester.pumpAndSettle();

    expect(skipPath, '/applications/job-1/skip');
    expect(find.text('First Job'), findsNothing);
    expect(find.text('Second Job'), findsOneWidget);
    // J3: skip now confirms with a SnackBar (previously silent).
    expect(find.text('Skipped'), findsOneWidget);
  });

  testWidgets('skip failure keeps the card and shows a retry snackbar', (
    WidgetTester tester,
  ) async {
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      if (req.url.path == '/feed') {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[_job(id: 'job-1', title: 'Stay Put')],
          }),
          200,
        );
      }
      throw Exception('no network');
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('swipeSkipButton')));
    await tester.pump(); // start the fly-off
    await tester.pump(const Duration(milliseconds: 400)); // commit + catch/emit
    await tester.pump(const Duration(milliseconds: 400)); // snackbar entrance

    expect(find.text('Stay Put'), findsOneWidget);
    expect(find.text('Could not save. Please try again.'), findsOneWidget);
  });

  testWidgets('403 on load routes the worker back to consent', (
    WidgetTester tester,
  ) async {
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'message': 'worker has not accepted consent'}),
        403,
      );
    }));

    await tester.pumpWidget(_harness(bloc));
    await tester.pumpAndSettle();

    expect(find.text('Please accept consent to see jobs.'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Go to consent'));
    await tester.pumpAndSettle();

    expect(find.text('I agree'), findsOneWidget);
  });
}

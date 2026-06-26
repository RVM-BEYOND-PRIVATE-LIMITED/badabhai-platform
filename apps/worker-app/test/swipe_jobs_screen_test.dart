import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
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
/// This preserves the exact MockClient request-matching (paths, Bearer, 403).
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

/// Mounts the swipe screen with an injected bloc as the initial route, while the
/// real app routes (e.g. consent) stay reachable for the 403-redirect test.
Widget _harness(SwipeBloc bloc) {
  return MaterialApp(
    onGenerateRoute: (RouteSettings settings) {
      if (settings.name == '/') {
        return MaterialPageRoute<void>(
          builder: (_) => SwipeJobsScreen(bloc: bloc),
          settings: settings,
        );
      }
      final WidgetBuilder? builder = appRoutes[settings.name];
      if (builder != null) {
        return MaterialPageRoute<void>(builder: builder, settings: settings);
      }
      return null;
    },
  );
}

void main() {
  // The 403 scenario navigates to the real ConsentScreen via appRoutes, which
  // resolves its cubit from get_it — so the locator must be wired. Idempotent.
  setUpAll(setupLocator);

  testWidgets('renders the first job card with coarse fields only', (
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

    // Worker-scoped feed request carried the bearer token.
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

    expect(find.text('Could not load jobs.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });

  testWidgets('Apply posts to the apply endpoint and advances to empty', (
    WidgetTester tester,
  ) async {
    String? applyPath;
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      if (req.url.path == '/feed') {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[_job(id: 'job-1')],
          }),
          200,
        );
      }
      applyPath = req.url.path;
      expect(req.headers['authorization'], 'Bearer test-token');
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

    expect(applyPath, '/applications/job-1/apply');
    expect(find.text('No more jobs right now.'), findsOneWidget);
  });

  testWidgets('Skip posts to the skip endpoint and advances to next card', (
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
  });

  testWidgets('apply failure keeps the card and shows a retry snackbar', (
    WidgetTester tester,
  ) async {
    bool feedServed = false;
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      if (req.url.path == '/feed') {
        feedServed = true;
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
    expect(feedServed, isTrue);

    await tester.tap(find.byKey(const Key('swipeApplyButton')));
    await tester.pump(); // start the future + run the catch/emit
    await tester.pump(const Duration(milliseconds: 750)); // snackbar entrance

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

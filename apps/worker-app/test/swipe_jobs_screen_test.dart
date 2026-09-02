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
import 'package:badabhai_worker_app/features/swipe/data/job_feed_view_store.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/job_deck.dart';
import 'package:badabhai_worker_app/router.dart';

/// A phone-tall surface — the swipe deck needs real vertical room for its
/// stacked cards + CTA row, unlike the scrollable list (which is fine at the
/// default test surface size).
void _tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(400, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Records every write so a test can assert the toggle persists through the
/// store, without touching the real `shared_preferences` plugin.
class _FakeJobFeedViewStore implements JobFeedViewStore {
  JobFeedViewMode _mode = JobFeedViewMode.list;
  final List<JobFeedViewMode> written = <JobFeedViewMode>[];

  @override
  Future<JobFeedViewMode> read() async => _mode;

  @override
  Future<void> write(JobFeedViewMode mode) async {
    written.add(mode);
    _mode = mode;
  }
}

/// A single seeded feed job in the API's JSON shape (snake_case). Pay/shift
/// (the ADR-0024 addendum's additive keys) are only included when set, so the
/// default fixture doubles as the OLD wire shape — proving it still parses.
Map<String, dynamic> _job({
  required String id,
  String trade = 'cnc_operator',
  String title = 'CNC Operator',
  String city = 'Pune',
  String? area = 'Chakan',
  int rank = 1,
  int? payMin,
  int? payMax,
  String? shift,
}) {
  return <String, dynamic>{
    'job_id': id,
    'trade_key': trade,
    'title': title,
    'city': city,
    'area': area,
    'rank': rank,
    if (payMin != null) 'pay_min': payMin,
    if (payMax != null) 'pay_max': payMax,
    if (shift != null) 'shift': shift,
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
/// reach: `/consent` (403) and `/jobs/detail/:id` (title tap). Inline apply stays
/// on the Feed and confirms with a SnackBar (no Applied screen navigation).
/// The detail stand-in exposes a DETAIL_APPLY button that pops `'applied'` —
/// exactly what the real JobDetailScreen does after a successful apply — so the
/// H-1 prune path can be driven end-to-end.
Widget _harness(SwipeBloc bloc) {
  final GoRouter router = GoRouter(
    initialLocation: '/jobs',
    routes: <RouteBase>[
      GoRoute(path: '/jobs', builder: (_, __) => SwipeJobsScreen(bloc: bloc)),
      GoRoute(
        path: '/jobs/detail/:jobId',
        builder: (_, GoRouterState s) => Scaffold(
          body: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                Text('DETAIL ${s.pathParameters['jobId']}'),
                Builder(
                  builder: (BuildContext context) => TextButton(
                    onPressed: () => context.pop('applied'),
                    child: const Text('DETAIL_APPLY'),
                  ),
                ),
              ],
            ),
          ),
        ),
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

  testWidgets('renders a feed job card with title, place and the REAL '
      'pay band from the feed (ADR-0024 addendum)', (
    WidgetTester tester,
  ) async {
    http.Request? captured;
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'jobs': <Map<String, dynamic>>[
            _job(
              id: 'job-1',
              title: 'VMC Operator',
              city: 'Pune',
              payMin: 16000,
              payMax: 26000,
              shift: 'day',
            ),
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
    // Real wire pay renders compactly; still NOTHING employer-shaped and no
    // spots-left (frozen — never set). The list card wires an inline APPLY, so
    // its meta slot shows the action rather than the shift (shift lives on the
    // detail screen).
    expect(find.text('₹16k–26k'), findsOneWidget);
    expect(find.byIcon(Icons.verified), findsNothing);
    expect(find.textContaining('spots'), findsNothing);
    // Every card carries the inline green "APPLY →"; the swipe deck is retired.
    expect(find.byKey(const Key('jobCardApplyButton')), findsOneWidget);
    expect(find.byKey(const Key('swipeSkipButton')), findsNothing);
  });

  testWidgets('a feed job WITHOUT pay/shift keys (old shape) renders no pay '
      'or shift row — hidden, never invented', (
    WidgetTester tester,
  ) async {
    final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
      
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

    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.byIcon(Icons.currency_rupee), findsNothing);
    expect(find.byIcon(Icons.schedule), findsNothing);
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

  testWidgets(
      'inline APPLY on a card hits the apply endpoint for THAT job and toasts '
      '(no nav)', (
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

    // Tap the FIRST card's inline "APPLY →" (every card carries the same key).
    await tester.tap(find.byKey(const Key('jobCardApplyButton')).first);
    await tester.pumpAndSettle();

    expect(applyReq?.url.path, '/applications/job-1/apply');
    expect(applyReq?.headers['authorization'], 'Bearer test-token');
    // J3: stays on the Feed (drops the applied card), confirms with a SnackBar.
    expect(find.text('Applied'), findsOneWidget);
    expect(find.text('First Job'), findsNothing);
    expect(find.text('Second Job'), findsOneWidget);
  });

  testWidgets(
      'H-1: applying from the DETAIL screen prunes the job from the list so it '
      'cannot linger and be re-decided', (
    WidgetTester tester,
  ) async {
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

    // Open the first card's detail (title tap) and apply from THERE (JobDetail
    // path — it pops 'applied' after its own POST, bypassing SwipeBloc's inline
    // apply entirely).
    await tester.tap(find.text('First Job'));
    await tester.pumpAndSettle();
    expect(find.text('DETAIL job-1'), findsOneWidget);
    await tester.tap(find.text('DETAIL_APPLY'));
    await tester.pumpAndSettle();

    // Back on the Feed: toast shown and the just-applied job is GONE from the
    // list — it can no longer sit around waiting to be re-decided.
    expect(find.text('Applied'), findsOneWidget);
    expect(find.text('First Job'), findsNothing);
    expect(find.text('Second Job'), findsOneWidget);
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

  group('list <-> deck view toggle', () {
    testWidgets(
        'the header toggle switches the body between ListView and JobDeck',
        (WidgetTester tester) async {
      _tallSurface(tester);
      final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[
              _job(id: 'job-1', title: 'First Job', rank: 1),
              _job(id: 'job-2', title: 'Second Job', rank: 2),
            ],
          }),
          200,
        );
      }));

      await tester.pumpWidget(_harness(bloc));
      await tester.pumpAndSettle();

      // Defaults to the list — the swipe deck is not on screen.
      expect(find.byType(ListView), findsOneWidget);
      expect(find.byType(JobDeck), findsNothing);

      await tester.tap(find.byKey(const Key('jobFeedViewToggle')));
      await tester.pumpAndSettle();

      // Same header, same jobs — only the body swapped to the deck.
      expect(find.byType(JobDeck), findsOneWidget);
      expect(find.byType(ListView), findsNothing);
      expect(find.text('First Job'), findsOneWidget);

      // Toggling back returns to the list.
      await tester.tap(find.byKey(const Key('jobFeedViewToggle')));
      await tester.pumpAndSettle();

      expect(find.byType(ListView), findsOneWidget);
      expect(find.byType(JobDeck), findsNothing);
    });

    testWidgets(
        'in deck mode, tapping the deck APPLY button hits the SAME apply '
        'endpoint the list uses and advances the queue', (
      WidgetTester tester,
    ) async {
      _tallSurface(tester);
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

      await tester.tap(find.byKey(const Key('jobFeedViewToggle')));
      await tester.pumpAndSettle();
      expect(find.byType(JobDeck), findsOneWidget);

      // The deck's own big Apply button — same key job_deck_test.dart asserts on.
      await tester.tap(find.byKey(const Key('swipeApplyButton')));
      await tester.pumpAndSettle();

      // Dispatched via SwipeApplied (head-of-queue), hitting the SAME endpoint
      // the list's per-id SwipeCardApplied does.
      expect(applyReq?.url.path, '/applications/job-1/apply');
      expect(applyReq?.headers['authorization'], 'Bearer test-token');
      // Same success toast + queue advance as the list's inline apply.
      expect(find.text('Applied'), findsOneWidget);
      expect(find.text('First Job'), findsNothing);
      expect(find.text('Second Job'), findsOneWidget);
    });

    testWidgets('toggling the view calls through to the store\'s write', (
      WidgetTester tester,
    ) async {
      _tallSurface(tester);
      final _FakeJobFeedViewStore store = _FakeJobFeedViewStore();
      locator.registerSingleton<JobFeedViewStore>(store);
      addTearDown(() => locator.unregister<JobFeedViewStore>());

      final SwipeBloc bloc = _bloc(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[
              _job(id: 'job-1', title: 'First Job'),
            ],
          }),
          200,
        );
      }));

      await tester.pumpWidget(_harness(bloc));
      await tester.pumpAndSettle();
      expect(store.written, isEmpty);

      await tester.tap(find.byKey(const Key('jobFeedViewToggle')));
      await tester.pumpAndSettle();
      expect(store.written, <JobFeedViewMode>[JobFeedViewMode.deck]);

      await tester.tap(find.byKey(const Key('jobFeedViewToggle')));
      await tester.pumpAndSettle();
      expect(store.written,
          <JobFeedViewMode>[JobFeedViewMode.deck, JobFeedViewMode.list]);
    });
  });
}

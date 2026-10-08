import 'dart:async';
import 'dart:convert';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/job_feed_invalidation.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_state.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';

/// Demo liveness: the Jobs feed reflects new postings and trade/skill edits
/// without a cold restart — header refresh (deck), app resume, and the
/// [JobFeedInvalidation] signal the match-input writers fire.

class _MockSwipeRepository extends Mock implements SwipeRepository {}

FeedItem _item(String id) => FeedItem(
      jobId: id,
      tradeKey: 't',
      title: 'T',
      city: 'C',
      area: null,
      rank: 1,
    );

/// Stubs `getFeed` with [answer]'s cards as ONE page — `next_cursor` null, so
/// nothing in this file pages (#2068). Paging has its own suite.
void _stubFeed(_MockSwipeRepository repo, Future<List<FeedItem>> Function() answer) {
  when(() => repo.getFeed(
        tradeKey: any(named: 'tradeKey'),
        city: any(named: 'city'),
        shift: any(named: 'shift'),
        payMin: any(named: 'payMin'),
        cursor: any(named: 'cursor'),
      )).thenAnswer((_) async =>
      FeedPage(jobs: await answer(), nextCursor: null));
}

void _verifyFeedCalls(_MockSwipeRepository repo, int times) {
  verify(() => repo.getFeed(
        tradeKey: any(named: 'tradeKey'),
        city: any(named: 'city'),
        shift: any(named: 'shift'),
        payMin: any(named: 'payMin'),
        cursor: any(named: 'cursor'),
      )).called(times);
}

Map<String, dynamic> _job(String id, String title) => <String, dynamic>{
      'job_id': id,
      'trade_key': 'cnc_operator',
      'title': title,
      'city': 'Pune',
      'area': 'Chakan',
      'rank': 1,
    };

/// A feed backend that serves [pages] in order (the last one repeats) and
/// counts every `GET /feed`.
class _FeedServer {
  _FeedServer(this.pages);

  final List<List<Map<String, dynamic>>> pages;
  int calls = 0;

  MockClient get client => MockClient((http.Request req) async {
        final List<Map<String, dynamic>> jobs =
            pages[calls < pages.length ? calls : pages.length - 1];
        calls++;
        return http.Response(
          jsonEncode(<String, dynamic>{'jobs': jobs}),
          200,
        );
      });
}

SwipeBloc _bloc(_FeedServer server) {
  final SessionRepository session = SessionRepository()
    ..setWorker(
      phone: '+910000000000',
      workerId: 'worker-1',
      sessionToken: 'test-token',
    );
  return SwipeBloc(SwipeRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: server.client),
    session,
  ));
}

void _tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(400, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _harness(SwipeBloc bloc) =>
    MaterialApp(home: SwipeJobsScreen(bloc: bloc));

void main() {
  group('SwipeBloc feed requests', () {
    late _MockSwipeRepository repo;
    setUp(() => repo = _MockSwipeRepository());

    test('done completes when the load it rode settles', () async {
      final Completer<List<FeedItem>> gate = Completer<List<FeedItem>>();
      _stubFeed(repo, () => gate.future);
      final SwipeBloc bloc = SwipeBloc(repo);
      addTearDown(bloc.close);

      final Completer<void> done = Completer<void>();
      bloc.add(SwipeFeedRequested(background: true, done: done));
      await pumpEventQueue();
      expect(done.isCompleted, isFalse);

      gate.complete(<FeedItem>[_item('j1')]);
      await done.future;
      expect(bloc.state.status, SwipeStatus.ready);
    });

    test('done still completes when the load fails', () async {
      _stubFeed(repo, () async => throw const NetworkFailure());
      final SwipeBloc bloc = SwipeBloc(repo);
      addTearDown(bloc.close);

      final Completer<void> done = Completer<void>();
      bloc.add(SwipeFeedRequested(background: true, done: done));
      await done.future.timeout(const Duration(seconds: 1));
    });

    test('done completes even on an unexpected (non-Failure) throw', () async {
      _stubFeed(repo, () async => throw StateError('bug'));
      final Completer<void> done = Completer<void>();
      final List<Object> uncaught = <Object>[];
      // Bloc reports an uncaught handler error into the zone it was built in,
      // so build it inside a guarded zone and assert the error surfaced there.
      runZonedGuarded(() {
        final SwipeBloc bloc = SwipeBloc(repo);
        addTearDown(bloc.close);
        bloc.add(SwipeFeedRequested(background: true, done: done));
      }, (Object error, StackTrace _) => uncaught.add(error));
      await done.future.timeout(const Duration(seconds: 1));
      expect(uncaught.single, isA<StateError>());
    });

    test('a plain request during an in-flight load is coalesced into it',
        () async {
      final Completer<List<FeedItem>> gate = Completer<List<FeedItem>>();
      _stubFeed(repo, () => gate.future);
      final SwipeBloc bloc = SwipeBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const SwipeFeedRequested());
      await pumpEventQueue();
      final Completer<void> done = Completer<void>();
      bloc.add(SwipeFeedRequested(background: true, done: done));
      await pumpEventQueue();

      gate.complete(<FeedItem>[_item('j1')]);
      await done.future;
      await pumpEventQueue();
      _verifyFeedCalls(repo, 1);
    });

    test('a FRESH request during an in-flight load re-runs after it, so a '
        'load that predates a profile edit cannot swallow it', () async {
      final List<Completer<List<FeedItem>>> gates =
          <Completer<List<FeedItem>>>[];
      _stubFeed(repo, () {
        final Completer<List<FeedItem>> gate = Completer<List<FeedItem>>();
        gates.add(gate);
        return gate.future;
      });
      final SwipeBloc bloc = SwipeBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const SwipeFeedRequested());
      await pumpEventQueue();
      final Completer<void> done = Completer<void>();
      bloc.add(
        SwipeFeedRequested(background: true, fresh: true, done: done),
      );
      await pumpEventQueue();

      gates[0].complete(<FeedItem>[_item('old')]);
      await pumpEventQueue();
      expect(done.isCompleted, isFalse,
          reason: 'served by the re-run, not the stale load');
      expect(gates, hasLength(2));

      gates[1].complete(<FeedItem>[_item('new')]);
      await done.future;
      expect(bloc.state.queue.map((FeedItem j) => j.jobId), <String>['new']);
      _verifyFeedCalls(repo, 2);
    });

    blocTest<SwipeBloc, SwipeState>(
      'the queued re-run is a background load — no loader over a fresh deck',
      build: () {
        int n = 0;
        _stubFeed(repo, () async {
          n++;
          await Future<void>.delayed(const Duration(milliseconds: 10));
          return <FeedItem>[_item('j$n')];
        });
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) async {
        b.add(const SwipeFeedRequested());
        await Future<void>.delayed(Duration.zero);
        b.add(const SwipeFeedRequested(background: true, fresh: true));
      },
      wait: const Duration(milliseconds: 60),
      expect: () => <SwipeState>[
        const SwipeState(status: SwipeStatus.loading),
        SwipeState(status: SwipeStatus.ready, queue: <FeedItem>[_item('j1')]),
        SwipeState(status: SwipeStatus.ready, queue: <FeedItem>[_item('j2')]),
      ],
    );
  });

  group('Jobs screen liveness', () {
    setUpAll(setupLocator);
    setUp(() => locator<TabFocus>().value = TabIndex.jobs);

    testWidgets('deck header refresh refetches and shows the new posting',
        (WidgetTester tester) async {
      _tallSurface(tester);
      final _FeedServer server = _FeedServer(<List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[_job('j1', 'CNC Operator')],
        <Map<String, dynamic>>[
          _job('j2', 'VMC Setter'),
          _job('j1', 'CNC Operator'),
        ],
      ]);
      await tester.pumpWidget(_harness(_bloc(server)));
      await tester.pumpAndSettle();
      expect(server.calls, 1);
      expect(find.text('VMC Setter'), findsNothing);

      await tester.tap(find.byKey(const Key('jobFeedRefresh')));
      await tester.pumpAndSettle();

      expect(server.calls, 2);
      expect(find.text('VMC Setter'), findsWidgets);
      // Back to the glyph once the real load settled.
      expect(find.byKey(const Key('jobFeedRefresh')), findsOneWidget);
      expect(find.byKey(const Key('jobFeedRefreshing')), findsNothing);
    });

    testWidgets('while refreshing, the slot stays a labelled, disabled button '
        '(screen readers hear that jobs are loading)', (
      WidgetTester tester,
    ) async {
      _tallSurface(tester);
      final SemanticsHandle semantics = tester.ensureSemantics();
      final Completer<void> gate = Completer<void>();
      int calls = 0;
      final MockClient client = MockClient((http.Request req) async {
        calls++;
        if (calls > 1) await gate.future;
        return http.Response(
          jsonEncode(<String, dynamic>{
            'jobs': <Map<String, dynamic>>[_job('j1', 'CNC Operator')],
          }),
          200,
        );
      });
      final SessionRepository session = SessionRepository()
        ..setWorker(
          phone: '+910000000000',
          workerId: 'worker-1',
          sessionToken: 'test-token',
        );
      await tester.pumpWidget(_harness(SwipeBloc(SwipeRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: client),
        session,
      ))));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('jobFeedRefresh')));
      await tester.pump();

      expect(find.byKey(const Key('jobFeedRefresh')), findsNothing);
      expect(find.bySemanticsLabel('Naye jobs aa rahe hain'), findsOneWidget);

      gate.complete();
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('jobFeedRefresh')), findsOneWidget);
      semantics.dispose();
    });

    testWidgets('app resume refetches a visible feed', (
      WidgetTester tester,
    ) async {
      _tallSurface(tester);
      final _FeedServer server = _FeedServer(<List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[],
        <Map<String, dynamic>>[_job('j9', 'Welder')],
      ]);
      await tester.pumpWidget(_harness(_bloc(server)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('jobFeedEmpty')), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(server.calls, 2);
      expect(find.text('Welder'), findsWidgets);
    });

    testWidgets('app resume does NOT refetch while another tab is on screen',
        (WidgetTester tester) async {
      _tallSurface(tester);
      final _FeedServer server = _FeedServer(<List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[_job('j1', 'CNC Operator')],
      ]);
      await tester.pumpWidget(_harness(_bloc(server)));
      await tester.pumpAndSettle();

      locator<TabFocus>().value = TabIndex.profile;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(server.calls, 1);
    });

    testWidgets('a trade/skill edit (JobFeedInvalidation) refetches a visible '
        'feed', (WidgetTester tester) async {
      _tallSurface(tester);
      final _FeedServer server = _FeedServer(<List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[_job('j1', 'CNC Operator')],
        <Map<String, dynamic>>[_job('j3', 'Electrician')],
      ]);
      await tester.pumpWidget(_harness(_bloc(server)));
      await tester.pumpAndSettle();

      locator<JobFeedInvalidation>().invalidate();
      await tester.pumpAndSettle();

      expect(server.calls, 2);
      expect(find.text('Electrician'), findsWidgets);
    });

    testWidgets('an edit made on another tab defers to the tab-focus refetch',
        (WidgetTester tester) async {
      _tallSurface(tester);
      final _FeedServer server = _FeedServer(<List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[_job('j1', 'CNC Operator')],
        <Map<String, dynamic>>[_job('j3', 'Electrician')],
      ]);
      await tester.pumpWidget(_harness(_bloc(server)));
      await tester.pumpAndSettle();

      locator<TabFocus>().value = TabIndex.profile;
      locator<JobFeedInvalidation>().invalidate();
      await tester.pumpAndSettle();
      expect(server.calls, 1, reason: 'no fetch while Jobs is off screen');

      // Wrapped by TabFocusRefetch: returning to Jobs reloads once.
      locator<TabFocus>().value = TabIndex.jobs;
      await tester.pumpAndSettle();
      expect(server.calls, 2);
      expect(find.text('Electrician'), findsWidgets);
    });

    testWidgets('an empty feed says the profile is being matched — not an '
        'error', (WidgetTester tester) async {
      _tallSurface(tester);
      final _FeedServer server = _FeedServer(<List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[],
      ]);
      await tester.pumpWidget(_harness(_bloc(server)));
      await tester.pumpAndSettle();

      expect(
        find.text('Aapki profile se jobs match ho rahi hain.'),
        findsOneWidget,
      );
      expect(find.text('Jobs load nahi hue.'), findsNothing);
      expect(find.byIcon(Icons.error_outline_rounded), findsNothing);
    });
  });
}

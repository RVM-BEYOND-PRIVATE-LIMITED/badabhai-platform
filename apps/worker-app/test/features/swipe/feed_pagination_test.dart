import 'dart:async';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/features/swipe/data/job_feed_view_store.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_state.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';

/// #2068 (ADR-0052) — the Jobs tab consumes `GET /feed`'s `next_cursor`.
///
/// The rules under test, all of them from the issue:
///
///  * the cursor is OPAQUE — stored and resent byte-for-byte, never parsed;
///  * a MISSING `next_cursor` is null, so an older API build (or a rollback of
///    PR #2067) is one page and nothing pages;
///  * a filter change or a page-1 (re)load drops the cursor;
///  * appended pages are deduped by `job_id` (the V1 boost-expiry re-serve);
///  * a cursor 400 falls back to page 1 SILENTLY — no error view, and the dead
///    cursor never goes back on the wire;
///  * a failed cursor page keeps the deck AND the cursor, so a retry re-sends
///    the same value (the read is idempotent).
class _MockSwipeRepository extends Mock implements SwipeRepository {}

FeedItem _item(String id) => FeedItem(
      jobId: id,
      tradeKey: 'cnc_operator',
      title: 'CNC Operator',
      city: 'Pune',
      area: null,
      rank: 1,
    );

List<FeedItem> _items(Iterable<String> ids) =>
    ids.map(_item).toList(growable: false);

List<String> _ids(List<FeedItem> jobs) =>
    jobs.map((FeedItem job) => job.jobId).toList();

/// The ONE `getFeed` matcher list: mocktail matches the named-arg KEY SET
/// exactly, and the bloc always sends `cursor` (null on page 1).
When<Future<FeedPage>> _whenFeed(_MockSwipeRepository repo) => when(
      () => repo.getFeed(
        tradeKey: any(named: 'tradeKey'),
        city: any(named: 'city'),
        shift: any(named: 'shift'),
        payMin: any(named: 'payMin'),
        cursor: any(named: 'cursor'),
      ),
    );

/// The cursor each `getFeed` carried, in call order — `null` is a page-1 read.
/// Asserting on this list is how "never resend a rejected cursor" and "the
/// cursor goes out untouched" are proved.
List<String?> _recordCursors(_MockSwipeRepository repo) {
  final List<String?> sent = <String?>[];
  _whenFeed(repo).thenAnswer((Invocation call) async {
    sent.add(call.namedArguments[const Symbol('cursor')] as String?);
    return const FeedPage(jobs: <FeedItem>[], nextCursor: null);
  });
  return sent;
}

/// Serves [pages] keyed by the cursor sent (`null` = page 1) and records the
/// cursors in [sent]. A cursor with no page is a test bug, not a server state,
/// so it throws loudly instead of quietly answering page 1.
void _stubPages(
  _MockSwipeRepository repo,
  Map<String?, FutureOr<FeedPage> Function()> pages, {
  List<String?>? sent,
}) {
  _whenFeed(repo).thenAnswer((Invocation call) async {
    final String? cursor =
        call.namedArguments[const Symbol('cursor')] as String?;
    sent?.add(cursor);
    final FutureOr<FeedPage> Function()? page = pages[cursor];
    if (page == null) throw StateError('no page stubbed for cursor: $cursor');
    return page();
  });
}

FutureOr<FeedPage> Function() _page(
  List<String> ids, {
  String? nextCursor,
}) =>
    () => FeedPage(jobs: _items(ids), nextCursor: nextCursor);

FutureOr<FeedPage> Function() _throws(Failure failure) =>
    () => throw failure;

/// Forces LIST mode: the screen defaults to the deck, and the real store is
/// plugin-backed, so a fake is the only way to reach the scrollable body —
/// which is the view a worker empties by SCROLLING rather than by deciding.
class _ListViewStore implements JobFeedViewStore {
  @override
  Future<JobFeedViewMode> read() async => JobFeedViewMode.list;

  @override
  Future<void> write(JobFeedViewMode mode) async {}
}

/// Cursors captured by the recording stubs, in call order. Cleared per test.
final List<String?> _sent = <String?>[];

void main() {
  late _MockSwipeRepository repo;
  setUp(() {
    repo = _MockSwipeRepository();
    _sent.clear();
  });

  group('next page', () {
    blocTest<SwipeBloc, SwipeState>(
      'page 1 stores next_cursor, and the next page APPENDS and carries the '
      'cursor forward',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          null: _page(<String>['j1', 'j2'], nextCursor: 'C1'),
          'C1': _page(<String>['j3'], nextCursor: 'C2'),
        });
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) async {
        b.add(const SwipeFeedRequested());
        await pumpEventQueue();
        b.add(const SwipeNextPageRequested());
      },
      verify: (SwipeBloc b) {
        expect(_ids(b.state.queue), <String>['j1', 'j2', 'j3']);
        expect(b.state.nextCursor, 'C2');
        expect(b.state.status, SwipeStatus.ready);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a next page emits no loader and no error view — it is behind the '
      'worker\'s back',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _page(<String>['j2'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      expect: () => <SwipeState>[
        SwipeState(
          status: SwipeStatus.ready,
          queue: _items(<String>['j1', 'j2']),
        ),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      'a null cursor is the END of the deck: the request is a no-op',
      build: () {
        _recordCursors(repo);
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      expect: () => <SwipeState>[],
      verify: (_) => verifyNever(
        () => repo.getFeed(
          tradeKey: any(named: 'tradeKey'),
          city: any(named: 'city'),
          shift: any(named: 'shift'),
          payMin: any(named: 'payMin'),
          cursor: any(named: 'cursor'),
        ),
      ),
    );

    blocTest<SwipeBloc, SwipeState>(
      'a server that does not send next_cursor at all is one page — the '
      'pre-#2067 build and any rollback',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          // What `FeedPage.fromJson` produces from `{jobs: [...]}`.
          null: _page(<String>['j1'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) async {
        b.add(const SwipeFeedRequested());
        await pumpEventQueue();
        b.add(const SwipeNextPageRequested());
      },
      verify: (SwipeBloc b) {
        expect(b.state.nextCursor, isNull);
        expect(_ids(b.state.queue), <String>['j1']);
        // One read only: page 1. Nothing tried to page.
        verify(
          () => repo.getFeed(
            tradeKey: any(named: 'tradeKey'),
            city: any(named: 'city'),
            shift: any(named: 'shift'),
            payMin: any(named: 'payMin'),
            cursor: any(named: 'cursor'),
          ),
        ).called(1);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'the cursor goes back out UNTOUCHED — never parsed, never rebuilt',
      build: () {
        _stubPages(
          repo,
          <String?, FutureOr<FeedPage> Function()>{
            'eyJ2IjoxLCJtIjoidjEiLCJvIjo1MH0': _page(<String>['j2']),
          },
          sent: _sent,
        );
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'eyJ2IjoxLCJtIjoidjEiLCJvIjo1MH0',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      verify: (_) =>
          expect(_sent, <String?>['eyJ2IjoxLCJtIjoidjEiLCJvIjo1MH0']),
    );

    blocTest<SwipeBloc, SwipeState>(
      'repeated requests while a page is in flight send ONE read',
      build: () {
        final Completer<FeedPage> gate = Completer<FeedPage>();
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': () => gate.future,
        });
        // Settle it after the burst so the handler completes inside the test.
        Future<void>.delayed(
          const Duration(milliseconds: 10),
          () => gate.complete(const FeedPage(jobs: <FeedItem>[], nextCursor: null)),
        );
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) {
        b.add(const SwipeNextPageRequested());
        b.add(const SwipeNextPageRequested());
        b.add(const SwipeNextPageRequested());
      },
      wait: const Duration(milliseconds: 40),
      verify: (_) => verify(
        () => repo.getFeed(
          tradeKey: any(named: 'tradeKey'),
          city: any(named: 'city'),
          shift: any(named: 'shift'),
          payMin: any(named: 'payMin'),
          cursor: any(named: 'cursor'),
        ),
      ).called(1),
    );
  });

  group('dedupe by job_id', () {
    blocTest<SwipeBloc, SwipeState>(
      'a card re-served on the next page (ADR-0052 §3.3 boost expiry) is not '
      'appended twice',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _page(<String>['j2', 'j1', 'j3'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1', 'j2']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      verify: (SwipeBloc b) {
        // j1 and j2 keep their original places; only j3 is new.
        expect(_ids(b.state.queue), <String>['j1', 'j2', 'j3']);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a page of nothing BUT duplicates still advances the cursor',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _page(<String>['j1'], nextCursor: 'C2'),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      verify: (SwipeBloc b) {
        expect(_ids(b.state.queue), <String>['j1']);
        expect(b.state.nextCursor, 'C2');
      },
    );
  });

  group('the cursor is dropped when the scroll it belongs to ends', () {
    blocTest<SwipeBloc, SwipeState>(
      'a FILTER change drops it — a cursor is a position in the OLD order',
      build: () {
        _recordCursors(repo);
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) async {
        b.add(const SwipeFiltersChanged(
          FilterSelection(
            trades: <String>{'CNC'},
            cities: <String>{},
            experienceBands: <String>{},
          ),
        ));
        await pumpEventQueue();
        // Nothing may page on the old cursor afterwards.
        b.add(const SwipeNextPageRequested());
      },
      verify: (SwipeBloc b) {
        expect(b.state.nextCursor, isNull);
        // The loaded deck is untouched — the chips still narrow client-side.
        expect(_ids(b.state.queue), <String>['j1']);
        verifyNever(
          () => repo.getFeed(
            tradeKey: any(named: 'tradeKey'),
            city: any(named: 'city'),
            shift: any(named: 'shift'),
            payMin: any(named: 'payMin'),
            cursor: any(named: 'cursor'),
          ),
        );
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a pull-to-refresh (page 1) replaces the deck AND the cursor',
      build: () {
        _stubPages(
          repo,
          <String?, FutureOr<FeedPage> Function()>{
            null: _page(<String>['fresh'], nextCursor: 'C9'),
          },
          sent: _sent,
        );
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['stale1', 'stale2']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeFeedRequested(background: true)),
      verify: (SwipeBloc b) {
        // The refresh read page 1 — the old cursor was NOT sent.
        expect(_sent, <String?>[null]);
        expect(_ids(b.state.queue), <String>['fresh']);
        expect(b.state.nextCursor, 'C9');
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a page-1 reload that comes back WITHOUT a cursor clears the old one',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          null: _page(<String>['j1'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['old']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeFeedRequested(background: true)),
      verify: (SwipeBloc b) => expect(b.state.nextCursor, isNull),
    );
  });

  group('a cursor 400 falls back to page 1 silently', () {
    blocTest<SwipeBloc, SwipeState>(
      'the deck restarts from page 1, with no error state and no retry of the '
      'rejected cursor',
      build: () {
        _stubPages(
          repo,
          <String?, FutureOr<FeedPage> Function()>{
            'C1': _throws(const FeedCursorRejectedFailure()),
            null: _page(<String>['j1', 'j2'], nextCursor: 'C9'),
          },
          sent: _sent,
        );
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['stale']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      verify: (SwipeBloc b) {
        // The rejected cursor went out ONCE, then page 1 — never again.
        expect(_sent, <String?>['C1', null]);
        expect(_ids(b.state.queue), <String>['j1', 'j2']);
        expect(b.state.nextCursor, 'C9');
        expect(b.state.status, SwipeStatus.ready);
        expect(b.state.failure, isNull);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'the worker never sees a loader or an error frame while it happens',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _throws(const FeedCursorRejectedFailure()),
          null: _page(<String>['j1'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['stale']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      verify: (SwipeBloc b) => expect(b.state.status, SwipeStatus.ready),
      expect: () => <SwipeState>[
        // 1. the dead cursor is dropped before anything else can send it
        SwipeState(
          status: SwipeStatus.ready,
          queue: _items(<String>['stale']),
        ),
        // 2. page 1 lands. No `loading`, no `error` in between.
        SwipeState(status: SwipeStatus.ready, queue: _items(<String>['j1'])),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      'a page-1 fallback that ALSO fails keeps the deck the worker is reading',
      build: () {
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _throws(const FeedCursorRejectedFailure()),
          null: _throws(const NetworkFailure()),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeNextPageRequested()),
      verify: (SwipeBloc b) {
        expect(b.state.status, SwipeStatus.ready);
        expect(_ids(b.state.queue), <String>['j1']);
        expect(b.state.nextCursor, isNull);
      },
    );
  });

  group('offline / retry', () {
    blocTest<SwipeBloc, SwipeState>(
      'a dropped cursor page keeps the deck AND the cursor, and the retry '
      're-sends the SAME cursor (the read is idempotent)',
      build: () {
        bool firstTry = true;
        _stubPages(
          repo,
          <String?, FutureOr<FeedPage> Function()>{
            'C1': () {
              if (firstTry) {
                firstTry = false;
                throw const NetworkFailure();
              }
              return FeedPage(jobs: _items(<String>['j2']), nextCursor: null);
            },
          },
          sent: _sent,
        );
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['j1']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) async {
        b.add(const SwipeNextPageRequested());
        await pumpEventQueue();
        // Between the two: no error view, no lost cards, cursor intact.
        expect(b.state.status, SwipeStatus.ready);
        expect(_ids(b.state.queue), <String>['j1']);
        expect(b.state.nextCursor, 'C1');
        b.add(const SwipeNextPageRequested());
      },
      verify: (SwipeBloc b) {
        expect(_sent, <String?>['C1', 'C1']);
        expect(_ids(b.state.queue), <String>['j1', 'j2']);
      },
    );
  });

  group('near the end of the deck', () {
    blocTest<SwipeBloc, SwipeState>(
      'draining the deck to the prefetch threshold asks for the next page — '
      'deck mode pages off decisions, not scrolling',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenAnswer((_) async {});
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _page(<String>['n1', 'n2'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      // One card over the threshold: the apply takes it to the threshold.
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>[
          for (int i = 0; i <= SwipeBloc.prefetchThreshold; i++) 'j$i',
        ]),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeApplied()),
      verify: (SwipeBloc b) {
        expect(b.state.queue.length, SwipeBloc.prefetchThreshold + 2);
        expect(_ids(b.state.queue).sublist(SwipeBloc.prefetchThreshold),
            <String>['n1', 'n2']);
        expect(b.state.nextCursor, isNull);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a deck well clear of the threshold does NOT page on every decision',
      build: () {
        when(() => repo.skipJob(any(), reason: any(named: 'reason')))
            .thenAnswer((_) async {});
        _recordCursors(repo);
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>[
          for (int i = 0; i < SwipeBloc.prefetchThreshold + 6; i++) 'j$i',
        ]),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeSkipped()),
      verify: (_) => expect(_sent, isEmpty),
    );

    blocTest<SwipeBloc, SwipeState>(
      'the page lands even after the deck has run dry — "no more jobs" is not '
      'the end while a cursor remains',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenAnswer((_) async {});
        _stubPages(repo, <String?, FutureOr<FeedPage> Function()>{
          'C1': _page(<String>['n1'], nextCursor: null),
        });
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: _items(<String>['last']),
        nextCursor: 'C1',
      ),
      act: (SwipeBloc b) => b.add(const SwipeApplied()),
      verify: (SwipeBloc b) {
        expect(_ids(b.state.queue), <String>['n1']);
        expect(b.state.status, SwipeStatus.ready);
      },
    );
  });

  group('the Jobs tab (list view)', () {
    setUp(() async {
      await locator.reset();
      locator.registerLazySingleton<TabFocus>(() => TabFocus());
      locator.registerSingleton<JobFeedViewStore>(_ListViewStore());
    });

    tearDown(() async => locator.reset());

    void tallSurface(WidgetTester tester) {
      tester.view.physicalSize = const Size(400, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
    }

    testWidgets('building a card near the bottom of the list fetches the next '
        'page and appends it', (WidgetTester tester) async {
      tallSurface(tester);
      _stubPages(
        repo,
        <String?, FutureOr<FeedPage> Function()>{
          null: _page(<String>['j1', 'j2'], nextCursor: 'C1'),
          'C1': _page(<String>['j3'], nextCursor: null),
        },
        sent: _sent,
      );
      final SwipeBloc bloc = SwipeBloc(repo);
      addTearDown(bloc.close);

      await tester.pumpWidget(MaterialApp(home: SwipeJobsScreen(bloc: bloc)));
      await tester.pumpAndSettle();

      // A 2-card page is inside the threshold, so rendering it asks for more.
      expect(_sent, <String?>[null, 'C1']);
      expect(_ids(bloc.state.queue), <String>['j1', 'j2', 'j3']);
      expect(bloc.state.nextCursor, isNull);
    });

    testWidgets('a list whose cursor is null asks for nothing, however often '
        'it rebuilds', (WidgetTester tester) async {
      tallSurface(tester);
      _stubPages(
        repo,
        <String?, FutureOr<FeedPage> Function()>{
          null: _page(<String>['j1', 'j2'], nextCursor: null),
        },
        sent: _sent,
      );
      final SwipeBloc bloc = SwipeBloc(repo);
      addTearDown(bloc.close);

      await tester.pumpWidget(MaterialApp(home: SwipeJobsScreen(bloc: bloc)));
      await tester.pumpAndSettle();
      await tester.pump();

      expect(_sent, <String?>[null]);
    });
  });
}

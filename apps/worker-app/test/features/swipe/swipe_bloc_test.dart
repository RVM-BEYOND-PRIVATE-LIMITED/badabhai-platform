import 'dart:async';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_state.dart';

class MockSwipeRepository extends Mock implements SwipeRepository {}

FeedItem _item(String id) => FeedItem(
      jobId: id,
      tradeKey: 't',
      title: 'T',
      city: 'C',
      area: null,
      rank: 1,
    );

/// A feed item whose trade is filterable (tradeKey doubles as the title source).
/// [city] and the experience window default to the values most tests ignore.
FeedItem _job(
  String id,
  String tradeKey, {
  String city = 'C',
  int? minYears,
  int? maxYears,
}) =>
    FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: tradeKey,
      city: city,
      area: null,
      minExperienceYears: minYears,
      maxExperienceYears: maxYears,
      rank: 1,
    );

List<String> _ids(List<FeedItem> jobs) =>
    jobs.map((FeedItem j) => j.jobId).toList();

/// A [FilterSelection] with only the dimensions a test cares about.
FilterSelection _sel({
  Set<String> trades = const <String>{},
  Set<String> cities = const <String>{},
  Set<String> bands = const <String>{},
}) =>
    FilterSelection(trades: trades, cities: cities, experienceBands: bands);

void main() {
  late MockSwipeRepository repo;
  setUp(() => repo = MockSwipeRepository());

  group('feed load', () {
    blocTest<SwipeBloc, SwipeState>(
      'loads -> ready with the queue',
      build: () {
        when(() => repo.getFeed())
            .thenAnswer((_) async => <FeedItem>[_item('j1'), _item('j2')]);
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) => b.add(const SwipeFeedRequested()),
      // bloc emits the first state even when it equals the initial `loading`.
      expect: () => <SwipeState>[
        const SwipeState(status: SwipeStatus.loading),
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1'), _item('j2')]),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      'empty feed -> empty',
      build: () {
        when(() => repo.getFeed()).thenAnswer((_) async => <FeedItem>[]);
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) => b.add(const SwipeFeedRequested()),
      expect: () => const <SwipeState>[
        SwipeState(status: SwipeStatus.loading),
        SwipeState(status: SwipeStatus.empty),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      '403 -> consentRequired',
      build: () {
        when(() => repo.getFeed()).thenThrow(const ConsentRequiredFailure());
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) => b.add(const SwipeFeedRequested()),
      expect: () => const <SwipeState>[
        SwipeState(status: SwipeStatus.loading),
        SwipeState(status: SwipeStatus.consentRequired),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      'network error -> error',
      build: () {
        when(() => repo.getFeed()).thenThrow(const NetworkFailure());
        return SwipeBloc(repo);
      },
      act: (SwipeBloc b) => b.add(const SwipeFeedRequested()),
      expect: () => const <SwipeState>[
        SwipeState(status: SwipeStatus.loading),
        SwipeState(status: SwipeStatus.error, failure: NetworkFailure()),
      ],
    );
  });

  group('apply / skip', () {
    blocTest<SwipeBloc, SwipeState>(
      'apply advances and drains to empty',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenAnswer((_) async {});
        return SwipeBloc(repo);
      },
      seed: () =>
          SwipeState(status: SwipeStatus.ready, queue: <FeedItem>[_item('j1')]),
      act: (SwipeBloc b) => b.add(const SwipeApplied()),
      expect: () => <SwipeState>[
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1')],
            deciding: true),
        const SwipeState(
            status: SwipeStatus.empty,
            queue: <FeedItem>[],
            appliedNonce: 1),
      ],
      verify: (_) =>
          verify(() => repo.applyToJob('j1', rank: 1)).called(1),
    );

    blocTest<SwipeBloc, SwipeState>(
      'apply failure (non-consent) bumps the snackbar nonce and keeps the card',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenThrow(const NetworkFailure());
        return SwipeBloc(repo);
      },
      seed: () =>
          SwipeState(status: SwipeStatus.ready, queue: <FeedItem>[_item('j1')]),
      act: (SwipeBloc b) => b.add(const SwipeApplied()),
      expect: () => <SwipeState>[
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1')],
            deciding: true),
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1')],
            decisionError: 1),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      'apply failure 403 -> consentRequired',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenThrow(const ConsentRequiredFailure());
        return SwipeBloc(repo);
      },
      seed: () =>
          SwipeState(status: SwipeStatus.ready, queue: <FeedItem>[_item('j1')]),
      act: (SwipeBloc b) => b.add(const SwipeApplied()),
      expect: () => <SwipeState>[
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1')],
            deciding: true),
        SwipeState(
            status: SwipeStatus.consentRequired,
            queue: <FeedItem>[_item('j1')]),
      ],
    );

    blocTest<SwipeBloc, SwipeState>(
      'skip advances to the next card',
      build: () {
        when(() => repo.skipJob(any(), reason: any(named: 'reason')))
            .thenAnswer((_) async {});
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
          status: SwipeStatus.ready,
          queue: <FeedItem>[_item('j1'), _item('j2')]),
      act: (SwipeBloc b) => b.add(const SwipeSkipped()),
      expect: () => <SwipeState>[
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1'), _item('j2')],
            deciding: true),
        SwipeState(
            status: SwipeStatus.ready, queue: <FeedItem>[_item('j2')]),
      ],
      verify: (_) =>
          verify(() => repo.skipJob('j1', reason: 'not_interested')).called(1),
    );

  });

  group('filter-change race mid-decision (regression)', () {
    // The top chip row sits OUTSIDE JobDeck and stays tappable while a card is
    // in flight (only the deck itself locks on `deciding`), so a filter change
    // can land between an apply/skip dispatch and its network reply — bloc runs
    // the handlers for different event types concurrently. `_advance` must drop
    // the card that was actually DECIDED, not whatever the new filter promoted
    // to head. Re-reading `state.current` after the await evicted the wrong job:
    // the applied card survived and re-appeared, and an undecided card vanished
    // unseen (a lost impression on the north-star apply path).
    late Completer<void> gate;
    setUp(() => gate = Completer<void>());

    final List<FeedItem> abc = <FeedItem>[
      _job('A', 'cnc_operator'),
      _job('B', 'vmc_operator'),
      _job('C', 'cnc_machinist'),
    ];

    blocTest<SwipeBloc, SwipeState>(
      'a trade filter landing mid-apply drops the APPLIED card, not the new head',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenAnswer((_) => gate.future);
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(status: SwipeStatus.ready, queue: abc),
      act: (SwipeBloc b) async {
        b.add(const SwipeApplied()); // head A -> applyToJob('A') hangs on the gate
        await Future<void>.delayed(Duration.zero);
        // Worker taps the VMC chip while A is still in flight -> head becomes B.
        b.add(SwipeFiltersChanged(_sel(trades: <String>{'VMC'})));
        await Future<void>.delayed(Duration.zero);
        gate.complete(); // A's apply resolves
        await Future<void>.delayed(Duration.zero);
      },
      verify: (SwipeBloc b) {
        // A was applied server-side and MUST leave; B was never decided and MUST
        // stay. The pre-fix code produced [A, C] — exactly backwards.
        expect(_ids(b.state.queue), <String>['B', 'C']);
        verify(() => repo.applyToJob('A', rank: any(named: 'rank'))).called(1);
        verifyNever(() => repo.applyToJob('B', rank: any(named: 'rank')));
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a trade filter landing mid-skip drops the SKIPPED card, not the new head',
      build: () {
        when(() => repo.skipJob(any(), reason: any(named: 'reason')))
            .thenAnswer((_) => gate.future);
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(status: SwipeStatus.ready, queue: abc),
      act: (SwipeBloc b) async {
        b.add(const SwipeSkipped());
        await Future<void>.delayed(Duration.zero);
        b.add(SwipeFiltersChanged(_sel(trades: <String>{'VMC'})));
        await Future<void>.delayed(Duration.zero);
        gate.complete();
        await Future<void>.delayed(Duration.zero);
      },
      verify: (SwipeBloc b) {
        expect(_ids(b.state.queue), <String>['B', 'C']);
        verify(() => repo.skipJob('A', reason: any(named: 'reason'))).called(1);
      },
    );
  });

  group('filters', () {
    blocTest<SwipeBloc, SwipeState>(
      'SwipeFiltersChanged narrows the visible deck; the queue stays intact',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('cnc1', 'cnc_operator'),
          _job('vmc1', 'vmc_setter'),
          _job('weld1', 'welder'),
        ],
      ),
      act: (SwipeBloc b) =>
          b.add(SwipeFiltersChanged(_sel(trades: <String>{'CNC', 'VMC'}))),
      verify: (SwipeBloc b) {
        expect(b.state.filters.trades, <String>{'CNC', 'VMC'});
        expect(b.state.visibleQueue.map((FeedItem j) => j.jobId).toList(),
            <String>['cnc1', 'vmc1']);
        expect(b.state.queue.length, 3); // unfiltered queue untouched
        expect(b.state.current?.jobId, 'cnc1');
        expect(b.state.filteredOut, isFalse);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'the CITY dimension narrows the deck',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('pune1', 'cnc_operator', city: 'Pune'),
          _job('nashik1', 'cnc_operator', city: 'Nashik'),
        ],
      ),
      act: (SwipeBloc b) =>
          b.add(SwipeFiltersChanged(_sel(cities: <String>{'Pune'}))),
      verify: (SwipeBloc b) {
        expect(b.state.visibleQueue.map((FeedItem j) => j.jobId).toList(),
            <String>['pune1']);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'the EXPERIENCE dimension narrows the deck, and a job with NO experience '
      'data survives every band',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('junior', 'cnc_operator', minYears: 0, maxYears: 1),
          _job('senior', 'cnc_operator', minYears: 8, maxYears: 12),
          // No window at all ⇒ [0, infinity) ⇒ matches EVERY band. Deliberate:
          // a blank field must never cost a job its impressions.
          _job('unknown', 'cnc_operator'),
        ],
      ),
      act: (SwipeBloc b) =>
          b.add(SwipeFiltersChanged(_sel(bands: <String>{'5+ yrs'}))),
      verify: (SwipeBloc b) {
        expect(b.state.visibleQueue.map((FeedItem j) => j.jobId).toList(),
            <String>['senior', 'unknown']);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'dimensions AND together',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('hit', 'cnc_operator', city: 'Pune', minYears: 6, maxYears: 9),
          // Right trade + city, wrong experience.
          _job('junior', 'cnc_operator', city: 'Pune', minYears: 0, maxYears: 1),
          // Right trade + experience, wrong city.
          _job('away', 'cnc_operator', city: 'Nashik', minYears: 6, maxYears: 9),
          // Right city + experience, wrong trade.
          _job('welder', 'welder', city: 'Pune', minYears: 6, maxYears: 9),
        ],
      ),
      act: (SwipeBloc b) => b.add(SwipeFiltersChanged(_sel(
        trades: <String>{'CNC'},
        cities: <String>{'Pune'},
        bands: <String>{'5+ yrs'},
      ))),
      verify: (SwipeBloc b) {
        expect(b.state.visibleQueue.map((FeedItem j) => j.jobId).toList(),
            <String>['hit']);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'apply acts on the FILTERED head, not queue.first',
      build: () {
        when(() => repo.applyToJob(any(), rank: any(named: 'rank')))
            .thenAnswer((_) async {});
        return SwipeBloc(repo);
      },
      // vmc is first in the queue, but the CNC filter makes cnc the head.
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('vmc1', 'vmc_setter'),
          _job('cnc1', 'cnc_operator'),
        ],
        filters: FilterSelection(
            trades: <String>{'CNC'}, cities: <String>{}, experienceBands: <String>{}),
      ),
      act: (SwipeBloc b) => b.add(const SwipeApplied()),
      verify: (SwipeBloc b) {
        verify(() => repo.applyToJob('cnc1', rank: 1)).called(1);
        expect(b.state.queue.map((FeedItem j) => j.jobId).toList(),
            <String>['vmc1']);
        expect(b.state.filteredOut, isTrue); // vmc1 does not match CNC
        expect(b.state.current, isNull);
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'a filter matching nothing sets filteredOut with no current',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[_job('weld1', 'welder')],
      ),
      act: (SwipeBloc b) =>
          b.add(SwipeFiltersChanged(_sel(trades: <String>{'CNC'}))),
      verify: (SwipeBloc b) {
        expect(b.state.filteredOut, isTrue);
        expect(b.state.visibleQueue, isEmpty);
        expect(b.state.current, isNull);
        expect(b.state.queue.length, 1); // still there once the filter clears
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'clearing EVERY dimension restores the full deck',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('cnc1', 'cnc_operator', city: 'Pune'),
          _job('vmc1', 'vmc_setter', city: 'Nashik'),
        ],
        // Narrowed on all three dimensions at once.
        filters: FilterSelection(
          trades: <String>{'CNC'},
          cities: <String>{'Pune'},
          experienceBands: <String>{'0-2 yrs'},
        ),
      ),
      act: (SwipeBloc b) => b.add(const SwipeFiltersChanged(
        FilterSelection.initial,
      )),
      verify: (SwipeBloc b) {
        expect(b.state.visibleQueue.length, 2);
        expect(b.state.filteredOut, isFalse);
        expect(b.state.filters.isEmpty, isTrue);
      },
    );
  });
}

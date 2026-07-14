import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
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
FeedItem _job(String id, String tradeKey) => FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: tradeKey,
      city: 'C',
      area: null,
      rank: 1,
    );

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

    blocTest<SwipeBloc, SwipeState>(
      'prioritize (up-swipe) records intent, advances, bumps prioritizedNonce',
      build: () {
        when(() => repo.prioritizeJob(any())).thenAnswer((_) async {});
        return SwipeBloc(repo);
      },
      seed: () => SwipeState(
          status: SwipeStatus.ready,
          queue: <FeedItem>[_item('j1'), _item('j2')]),
      act: (SwipeBloc b) => b.add(const SwipePrioritized()),
      expect: () => <SwipeState>[
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j1'), _item('j2')],
            deciding: true),
        SwipeState(
            status: SwipeStatus.ready,
            queue: <FeedItem>[_item('j2')],
            prioritizedNonce: 1),
      ],
      verify: (_) => verify(() => repo.prioritizeJob('j1')).called(1),
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
          b.add(const SwipeFiltersChanged(<String>{'CNC', 'VMC'})),
      verify: (SwipeBloc b) {
        expect(b.state.tradeFilter, <String>{'CNC', 'VMC'});
        expect(b.state.visibleQueue.map((FeedItem j) => j.jobId).toList(),
            <String>['cnc1', 'vmc1']);
        expect(b.state.queue.length, 3); // unfiltered queue untouched
        expect(b.state.current?.jobId, 'cnc1');
        expect(b.state.filteredOut, isFalse);
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
        tradeFilter: const <String>{'CNC'},
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
      act: (SwipeBloc b) => b.add(const SwipeFiltersChanged(<String>{'CNC'})),
      verify: (SwipeBloc b) {
        expect(b.state.filteredOut, isTrue);
        expect(b.state.visibleQueue, isEmpty);
        expect(b.state.current, isNull);
        expect(b.state.queue.length, 1); // still there once the filter clears
      },
    );

    blocTest<SwipeBloc, SwipeState>(
      'clearing the filter restores the full deck',
      build: () => SwipeBloc(repo),
      seed: () => SwipeState(
        status: SwipeStatus.ready,
        queue: <FeedItem>[
          _job('cnc1', 'cnc_operator'),
          _job('vmc1', 'vmc_setter'),
        ],
        tradeFilter: const <String>{'CNC'},
      ),
      act: (SwipeBloc b) => b.add(const SwipeFiltersChanged(<String>{})),
      verify: (SwipeBloc b) {
        expect(b.state.visibleQueue.length, 2);
        expect(b.state.filteredOut, isFalse);
      },
    );
  });
}

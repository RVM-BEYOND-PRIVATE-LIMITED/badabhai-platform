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
        SwipeState(status: SwipeStatus.error),
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
}

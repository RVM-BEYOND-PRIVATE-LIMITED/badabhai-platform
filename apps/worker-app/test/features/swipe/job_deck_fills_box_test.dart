import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/design1_job_card.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/job_deck.dart';

import '../../support/kit_matrix.dart';

/// The deck card's HEIGHT CONTRACT.
///
///  1. The front card fills the deck box down to the dock, less the
///     [kJobDeckBehindPeek] strip the next card shows through. A card that
///     shrink-wraps its text leaves a white gap above the buttons and lets the
///     behind card's body show underneath it, which reads as two broken cards.
///  2. That height does not change when a drag is released. A swipe that
///     springs back rebuilds the deck; if the rebuild measures the card
///     differently, it visibly collapses to half height under the worker's
///     finger.
class _MockSwipeRepository extends Mock implements SwipeRepository {}

FeedItem _job(String id, {required int chips}) => FeedItem(
      jobId: id,
      tradeKey: 'cnc_operator',
      title: 'CNC Operator $id',
      city: 'Pune',
      area: 'Chakan',
      rank: 1,
      payMin: 10000,
      payMax: 40000,
      minExperienceYears: 2,
      maxExperienceYears: 6,
      neededBy: 'immediate',
      // Different content lengths: the natural heights must NOT be what the
      // deck renders, so a short card and a long card come out the same size.
      requirements: <String>[for (int i = 0; i < chips; i++) 'Skill $i'],
      benefits: <String>[for (int i = 0; i < chips; i++) 'Benefit $i'],
    );

SwipeBloc _bloc(List<FeedItem> jobs) {
  final _MockSwipeRepository repo = _MockSwipeRepository();
  when(
    () => repo.getFeed(
      tradeKey: any(named: 'tradeKey'),
      city: any(named: 'city'),
      shift: any(named: 'shift'),
      payMin: any(named: 'payMin'),
    ),
  ).thenAnswer((_) async => jobs);
  return SwipeBloc(repo);
}

void main() {
  setUp(() async {
    await locator.reset();
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
  });

  tearDown(() async => locator.reset());

  /// The painted height of the front card's paper.
  double frontCardHeight(WidgetTester tester) =>
      tester.getSize(find.byType(Design1JobCard).first).height;

  Future<void> pumpDeck(WidgetTester tester, List<FeedItem> jobs) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(SwipeJobsScreen(bloc: _bloc(jobs))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('the front card fills the deck box down to the dock', (
    WidgetTester tester,
  ) async {
    await pumpDeck(tester, <FeedItem>[
      _job('short', chips: 1),
      _job('long', chips: 6),
    ]);

    final double deckBox = tester.getSize(find.byType(JobDeck)).height;
    final double dock = tester
        .getSize(find.byType(Design1DeckDock))
        .height;
    final double card = frontCardHeight(tester);

    // The card takes everything the deck box has except the dock, the 16dp
    // gap above it and the peek strip. A shrink-wrapped card is far shorter.
    final double expected = deckBox - dock - 16 - kJobDeckBehindPeek;
    expect(
      card,
      closeTo(expected, 1),
      reason: 'card $card should fill the deck box ($deckBox) minus the dock '
          '($dock), the 16dp gap and the ${kJobDeckBehindPeek}dp peek',
    );
  });

  testWidgets('a card with little content is the same height as a full one', (
    WidgetTester tester,
  ) async {
    await pumpDeck(tester, <FeedItem>[_job('short', chips: 1)]);
    final double short = frontCardHeight(tester);

    // Tear the tree down before re-registering the graph, or the second pump
    // reuses the first screen's bloc and never mounts a card.
    await tester.pumpWidget(const SizedBox.shrink());
    await locator.reset();
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
    await pumpDeck(tester, <FeedItem>[_job('long', chips: 6)]);
    final double long = frontCardHeight(tester);

    expect(short, closeTo(long, 1));
  });

  testWidgets('releasing a swipe does not collapse the card', (
    WidgetTester tester,
  ) async {
    await pumpDeck(tester, <FeedItem>[
      _job('a', chips: 2),
      _job('b', chips: 5),
    ]);
    final double before = frontCardHeight(tester);

    // Drag left, then right, then let go BELOW the commit threshold — the
    // card springs back and the deck rebuilds.
    final Offset centre = tester.getCenter(find.byType(Design1JobCard).first);
    final TestGesture gesture = await tester.startGesture(centre);
    await gesture.moveBy(const Offset(-60, 0));
    await tester.pump();
    await gesture.moveBy(const Offset(90, 0));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    expect(
      frontCardHeight(tester),
      closeTo(before, 1),
      reason: 'the card must not resize when a gesture is released',
    );
  });
}

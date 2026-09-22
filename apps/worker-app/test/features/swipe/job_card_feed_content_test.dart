import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';

import '../../support/kit_matrix.dart';

/// NO-UNBACKED-CLAIMS contract for the Jobs-tab card.
///
/// Two rules, both of which used to be broken:
///
///  1. `GET /feed` ALREADY sends the posting's `description` / `benefits` /
///     `requirements` / `needed_by` (#1561). [FeedItem] used to drop them on
///     the floor, so the card could only show them after a per-card
///     `GET /jobs/:id` round-trip landed. Here the detail route THROWS, so
///     anything visible came from the feed row itself.
///  2. The salary box used to print "TAKE HOME PAY" + an "IN-HAND" pill as
///     fixed chrome. No route, DTO or column anywhere states net-vs-gross, so
///     the box now names only what the data is — a monthly band — and the
///     pay-type pill renders only from real data (`BbJobCardData.payNote`,
///     null everywhere until a poster can state it).
class _MockSwipeRepository extends Mock implements SwipeRepository {}

const FeedItem _rich = FeedItem(
  jobId: 'job-rich',
  tradeKey: 'cnc_operator',
  title: 'CNC Operator — Night Shift',
  city: 'Pune',
  area: 'Chakan',
  rank: 1,
  payMin: 16000,
  payMax: 26000,
  shift: 'night',
  minExperienceYears: 1,
  maxExperienceYears: 4,
  description: 'Fanuc control par kaam. Night shift allowance milega.',
  benefits: <String>['PF + ESI', 'Canteen'],
  requirements: <String>['Fanuc control', 'ITI / Diploma'],
  neededBy: 'immediate',
);

/// Same job, but the poster DID state what the band means and when it went up.
FeedItem _stated({String payType = 'in_hand', DateTime? postedAt}) => FeedItem(
      jobId: 'job-rich',
      tradeKey: 'cnc_operator',
      title: 'CNC Operator — Night Shift',
      city: 'Pune',
      area: 'Chakan',
      rank: 1,
      payMin: 16000,
      payMax: 26000,
      shift: 'night',
      payType: payType,
      postedAt: postedAt,
    );

SwipeBloc _blocOf(List<FeedItem> jobs) {
  final _MockSwipeRepository repo = _MockSwipeRepository();
  when(
    () => repo.getFeed(
      tradeKey: any(named: 'tradeKey'),
      city: any(named: 'city'),
      shift: any(named: 'shift'),
      payMin: any(named: 'payMin'),
    ),
  ).thenAnswer((_) async => jobs);
  when(() => repo.jobDetail(any())).thenThrow(StateError('no detail'));
  return SwipeBloc(repo);
}

SwipeBloc _bloc() {
  final _MockSwipeRepository repo = _MockSwipeRepository();
  when(
    () => repo.getFeed(
      tradeKey: any(named: 'tradeKey'),
      city: any(named: 'city'),
      shift: any(named: 'shift'),
      payMin: any(named: 'payMin'),
    ),
  ).thenAnswer((_) async => const <FeedItem>[_rich]);
  // The card must NOT depend on the detail route for its content.
  when(() => repo.jobDetail(any())).thenThrow(StateError('no detail'));
  return SwipeBloc(repo);
}

void main() {
  setUp(() async {
    await locator.reset();
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
  });

  tearDown(() async => locator.reset());

  testWidgets('the deck card shows the feed row\'s own content with no detail '
      'fetch', (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(SwipeJobsScreen(bloc: _bloc())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // Requirements + benefits + needed-by, straight off `GET /feed`.
    expect(find.text('Fanuc control'), findsOneWidget);
    expect(find.text('ITI / Diploma'), findsOneWidget);
    expect(find.text('PF + ESI'), findsOneWidget);
    expect(find.text('Canteen'), findsOneWidget);
    expect(find.text('Turant chahiye'), findsOneWidget);
  });

  testWidgets('the salary box states the monthly band and claims no take-home '
      'pay', (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(SwipeJobsScreen(bloc: _bloc())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('MAHINE KI SALARY'), findsOneWidget);
    // Nothing in the platform states net-vs-gross — so the card must not.
    expect(find.text('TAKE HOME PAY'), findsNothing);
    expect(find.text('IN-HAND'), findsNothing);
    expect(find.textContaining('16,000'), findsWidgets);
  });

  testWidgets('the pay-type pill renders ONLY from the posting\'s own pay_type',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(
      kitTestApp(SwipeJobsScreen(bloc: _blocOf(<FeedItem>[_stated()]))),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('MAHINE KI SALARY'), findsOneWidget);
    expect(find.text('IN-HAND'), findsOneWidget);
  });

  testWidgets('an unstated pay_type shows the band with NO pill',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(SwipeJobsScreen(bloc: _bloc())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('MAHINE KI SALARY'), findsOneWidget);
    for (final String claim in <String>['IN-HAND', 'GROSS', 'CTC']) {
      expect(find.text(claim), findsNothing);
    }
  });

  testWidgets('"Aaj N naye jobs" counts only what was POSTED TODAY',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    final DateTime now = DateTime.now();
    await tester.pumpWidget(
      kitTestApp(
        SwipeJobsScreen(
          bloc: _blocOf(<FeedItem>[
            _stated(postedAt: now),
            _stated(postedAt: now.subtract(const Duration(days: 40))),
          ]),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // Two jobs loaded, ONE posted today — the line counts the true one.
    expect(find.text('Aaj 1 naye jobs'), findsOneWidget);
  });

  testWidgets('with no posting date the header claims no recency at all',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(
      kitTestApp(
        SwipeJobsScreen(bloc: _blocOf(<FeedItem>[_stated(), _stated()])),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('naye jobs'), findsNothing);
    expect(find.text('2 jobs aapke liye'), findsOneWidget);
  });

  test('FeedItem parses the card content the feed sends', () {
    final FeedItem item = FeedItem.fromJson(<String, dynamic>{
      'job_id': 'job-1',
      'trade_key': 'cnc_operator',
      'title': 'CNC Operator',
      'city': 'Pune',
      'rank': 1,
      'description': 'Fanuc control par kaam.',
      'benefits': <dynamic>['PF + ESI', '  ', 7, 'Canteen'],
      'requirements': <dynamic>['Fanuc control'],
      'needed_by': 'immediate',
    });

    expect(item.description, 'Fanuc control par kaam.');
    // Blank and non-string entries are dropped, never rendered as empty chips.
    expect(item.benefits, <String>['PF + ESI', 'Canteen']);
    expect(item.requirements, <String>['Fanuc control']);
    expect(item.neededBy, 'immediate');
  });

  test('FeedItem parses pay_type and posted_at, and stays honest on junk', () {
    Map<String, dynamic> row(Map<String, dynamic> extra) => <String, dynamic>{
          'job_id': 'job-1',
          'trade_key': 'cnc_operator',
          'title': 'CNC Operator',
          'city': 'Pune',
          'rank': 1,
          ...extra,
        };

    final FeedItem stated = FeedItem.fromJson(row(<String, dynamic>{
      'pay_type': 'in_hand',
      'posted_at': '2026-09-22T04:30:00.000Z',
    }));
    expect(stated.payType, 'in_hand');
    expect(stated.postedAt?.toUtc().day, 22);

    // An unparseable date is UNKNOWN, never "now" — a fabricated recency is
    // exactly what the honest-count rule exists to prevent.
    final FeedItem junk =
        FeedItem.fromJson(row(<String, dynamic>{'posted_at': 'not-a-date'}));
    expect(junk.postedAt, isNull);
    expect(junk.payType, isNull);
  });

  test('a feed row without the content keys parses to honest absence', () {
    final FeedItem item = FeedItem.fromJson(<String, dynamic>{
      'job_id': 'job-1',
      'trade_key': 'cnc_operator',
      'title': 'CNC Operator',
      'city': 'Pune',
      'rank': 1,
    });

    expect(item.description, isNull);
    expect(item.benefits, isEmpty);
    expect(item.requirements, isEmpty);
    expect(item.neededBy, isNull);
  });

}

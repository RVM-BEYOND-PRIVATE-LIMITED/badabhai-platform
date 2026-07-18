import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/find/presentation/cubit/find_cubit.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';

/// #364 — the Find feed must build LAZILY.
///
/// The screen used to return a plain `ListView(children: [...])` whose child
/// list expanded EVERY applicant (and every mock candidate) inline. Precisely
/// what that costs: a `SliverChildListDelegate` still inflates only the
/// elements near the viewport, so the old code was NOT laying out all 150 cards
/// — but it did construct all 150 `_ApplicantCard` widgets and their two
/// closures each, and it did so inside `_FindView.build`, i.e. AGAIN in full on
/// every FindCubit emission (a single unlock's re-emit rebuilt the widget for
/// every other row). `ListView.builder` moves that construction behind the same
/// laziness the element inflation already had.
///
/// That distinction is why the discriminating assertion below is on the child
/// DELEGATE: a lazy feed is exactly "the delegate is a builder, not a
/// materialized list", and a `find.text` count cannot tell the two apart. The
/// scroll/window tests that follow are behaviour guards on the conversion (the
/// header must stay index 0, the rows must stay addressable and in order).
class _BigFeedApi extends MockPayerApiClient {
  _BigFeedApi(this.total);

  final int total;

  static const JobPosting _job = JobPosting(
    id: 'job-1',
    title: 'CNC Setter',
    band: '₹18k–24k',
    filled: 0,
    quota: 1,
    applicants: 0,
    unlocks: 0,
    status: JobStatus.live,
    verified: true,
    boosted: false,
    wireStatus: 'open',
  );

  /// 'Worker ••0000' … up to `total - 1` — the label is the worker UUID tail.
  static String labelFor(int i) => 'Worker ••${i.toString().padLeft(4, '0')}';

  /// The mock card's own per-row line, 'CNC Setter · Fanuc <i>'. The NAME is
  /// masked to initials on the feed ("C•••• 0."), identically for every row, so
  /// the trade·skill line is what makes a specific mock card findable.
  static String skillLineFor(int i) =>
      'CNC Setter · Fanuc ${i.toString().padLeft(4, '0')}';

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async =>
      <JobPosting>[_job];

  @override
  Future<List<Applicant>> fetchApplicants(String jobId) async =>
      List<Applicant>.generate(
        total,
        (int i) => Applicant(
          workerId: 'aaaaaaaa-bbbb-4ccc-8ddd-${i.toString().padLeft(12, '0')}',
          rank: i + 1,
          score: 0.9,
          hot: false,
          pushEligible: false,
          tradeLabel: 'CNC Setter',
          cityLabel: 'Pune',
          experienceBand: '3–5 yrs',
        ),
      );

  /// The MOCK branch of the same feed: many candidates, distinct skill lines.
  @override
  Future<List<Candidate>> fetchCandidates() async => List<Candidate>.generate(
        total,
        (int i) => Candidate(
          id: i,
          name: 'Candidate ${i.toString().padLeft(4, '0')}',
          trade: 'CNC Setter',
          skill: 'Fanuc ${i.toString().padLeft(4, '0')}',
          exp: '4 yrs',
          loc: 'Pune',
          avail: 'Available now',
          hot: false,
          fit: FitLabel.good,
          phone: '+91 90000 00000',
        ),
      );
}

/// Total feed rows — comfortably more than one 600x800 viewport can show, and
/// in the same order of magnitude as the issue's "150+ applicants" scenario.
const int _total = 150;

/// The feed's scroll view. Fails loudly if the screen ever grows a second one
/// at the top level (the filter/job-selector strips are nested inside index 0).
ListView _feed(WidgetTester tester) =>
    tester.widget<ListView>(find.byType(ListView).first);

void main() {
  Future<void> pump(WidgetTester tester) async {
    // FindScreen is a tab body — the shell supplies the Scaffold/Material.
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: FindScreen(onReveal: (_) {}))),
    );
    await tester.pumpAndSettle();
  }

  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: _BigFeedApi(_total),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  group('#364 — REAL applicant feed', () {
    setUp(() {
      // setupLocator's mock seam forces the MOCK (global candidate) feed; the
      // REAL per-job feed is the unbounded one the issue is about, so re-bind
      // FindCubit with useRealFeed on.
      locator.unregister<FindCubit>();
      locator.registerFactory<FindCubit>(
        () => FindCubit(locator<PayerApiClient>(), useRealFeed: true),
      );
    });

    testWidgets('child delegate is lazy — not $_total materialized cards', (
      WidgetTester tester,
    ) async {
      await pump(tester);

      // The feed loaded (header count line — a RichText) and the first card is
      // on screen.
      expect(
        find.textContaining('matched candidates', findRichText: true),
        findsOneWidget,
      );
      expect(find.text(_BigFeedApi.labelFor(0)), findsOneWidget);

      final ListView feed = _feed(tester);
      // The old code's delegate was a SliverChildListDelegate holding a
      // fully-constructed 151-widget list, rebuilt whole on every emission.
      expect(feed.childrenDelegate, isA<SliverChildBuilderDelegate>());
      expect(feed.childrenDelegate, isNot(isA<SliverChildListDelegate>()));
      // Header at index 0 + one index per applicant, each built on demand.
      expect(feed.childrenDelegate.estimatedChildCount, _total + 1);
    });

    testWidgets('renders a window, not the whole feed, at rest', (
      WidgetTester tester,
    ) async {
      await pump(tester);

      final int built = find.text('₹40').evaluate().length;
      expect(built, lessThan(_total ~/ 3),
          reason: 'expected a lazily built window, got $built of $_total cards');
      expect(find.text(_BigFeedApi.labelFor(_total - 1)), findsNothing);
    });

    testWidgets('scrolling to the end builds the last card', (
      WidgetTester tester,
    ) async {
      await pump(tester);

      await tester.scrollUntilVisible(
        find.text(_BigFeedApi.labelFor(_total - 1)),
        400,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      expect(find.text(_BigFeedApi.labelFor(_total - 1)), findsOneWidget);
      // …and the head has been recycled off the other end.
      expect(find.text(_BigFeedApi.labelFor(0)), findsNothing);
    });

    testWidgets('empty applicant list still renders its message row', (
      WidgetTester tester,
    ) async {
      // rowCount is 1 (not 0) when the REAL feed is empty — the message takes
      // the place of the card rows.
      await GetIt.instance.reset();
      setupLocator(
        apiClient: _BigFeedApi(0),
        secureStore: InMemoryKeyValueStore(),
      );
      locator.unregister<FindCubit>();
      locator.registerFactory<FindCubit>(
        () => FindCubit(locator<PayerApiClient>(), useRealFeed: true),
      );

      await pump(tester);

      expect(find.text('No applicants for this job yet.'), findsOneWidget);
      expect(_feed(tester).childrenDelegate.estimatedChildCount, 2);
    });
  });

  group('#364 — MOCK candidate feed', () {
    testWidgets('child delegate is lazy — not $_total materialized cards', (
      WidgetTester tester,
    ) async {
      await pump(tester);

      expect(find.text(_BigFeedApi.skillLineFor(0)), findsOneWidget);

      final ListView feed = _feed(tester);
      expect(feed.childrenDelegate, isA<SliverChildBuilderDelegate>());
      expect(feed.childrenDelegate.estimatedChildCount, _total + 1);
      expect(find.text(_BigFeedApi.skillLineFor(_total - 1)), findsNothing);
    });
  });
}

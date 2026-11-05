import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_skeleton.dart';
import 'package:payer_app/features/credits/presentation/credits_screen.dart';
import 'package:payer_app/features/find/presentation/candidate_search_view.dart';
import 'package:payer_app/features/find/presentation/cubit/candidate_search_cubit.dart';
import 'package:payer_app/features/find/presentation/cubit/find_cubit.dart';
import 'package:payer_app/features/find/presentation/widgets/find_view_switch.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/post_job_screen.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2592 (M4) — tabs keep their data. A return to a tab re-reads its API
/// QUIETLY (the rows stay on screen; no skeleton, no spinner), re-tapping the
/// tab on screen scrolls it to the top without reloading, leaving Post for My
/// jobs re-reads the list, Find keeps BOTH views (the hidden one catches up
/// when opened), and Home + Credits pull to refresh. On a 360×640 phone with
/// animations disabled.
class _Api extends MockPayerApiClient {
  List<JobPosting> jobs = <JobPosting>[_job('Fitter')];
  Completer<List<JobPosting>>? jobsGate;
  int jobFetches = 0;
  int balanceReads = 0;
  int ledgerReads = 0;
  Completer<List<LedgerEntry>>? ledgerGate;

  /// The canned mock postings instead of [jobs]: their cards carry the
  /// "Applicants" button.
  bool cannedJobs = false;

  /// Find's Applicants feed (the mock seam's candidate list).
  int feedReads = 0;
  Completer<List<Candidate>>? feedGate;

  /// All candidates' unlock history — re-read by every refresh of that view.
  int unlockHistoryReads = 0;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    jobFetches++;
    if (cannedJobs) return super.fetchJobs(status: status);
    if (jobsGate != null) return jobsGate!.future;
    return jobs;
  }

  @override
  Future<List<Candidate>> fetchCandidates() async {
    feedReads++;
    if (feedGate != null) await feedGate!.future;
    return super.fetchCandidates();
  }

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() {
    unlockHistoryReads++;
    return super.fetchOwnUnlocks();
  }

  @override
  Future<int> fetchCreditBalance() async {
    balanceReads++;
    return 12;
  }

  @override
  Future<List<LedgerEntry>> fetchCreditLedger({int limit = 20}) async {
    ledgerReads++;
    if (ledgerGate != null) return ledgerGate!.future;
    return super.fetchCreditLedger(limit: limit);
  }
}

JobPosting _job(String title) => JobPosting(
      id: 'job-$title',
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: false,
      boosted: false,
      wireStatus: 'open',
    );

void main() {
  late _Api api;

  const AppSession session = AppSession(
    role: PayerRole.company,
    account: PayerAccount(
      name: 'Kalyani Industries',
      plan: 'Starter',
      initials: 'KI',
    ),
  );

  setUp(() async {
    await GetIt.instance.reset();
    api = _Api();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  });

  /// [phone] false keeps the default test surface — for the FLOW tests that
  /// open screens whose 360dp layout belongs to other issues (the Post form,
  /// #2595; the mock candidate card, #2593), so they test the refresh flow,
  /// not those layouts.
  Future<void> pumpShell(WidgetTester tester, {bool phone = true}) async {
    if (phone) {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
    }
    await tester.pumpWidget(MaterialApp(
      builder: (BuildContext context, Widget? child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: BlocProvider<AppSessionCubit>.value(
        value: locator<AppSessionCubit>(),
        child: const AppShell(session: session),
      ),
    ));
    await tester.pumpAndSettle();
  }

  Future<void> tapNav(WidgetTester tester, String label) async {
    await tester.tap(find.descendant(
      of: find.byType(BbBottomNav),
      matching: find.text(label),
    ));
  }

  testWidgets('a return to Jobs keeps the postings on screen while it re-reads',
      (WidgetTester tester) async {
    await pumpShell(tester);
    await tapNav(tester, 'Jobs');
    await tester.pumpAndSettle();
    expect(api.jobFetches, 1);
    await tapNav(tester, 'Home');
    await tester.pumpAndSettle();

    api.jobsGate = Completer<List<JobPosting>>();
    await tapNav(tester, 'Jobs');
    await tester.pump();
    await tester.pump();

    // Re-read in flight: the old rows are what the payer sees — no skeleton,
    // no spinner, no blank.
    expect(api.jobFetches, 2, reason: 'latest on every return');
    expect(find.text('Fitter'), findsOneWidget);
    expect(find.byType(BbSkeletonJobRow), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    api.jobsGate!.complete(<JobPosting>[_job('Fitter'), _job('Welder')]);
    api.jobsGate = null;
    await tester.pumpAndSettle();
    expect(find.text('Welder'), findsOneWidget);
  });

  testWidgets('re-tapping the tab on screen scrolls it to the top, no reload',
      (WidgetTester tester) async {
    api.jobs = <JobPosting>[
      for (int i = 0; i < 12; i++) _job('Posting $i'),
    ];
    await pumpShell(tester);
    await tapNav(tester, 'Jobs');
    await tester.pumpAndSettle();
    final ScrollableState list = tester.state<ScrollableState>(find
        .descendant(
          of: find.byType(JobsScreen),
          matching: find.byType(Scrollable),
        )
        .first);
    list.position.jumpTo(600);
    await tester.pump();
    expect(list.position.pixels, 600);

    await tapNav(tester, 'Jobs');
    await tester.pumpAndSettle();

    expect(list.position.pixels, 0);
    expect(api.jobFetches, 1, reason: 'a re-tap is not a reload');
  });

  testWidgets('leaving Post for My jobs re-reads the list quietly',
      (WidgetTester tester) async {
    await pumpShell(tester, phone: false);
    await tapNav(tester, 'Jobs');
    await tester.pumpAndSettle();
    expect(api.jobFetches, 1);
    await tester.tap(find.widgetWithText(BbButton, 'Post'));
    await tester.pumpAndSettle();
    expect(find.byType(PostJobScreen), findsOneWidget);

    api.jobsGate = Completer<List<JobPosting>>();
    // Post's own back — the same hand-back a posted job or a saved draft
    // makes.
    await tester.tap(find.descendant(
      of: find.byType(PostJobScreen),
      matching: find.byIcon(Icons.arrow_back_rounded),
    ));
    await tester.pump();
    await tester.pump();

    expect(api.jobFetches, 2, reason: 'the new posting is listed on arrival');
    expect(find.text('Fitter'), findsOneWidget, reason: 'the list is kept');
    expect(find.byType(BbSkeletonJobRow), findsNothing);
    api.jobsGate!.complete(<JobPosting>[_job('Fitter'), _job('Welder')]);
    api.jobsGate = null;
    await tester.pumpAndSettle();
    expect(find.text('Welder'), findsOneWidget);
  });

  group('Find keeps both views', () {
    FindView shownView(WidgetTester tester) =>
        tester.widget<FindViewSwitch>(find.byType(FindViewSwitch)).selected;

    testWidgets('the hidden view re-reads when it is opened after a return',
        (WidgetTester tester) async {
      await pumpShell(tester, phone: false);
      await tapNav(tester, 'Find');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pumpAndSettle();
      expect(api.feedReads, 1);

      await tapNav(tester, 'Home');
      await tester.pumpAndSettle();
      await tapNav(tester, 'Find'); // opens All candidates (owner ruling)
      await tester.pumpAndSettle();
      expect(shownView(tester), FindView.allCandidates);
      expect(api.feedReads, 1, reason: 'a hidden view costs no request');

      api.feedGate = Completer<List<Candidate>>();
      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pump();
      await tester.pump();

      expect(api.feedReads, 2, reason: 'it missed the return, so it re-reads');
      expect(find.text('CANDIDATES FOR CNC SETTER'), findsOneWidget,
          reason: 'its rows stay on screen while it does');
      expect(find.byType(BbSkeletonCandidateRow), findsNothing);
      api.feedGate!.complete(const <Candidate>[]);
      api.feedGate = null;
      await tester.pumpAndSettle();

      // Back and forth again without leaving the tab: no further read.
      await tester.tap(find.byKey(const Key('find_view_all')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pumpAndSettle();
      expect(api.feedReads, 2);
    });

    testWidgets(
        'a Jobs card "Applicants" opens a fresh feed and keeps All candidates',
        (WidgetTester tester) async {
      FindCubit applicantsCubit() => tester
          .element(find.text('CANDIDATES FOR CNC SETTER'))
          .read<FindCubit>();

      api.cannedJobs = true;
      await pumpShell(tester, phone: false);
      await tapNav(tester, 'Find');
      await tester.pumpAndSettle();
      final CandidateSearchCubit search = tester
          .element(find.byType(CandidateSearchView))
          .read<CandidateSearchCubit>();
      // Both views open, then the payer leaves Find on All candidates.
      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pumpAndSettle();
      final FindCubit before = applicantsCubit();
      await tester.tap(find.byKey(const Key('find_view_all')));
      await tester.pumpAndSettle();
      await tapNav(tester, 'Jobs');
      await tester.pumpAndSettle();
      final int feedReads = api.feedReads;
      final int historyReads = api.unlockHistoryReads;

      await tester.tap(find.text('Applicants').first);
      await tester.pumpAndSettle();

      expect(shownView(tester), FindView.applicants);
      expect(applicantsCubit(), isNot(same(before)),
          reason: 'the Applicants view opens on a fresh feed');
      expect(api.feedReads, feedReads + 1, reason: 'read once, never twice');
      expect(api.unlockHistoryReads, historyReads,
          reason: 'the hidden All-candidates view is not re-read yet');

      await tester.tap(find.byKey(const Key('find_view_all')));
      await tester.pumpAndSettle();

      expect(
        tester
            .element(find.byType(CandidateSearchView))
            .read<CandidateSearchCubit>(),
        same(search),
        reason: 'its filters, pages and scroll survive the trip',
      );
      expect(api.unlockHistoryReads, historyReads + 1,
          reason: 'it missed a return: one quiet re-read');
      expect(find.byType(BbSkeletonCandidateRow), findsNothing);
    });

    for (final bool paged in <bool>[false, true]) {
      testWidgets(
          'the nav return that re-opens All candidates after a Jobs card '
          '"Applicants" re-reads it once (paged: $paged)',
          (WidgetTester tester) async {
        api.cannedJobs = true;
        await pumpShell(tester, phone: false);
        await tapNav(tester, 'Find');
        await tester.pumpAndSettle();
        final CandidateSearchCubit search = tester
            .element(find.byType(CandidateSearchView))
            .read<CandidateSearchCubit>();
        if (paged) {
          // Past the first page a return re-reads only the unlock history
          // (the place is kept), so a second re-read cannot hide behind the
          // first page's in-flight guard.
          await search.loadMore();
          await tester.pumpAndSettle();
          expect(search.state.pagedBeyondFirst, isTrue);
        }
        // A Jobs card's "Applicants" opens Find on Applicants: the hidden
        // All-candidates view misses that return.
        await tapNav(tester, 'Jobs');
        await tester.pumpAndSettle();
        await tester.tap(find.text('Applicants').first);
        await tester.pumpAndSettle();
        expect(shownView(tester), FindView.applicants);
        await tapNav(tester, 'Home');
        await tester.pumpAndSettle();
        final int historyReads = api.unlockHistoryReads;

        // The nav tab opens All candidates — the view that missed a return.
        await tapNav(tester, 'Find');
        await tester.pumpAndSettle();

        expect(shownView(tester), FindView.allCandidates);
        expect(api.unlockHistoryReads, historyReads + 1,
            reason: 'one return, one quiet re-read — never two');
      });
    }
  });

  testWidgets('Home pulls to refresh the balance', (WidgetTester tester) async {
    await pumpShell(tester);
    final int before = api.balanceReads;

    await tester.fling(
      find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('OVERVIEW'),
      ),
      const Offset(0, 400),
      1000,
    );
    await tester.pumpAndSettle();

    expect(api.balanceReads, before + 1);
    expect(find.text('12'), findsOneWidget);
  });

  testWidgets('Credits waits on ledger skeletons, then pulls to refresh',
      (WidgetTester tester) async {
    await pumpShell(tester);
    api.ledgerGate = Completer<List<LedgerEntry>>();
    await tapNav(tester, 'Credits');
    await tester.pump();
    await tester.pump();

    expect(find.byType(BbSkeletonLedgerRow), findsWidgets);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    api.ledgerGate!.complete(const <LedgerEntry>[]);
    api.ledgerGate = null;
    await tester.pumpAndSettle();
    expect(find.byType(BbSkeletonLedgerRow), findsNothing);
    expect(find.text('Credit ledger'), findsOneWidget);
    final int ledgerBefore = api.ledgerReads;
    final int balanceBefore = api.balanceReads;

    await tester.fling(
      find.descendant(
        of: find.byType(CreditsScreen),
        matching: find.text('Credit ledger'),
      ),
      const Offset(0, 400),
      1000,
    );
    await tester.pumpAndSettle();

    expect(api.ledgerReads, ledgerBefore + 1);
    expect(api.balanceReads, greaterThan(balanceBefore),
        reason: 'the app-wide balance is re-read with the ledger');
    expect(find.text('Credit ledger'), findsOneWidget);
  });
}

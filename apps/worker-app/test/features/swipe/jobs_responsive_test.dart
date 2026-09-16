import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/widgets/bb_alerts_action.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_header_actions.dart';
import 'package:badabhai_worker_app/features/applications/domain/applications_repository.dart';
import 'package:badabhai_worker_app/features/applications/presentation/applied_jobs_screen.dart';
import 'package:badabhai_worker_app/features/applications/presentation/cubit/applications_cubit.dart';
import 'package:badabhai_worker_app/features/job_search/data/job_search_repository_impl.dart';
import 'package:badabhai_worker_app/features/job_search/presentation/cubit/job_search_cubit.dart';
import 'package:badabhai_worker_app/features/job_search/presentation/job_search_screen.dart';
import 'package:badabhai_worker_app/features/swipe/data/job_feed_view_store.dart';
import 'package:badabhai_worker_app/features/swipe/data/jobs_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/cubit/job_detail_cubit.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/job_detail_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/filters_sheet.dart';

import '../../support/kit_matrix.dart';

/// The D13 responsive contract for the JOBS tab — feed (list + deck), job
/// detail, job search, applied jobs and the Filters sheet.
///
/// WHY EVERY SCREEN HERE IS NEW COVERAGE. There was no responsive test for any
/// screen in this area, and the area is where the layout actually broke: the
/// navy feed header used to stack a search pill, a filter field and up to eight
/// suggestion chips above a `Positioned.fill` deck card, which overflowed a
/// 320x568 handset and every phone in landscape. So these pin the shapes a
/// worker really owns (320x568 up to a 768 tablet, and 844x390 landscape) at
/// 1.0 / 1.5 / 2.0 system font, plus the tablet width cap and the 48dp touch
/// floor.

class _MockSwipeRepository extends Mock implements SwipeRepository {}

class _MockApplicationsRepository extends Mock
    implements ApplicationsRepository {}

/// Forces LIST mode. The screen defaults to the deck, and the real store is
/// plugin-backed, so a fake is the only way to reach the list body.
class _ListViewStore implements JobFeedViewStore {
  @override
  Future<JobFeedViewMode> read() async => JobFeedViewMode.list;

  @override
  Future<void> write(JobFeedViewMode mode) async {}
}

SessionRepository _session() => SessionRepository()
  ..setWorker(
    phone: '+910000000000',
    workerId: 'worker-1',
    sessionToken: 'test-token',
  );

/// Feed items shaped like the WORST case the real wire can produce: a title
/// long enough to wrap three lines, a match note, a pay band and a shift — i.e.
/// every row the card can draw, all at once.
List<FeedItem> _jobs(int count) => <FeedItem>[
  for (int i = 0; i < count; i++)
    FeedItem(
      jobId: 'job-$i',
      tradeKey: 'cnc_operator',
      title: i == 0
          ? 'CNC Turner / Setter for a precision components shop'
          : 'CNC Operator $i',
      city: 'Pune',
      area: i.isEven ? 'Chakan' : null,
      rank: i + 1,
      payMin: 16000,
      payMax: 26000,
      shift: 'rotational',
      viaRelated: i == 0,
      matchedSkillLabel: i == 0 ? 'lathe' : null,
    ),
];

/// A [SwipeBloc] over a stubbed repository. [error] throws instead of
/// answering; [pending] never answers at all (the loading state, with no timer
/// left running at the end of the test).
SwipeBloc _feedBloc({
  List<FeedItem>? jobs,
  Failure? error,
  bool pending = false,
}) {
  final _MockSwipeRepository repo = _MockSwipeRepository();
  final When<Future<List<FeedItem>>> stub = when(
    () => repo.getFeed(
      tradeKey: any(named: 'tradeKey'),
      city: any(named: 'city'),
      shift: any(named: 'shift'),
      payMin: any(named: 'payMin'),
    ),
  );
  if (pending) {
    stub.thenAnswer((_) => Completer<List<FeedItem>>().future);
  } else if (error != null) {
    stub.thenThrow(error);
  } else {
    stub.thenAnswer((_) async => jobs ?? <FeedItem>[]);
  }
  return SwipeBloc(repo);
}

Widget _feedScreen({
  List<FeedItem>? jobs,
  Failure? error,
  bool pending = false,
  bool list = false,
  SwipeBloc? bloc,
}) {
  if (list && !locator.isRegistered<JobFeedViewStore>()) {
    locator.registerSingleton<JobFeedViewStore>(_ListViewStore());
  }
  return SwipeJobsScreen(
    bloc: bloc ?? _feedBloc(jobs: jobs, error: error, pending: pending),
  );
}

/// The detail screen over the REAL canned mock data (300ms latency, which the
/// matrix harness's own pump clears), so the assertions are about real fields.
Widget _detailScreen(JobDetail light) {
  final ApiClient api = MockApiClient();
  final SessionRepository session = _session();
  return JobDetailScreen(
    detail: light,
    cubit: JobDetailCubit(
      JobsRepositoryImpl(api, session),
      SwipeRepositoryImpl(api, session),
      light,
    ),
  );
}

const JobDetail _lightFull = JobDetail(
  jobId: 'mock-job-0001',
  title: 'CNC Operator',
  city: 'Pune',
  area: 'Chakan',
);

/// mock-job-0004 states nothing beyond the feed facts — every optional block
/// must stay hidden rather than render empty.
const JobDetail _lightSparse = JobDetail(
  jobId: 'mock-job-0004',
  title: 'Fitter',
  city: 'Aurangabad',
  area: 'Waluj',
);

const JobDetail _lightApplied = JobDetail(
  jobId: 'mock-job-0001',
  title: 'CNC Operator',
  city: 'Pune',
  area: 'Chakan',
  applicationAction: 'applied',
);

Map<String, dynamic> _searchRow(int i) => <String, dynamic>{
  'job_id': 'job-$i',
  'title': 'CNC Operator $i',
  'city': 'Kota',
  'state': 'Rajasthan',
  'pay_min': 18000,
  'pay_max': 28000,
  'shift': 'day',
  'matched_skill_label': 'CNC Operator',
  'published_at': '2026-08-01T00:00:00Z',
};

JobSearchCubit _searchCubit({int rows = 0}) {
  final ApiClient api = ApiClient(
    baseUrl: 'http://test',
    client: MockClient(
      (http.Request req) async => http.Response(
        jsonEncode(<String, dynamic>{
          'jobs': <Map<String, dynamic>>[
            for (int i = 0; i < rows; i++) _searchRow(i),
          ],
          'page': 1,
          'limit': 20,
          'has_more': false,
        }),
        200,
      ),
    ),
  );
  return JobSearchCubit(JobSearchRepositoryImpl(api, _session()));
}

List<AppliedJob> _applied(int count) => <AppliedJob>[
  for (int i = 0; i < count; i++)
    AppliedJob(
      jobId: 'a$i',
      // A legacy slug on one row and an internal id on another: both must be
      // humanised or hidden, never printed.
      tradeKey: i == 0 ? 'cnc_operator' : 'mskill_mig_welder',
      title: 'CNC Turner / Setter for a precision components shop',
      city: 'Pune',
      area: i.isEven ? 'Pimpri' : null,
      action: 'applied',
      reason: null,
      sourceSurface: 'feed',
      rank: null,
      createdAt: DateTime(2026, 6, 1),
      updatedAt: DateTime(2026, 6, 1),
      matchedSkillLabel: null,
    ),
];

Widget _appliedScreen(int count) {
  final _MockApplicationsRepository repo = _MockApplicationsRepository();
  when(() => repo.appliedJobs()).thenAnswer((_) async => _applied(count));
  if (!locator.isRegistered<ApplicationsCubit>()) {
    locator.registerFactory<ApplicationsCubit>(() => ApplicationsCubit(repo));
  }
  return const AppliedJobsScreen();
}

/// Every string currently on screen, joined — for the "no raw ids" assertions.
String _allText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((Text t) => t.data ?? t.textSpan?.toPlainText() ?? '')
    .join(' ');

/// Picks three filters through the SHEET, which is the only path that writes
/// them (the feed holds the selection locally and seeds the sheet from it).
Future<void> _applyThreeFilters(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Filter jobs'));
  await tester.pumpAndSettle();
  for (final Key key in <Key>[
    const Key('jobFilterSuggestion_trade_CNC'),
    const Key('jobFilterSuggestion_city_Pune'),
    const Key('jobFilterSuggestion_experience_5+ yrs'),
  ]) {
    await tester.scrollUntilVisible(
      find.byKey(key),
      80,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.tap(find.byKey(key));
    await tester.pumpAndSettle();
  }
  await tester.tap(find.textContaining('Show '));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() async {
    await locator.reset();
    // The feed refetches on tab focus (T4) and resolves this from the locator.
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
  });

  tearDown(() async => locator.reset());

  // ── The matrix ────────────────────────────────────────────────────────────

  kitMatrixTest(
    'jobs feed — list body',
    () => _feedScreen(jobs: _jobs(3), list: true),
    primary: () => find.byType(BbJobCard),
  );

  kitMatrixTest(
    'jobs feed — deck body',
    () => _feedScreen(jobs: _jobs(3)),
    primary: () => find.byKey(const Key('swipeApplyButton')),
  );

  kitMatrixTest(
    'job detail — full posting',
    () => _detailScreen(_lightFull),
    primary: () => find.text('Apply karein'),
  );

  kitMatrixTest(
    'job detail — sparse posting (every optional block hidden)',
    () => _detailScreen(_lightSparse),
    primary: () => find.text('Apply karein'),
  );

  kitMatrixTest(
    'job detail — already applied',
    () => _detailScreen(_lightApplied),
    primary: () => find.text('Aapne apply kar diya ✓'),
  );

  kitMatrixTest(
    'job search — idle',
    () => JobSearchScreen(cubit: _searchCubit()),
    primary: () => find.byKey(const Key('jobSearchSubmitButton')),
  );

  kitMatrixTest(
    'job search — results',
    () => JobSearchScreen(
      cubit: _searchCubit(rows: 4)
        ..search(title: 'CNC operator', location: 'Kota, Rajasthan'),
    ),
    primary: () => find.byType(BbJobCard),
  );

  kitMatrixTest(
    'applied jobs — ready',
    () => _appliedScreen(3),
    primary: () => find.byType(BbJobCard),
  );

  kitMatrixTest(
    'applied jobs — empty',
    () => _appliedScreen(0),
    primary: () => find.text('Jobs dekhein'),
  );

  // The keyboard case: the only text input in this area is the job search form,
  // which lives in a collapsing sliver header.
  kitMatrixTest(
    'job search — small screen with the keyboard up',
    () => JobSearchScreen(cubit: _searchCubit()),
    primary: () => find.byKey(const Key('jobSearchTitleField')),
    keyboard: 260,
  );

  // ── Chrome in every state ─────────────────────────────────────────────────

  group('the navy chrome renders in EVERY feed state', () {
    // It used to vanish in loading / error / empty / no-match: a worker whose
    // filter matched nothing could not see which filter was active, could not
    // open the sheet, and had no bell.
    Future<void> expectChrome(WidgetTester tester, Widget screen) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      expect(find.text('Kaam milega.'), findsOneWidget);
      expect(find.byType(BbAlertsAction), findsOneWidget);
      expect(find.byType(KitFeedbackAction), findsOneWidget);
      expect(find.byKey(const Key('feedSearchBar')), findsOneWidget);
      expect(find.byKey(const Key('jobFeedViewToggle')), findsOneWidget);
      expect(find.byTooltip('Filter jobs'), findsOneWidget);
    }

    testWidgets('loading', (WidgetTester tester) async {
      await expectChrome(tester, _feedScreen(pending: true));
      expect(find.text('Jobs load ho rahe hain…'), findsOneWidget);
    });

    testWidgets('error', (WidgetTester tester) async {
      await expectChrome(tester, _feedScreen(error: const NetworkFailure()));
      expect(find.text('Jobs load nahi hue.'), findsOneWidget);
    });

    testWidgets('empty', (WidgetTester tester) async {
      await expectChrome(tester, _feedScreen(jobs: <FeedItem>[]));
      expect(find.text('Abhi naye jobs nahi hain.'), findsOneWidget);
    });

    testWidgets('consent required', (WidgetTester tester) async {
      await expectChrome(
        tester,
        _feedScreen(error: const ConsentRequiredFailure()),
      );
      expect(find.text('Please accept consent to see jobs.'), findsOneWidget);
    });

    testWidgets('no match', (WidgetTester tester) async {
      final SwipeBloc bloc = _feedBloc(jobs: _jobs(2));
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(_feedScreen(bloc: bloc)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      bloc.add(
        const SwipeFiltersChanged(
          FilterSelection(
            trades: <String>{'Welder'},
            cities: <String>{},
            experienceBands: <String>{},
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('Filter ke hisaab se koi job nahi mili.'), findsOneWidget);
      expect(find.text('Kaam milega.'), findsOneWidget);
      expect(find.byType(BbAlertsAction), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  // ── The count is the VISIBLE count, or nothing ────────────────────────────

  testWidgets('the strip counts the visible queue, and says nothing when there '
      'is nothing loaded', (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(_feedScreen(jobs: _jobs(3))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Aaj 3 naye jobs'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await locator.reset();
    locator.registerLazySingleton<TabFocus>(() => TabFocus());

    await tester.pumpWidget(kitTestApp(_feedScreen(pending: true)));
    await tester.pump();
    // Nothing is loaded, so there is no count to print — "0 naye jobs" would be
    // a claim about a queue nobody has seen.
    expect(find.textContaining('naye jobs'), findsNothing);
  });

  // ── Active filter chips ───────────────────────────────────────────────────

  group('the active-filter chip row', () {
    for (final (Size size, double scale) in <(Size, double)>[
      (Size(320, 568), 2.0),
      (Size(390, 844), 1.0),
      (Size(768, 1024), 1.0),
    ]) {
      testWidgets('survives three applied filters at ${size.width.toInt()}x'
          '${size.height.toInt()} @ ${scale}x', (WidgetTester tester) async {
        setKitSurface(tester, size);
        await tester.pumpWidget(
          kitTestApp(_feedScreen(jobs: _jobs(3)), textScale: scale),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));

        await _applyThreeFilters(tester);

        expect(tester.takeException(), isNull);
        expect(find.byKey(const Key('jobActiveFilterChips')), findsOneWidget);
        expect(
          find.byKey(const Key('jobFilterChip_trade_CNC')),
          findsOneWidget,
        );
        // The filter-active dot is on the strip's filter button.
        expect(find.byKey(const Key('jobs_filter_active_dot')), findsOneWidget);
      });
    }
  });

  // ── Tablet width caps ─────────────────────────────────────────────────────

  group('tablet 768: the content column stops instead of stretching', () {
    testWidgets('a list card caps at 600', (WidgetTester tester) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(
        kitTestApp(_feedScreen(jobs: _jobs(3), list: true)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        widthOf(tester, find.byType(BbJobCard).first),
        lessThanOrEqualTo(600),
      );
    });

    testWidgets('a deck card caps at 440', (WidgetTester tester) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(kitTestApp(_feedScreen(jobs: _jobs(3))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        widthOf(tester, find.byType(BbJobCard).first),
        lessThanOrEqualTo(440),
      );
    });

    testWidgets('an applied row caps at 600', (WidgetTester tester) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(kitTestApp(_appliedScreen(3)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        widthOf(tester, find.byType(BbJobCard).first),
        lessThanOrEqualTo(600),
      );
    });
  });

  // ── The deck on a screen with almost no height ────────────────────────────

  testWidgets('the deck compacts instead of overflowing at 320x400', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(320, 400));
    await tester.pumpWidget(kitTestApp(_feedScreen(jobs: _jobs(3))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('swipeApplyButton')), findsOneWidget);
    expect(find.byKey(const Key('swipeSkipButton')), findsOneWidget);
  });

  // ── Touch floor ───────────────────────────────────────────────────────────

  group('every control clears the 48dp worker touch floor', () {
    Future<void> check(WidgetTester tester, Widget screen) async {
      setKitSurface(tester, const Size(360, 640));
      await tester.pumpWidget(kitTestApp(screen));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await expectKitTapTargets(tester);
    }

    testWidgets('feed — deck', (WidgetTester tester) async {
      await check(tester, _feedScreen(jobs: _jobs(3)));
    });

    testWidgets('feed — list', (WidgetTester tester) async {
      await check(tester, _feedScreen(jobs: _jobs(3), list: true));
    });

    testWidgets('job detail', (WidgetTester tester) async {
      await check(tester, _detailScreen(_lightFull));
    });

    testWidgets('job search', (WidgetTester tester) async {
      await check(tester, JobSearchScreen(cubit: _searchCubit(rows: 3)));
    });

    testWidgets('applied jobs', (WidgetTester tester) async {
      await check(tester, _appliedScreen(3));
    });

    testWidgets('filters sheet', (WidgetTester tester) async {
      await check(
        tester,
        Scaffold(
          body: FiltersSheet(initial: FilterSelection.initial, jobs: _jobs(3)),
        ),
      );
    });
  });

  // ── No raw ids anywhere (D11) ─────────────────────────────────────────────

  group('no raw ids, slugs or enums on screen', () {
    final RegExp slug = RegExp(r'\b[a-z]+(_[a-z0-9]+)+\b');

    testWidgets('applied jobs humanises the legacy trade key and hides the '
        'internal id', (WidgetTester tester) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(_appliedScreen(2)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      final String surface = _allText(tester);
      // The humanized trade and the place are SEPARATE lines now — the
      // location row keeps its pin for a location only.
      expect(surface, contains('CNC Operator'));
      expect(surface, contains('Pimpri, Pune'));
      expect(surface.contains('cnc_operator'), isFalse);
      expect(surface.contains('mskill_'), isFalse);
      expect(surface.contains('role_'), isFalse);
      expect(slug.hasMatch(surface), isFalse, reason: surface);
    });

    testWidgets('the job detail never prints its trade key or an enum', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(_detailScreen(_lightFull)));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      final String surface = _allText(tester);
      expect(surface.contains('cnc_operator'), isFalse);
      expect(surface.contains('mskill_'), isFalse);
      // The coarse wire enums are mapped, never echoed.
      expect(surface.contains('immediate'), isFalse);
      expect(surface.contains('rotational'), isFalse);
      expect(slug.hasMatch(surface), isFalse, reason: surface);
    });

    testWidgets('a feed card never prints the trade key', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(
        kitTestApp(_feedScreen(jobs: _jobs(3), list: true)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      final String surface = _allText(tester);
      expect(surface.contains('cnc_operator'), isFalse);
      expect(slug.hasMatch(surface), isFalse, reason: surface);
    });
  });

  // ── The Feedback entry point (R2 / D9) ────────────────────────────────────

  testWidgets('the Jobs header owns Feedback, so the floating pill can be '
      'hidden on /jobs', (WidgetTester tester) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(_feedScreen(jobs: _jobs(3))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(KitFeedbackAction), findsOneWidget);
  });
}

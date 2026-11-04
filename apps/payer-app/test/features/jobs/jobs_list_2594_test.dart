import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/features/jobs/presentation/agency_jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/widgets/job_card_actions.dart';
import 'package:payer_app/features/jobs/presentation/widgets/job_list_format.dart';
import 'package:payer_app/features/jobs/presentation/widgets/jobs_empty_state.dart';

/// #2594 (M6) — the My-jobs list: the company card's Applicants button is
/// finally drawn, an open card has ONE main action plus a "⋯" sheet, a Close
/// never happens on one tap, a new account sees an empty state with a call to
/// action, counts and dates read like words, toasts name what happened, a
/// Pause offers Undo — and the sheet / collapse / toast motion follows the
/// shared tokens, dropping to zero under reduced motion.

// --- company ---------------------------------------------------------------

JobPosting _posting({
  String id = 'job-1',
  String title = 'CNC Setter',
  String wire = 'open',
  String band = '2-5',
  String? createdAt,
}) =>
    JobPosting(
      id: id,
      title: title,
      band: band,
      wireStatus: wire,
      createdAt: createdAt,
      locationLabel: 'Chakan, Pune',
      status: JobStatus.live,
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      verified: false,
      boosted: false,
    );

/// Serves [jobs] and records every lifecycle call, moving the row the way the
/// server would so the refetch shows the new state.
class _CompanyApi extends MockPayerApiClient {
  _CompanyApi(this.jobs);

  List<JobPosting> jobs;
  final List<String> calls = <String>[];
  Object? failClose;

  /// A slow list read — long enough for a frame to render between an action
  /// and its refetch, the way a real network does.
  Duration fetchDelay = Duration.zero;

  /// A slow resume — long enough for a second tap to land while it is out.
  Duration resumeDelay = Duration.zero;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    if (fetchDelay > Duration.zero) await Future<void>.delayed(fetchDelay);
    return jobs;
  }

  @override
  Future<JobPosting> pauseJob(String id) async => _move('pause', id, 'paused');

  @override
  Future<JobPosting> resumeJob(String id) async {
    if (resumeDelay > Duration.zero) await Future<void>.delayed(resumeDelay);
    // The server's rule: only a paused job resumes — a second resume 409s.
    if (jobs.firstWhere((JobPosting j) => j.id == id).wireStatus != 'paused') {
      calls.add('resume:$id');
      throw const PayerApiException(409);
    }
    return _move('resume', id, 'open');
  }

  @override
  Future<JobPosting> closeJob(String id) async {
    if (failClose != null) {
      calls.add('close:$id');
      throw failClose!;
    }
    return _move('close', id, 'closed');
  }

  JobPosting _move(String call, String id, String wire) {
    calls.add('$call:$id');
    final JobPosting row = jobs.firstWhere((JobPosting j) => j.id == id);
    final JobPosting next = _posting(
      id: id,
      title: row.title,
      wire: wire,
      band: row.band,
      createdAt: row.createdAt,
    );
    jobs = <JobPosting>[
      for (final JobPosting j in jobs) j.id == id ? next : j,
    ];
    return next;
  }
}

// --- agency ----------------------------------------------------------------

AgencyJobView _agencyJob({
  String id = 'agency-1',
  String status = 'open',
  int applicants = 1,
}) =>
    AgencyJobView(
      id: id,
      status: status,
      tradeKey: 'cnc_operator',
      title: 'CNC Operator — Day shift',
      city: 'Pune',
      area: 'Chakan',
      applicantsReceived: applicants,
    );

class _AgencyApi extends MockPayerApiClient {
  _AgencyApi(this.jobs);

  List<AgencyJobView> jobs;
  final List<String> closed = <String>[];

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async => jobs;

  @override
  Future<AgencyJobView> closeAgencyJob(String id) async {
    closed.add(id);
    final AgencyJobView row = jobs.firstWhere((AgencyJobView j) => j.id == id);
    final AgencyJobView next = _agencyJob(
      id: id,
      status: 'closed',
      applicants: row.applicantsReceived,
    );
    jobs = <AgencyJobView>[
      for (final AgencyJobView j in jobs) j.id == id ? next : j,
    ];
    return next;
  }
}

// --- harness ---------------------------------------------------------------

/// The app theme over [body]; [reduced] mirrors the OS "remove animations"
/// switch (above the Navigator, so the sheets see it too).
Widget _host(Widget body, {bool reduced = false}) => MaterialApp(
      theme: AppTheme.light(),
      builder: (BuildContext context, Widget? app) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
        child: app!,
      ),
      home: Scaffold(body: body),
    );

void _tallView(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

Future<_CompanyApi> _pumpCompany(
  WidgetTester tester,
  List<JobPosting> jobs, {
  VoidCallback? onPost,
  VoidCallback? onApplicants,
  void Function(String?)? onAiPost,
  bool reduced = false,
}) async {
  // Unmount any earlier tree first: its providers would keep the old cubits.
  await tester.pumpWidget(const SizedBox.shrink());
  await GetIt.instance.reset();
  final _CompanyApi api = _CompanyApi(jobs);
  setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  locator<AppSessionCubit>().signIn(PayerRole.company);
  _tallView(tester);
  await tester.pumpWidget(_host(
    JobsScreen(
      onPost: onPost ?? () {},
      onApplicants: onApplicants,
      onAiPost: onAiPost,
    ),
    reduced: reduced,
  ));
  await tester.pumpAndSettle();
  return api;
}

Future<_AgencyApi> _pumpAgency(
  WidgetTester tester,
  List<AgencyJobView> jobs, {
  VoidCallback? onPost,
  VoidCallback? onApplicants,
}) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await GetIt.instance.reset();
  final _AgencyApi api = _AgencyApi(jobs);
  setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  _tallView(tester);
  await tester.pumpWidget(_host(
    AgencyJobsView(onPost: onPost ?? () {}, onApplicants: onApplicants),
  ));
  await tester.pumpAndSettle();
  return api;
}

final Finder _more = find.byIcon(Icons.more_horiz_rounded);

Future<void> _openMenu(WidgetTester tester, {int row = 0}) async {
  await tester.tap(_more.at(row));
  await tester.pumpAndSettle();
}

/// ⋯ → Close job: leaves the Close confirmation open.
Future<void> _askToClose(WidgetTester tester, {int row = 0}) async {
  await _openMenu(tester, row: row);
  await tester.tap(find.text(kCloseJobConfirmLabel));
  await tester.pumpAndSettle();
  expect(find.text(kCloseJobTitle), findsOneWidget);
}

/// A tap on the scrim above an open sheet.
Future<void> _tapScrim(WidgetTester tester) async {
  await tester.tapAt(const Offset(10, 10));
  await tester.pumpAndSettle();
}

/// Lets every toast (2.4s) and the Undo toast (5s) time out, so no snack-bar
/// timer outlives the test.
Future<void> _drainToasts(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 6));
  await tester.pumpAndSettle();
}

void main() {
  tearDown(() async => GetIt.instance.reset());

  group('copy helpers', () {
    test('a count agrees with its noun', () {
      expect(countLabel(1, 'job'), '1 job');
      expect(countLabel(0, 'job'), '0 jobs');
      expect(countLabel(3, 'job'), '3 jobs');
      expect(countLabel(1, 'applicant'), '1 applicant');
      expect(countLabel(2, 'vacancy', plural: 'vacancies'), '2 vacancies');
    });

    test('a vacancy band reads with its noun', () {
      expect(vacanciesLabel('1'), '1 vacancy');
      expect(vacanciesLabel('2-5'), '2-5 vacancies');
      expect(vacanciesLabel('25+'), '25+ vacancies');
    });

    test('an ISO timestamp reads as a date; garbage reads as nothing', () {
      // Noon UTC is the same calendar day in every zone from UTC-11 to +11.
      expect(readableDate('2026-07-20T12:00:00Z'), '20 Jul 2026');
      expect(readableDate('2026-01-05T12:00:00Z'), '5 Jan 2026');
      expect(readableDate('not-a-date'), isNull);
    });
  });

  group('company My jobs', () {
    testWidgets('a new account sees the empty state, and its CTA posts',
        (WidgetTester tester) async {
      int posts = 0;
      await _pumpCompany(tester, const <JobPosting>[], onPost: () => posts++);

      expect(find.byType(JobsEmptyState), findsOneWidget);
      expect(find.text(kJobsEmptyTitle), findsOneWidget);
      expect(find.text(kJobsEmptyMessage), findsOneWidget);
      // Never a blank list with a bare "0 jobs" header.
      expect(find.text('0 jobs'), findsNothing);
      expect(find.text('MY JOB POSTINGS'), findsNothing);

      await tester.tap(find.text(kJobsEmptyCta));
      await tester.pumpAndSettle();
      expect(posts, 1);
    });

    testWidgets('the empty state keeps the AI create path when it is wired',
        (WidgetTester tester) async {
      final List<String?> opened = <String?>[];
      await _pumpCompany(
        tester,
        const <JobPosting>[],
        onAiPost: (String? id) => opened.add(id),
      );

      await tester.tap(find.text(kAiPostLabel));
      await tester.pumpAndSettle();
      expect(opened, <String?>[null]);
    });

    testWidgets('the header count agrees with its noun',
        (WidgetTester tester) async {
      await _pumpCompany(tester, <JobPosting>[_posting()]);
      expect(find.text('1 job'), findsOneWidget);
      expect(find.text('1 jobs'), findsNothing);

      await _pumpCompany(
        tester,
        <JobPosting>[_posting(), _posting(id: 'job-2')],
      );
      expect(find.text('2 jobs'), findsOneWidget);
    });

    testWidgets('dates read as dates and a single vacancy is singular',
        (WidgetTester tester) async {
      await _pumpCompany(tester, <JobPosting>[
        _posting(band: '1', createdAt: '2026-07-20T12:00:00Z'),
      ]);

      expect(find.textContaining('Posted 20 Jul 2026'), findsOneWidget);
      expect(find.textContaining('2026-07-20'), findsNothing);
      expect(find.textContaining('1 vacancy'), findsOneWidget);
      expect(find.textContaining('1 vacancies'), findsNothing);
    });

    testWidgets('an open card has ONE main action — Applicants — and a ⋯ sheet '
        'for the rest', (WidgetTester tester) async {
      int applicants = 0;
      await _pumpCompany(
        tester,
        <JobPosting>[_posting()],
        onApplicants: () => applicants++,
      );

      // The callback the card always had is finally drawn — and wired.
      await tester.tap(find.text('Applicants'));
      await tester.pumpAndSettle();
      expect(applicants, 1);

      // No stacked buttons: Pause / Edit / Close wait behind the "⋯".
      for (final String label in <String>[
        'Pause',
        'Close',
        kCloseJobConfirmLabel,
        'Edit details',
      ]) {
        expect(find.text(label), findsNothing, reason: label);
      }
      expect(_more, findsOneWidget);

      await _openMenu(tester);
      expect(find.text('Pause'), findsOneWidget);
      expect(find.text('Edit details'), findsOneWidget);
      expect(find.text(kCloseJobConfirmLabel), findsOneWidget);
    });

    testWidgets('Close requires confirmation — cancel and a scrim tap keep the '
        'job; only the confirm closes it', (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(),
      ]);

      await _askToClose(tester);
      expect(api.calls, isEmpty, reason: 'nothing is sent before the confirm');
      await tester.tap(find.byKey(kCloseJobCancelKey));
      await tester.pumpAndSettle();
      expect(find.text(kCloseJobTitle), findsNothing);
      expect(api.calls, isEmpty);

      await _askToClose(tester);
      await _tapScrim(tester);
      expect(api.calls, isEmpty, reason: 'tap-outside reads as cancel');
      expect(find.text('Open'), findsOneWidget);

      await _askToClose(tester);
      await tester.tap(find.byKey(kCloseJobConfirmKey));
      await tester.pumpAndSettle();

      expect(api.calls, <String>['close:job-1']);
      expect(find.text('Closed'), findsOneWidget);
      expect(find.text('This job is closed.'), findsOneWidget);
      expect(_more, findsNothing, reason: 'a closed job is terminal');
      // A toast that names what happened, not a generic "Done".
      expect(find.text('Job closed'), findsOneWidget);
      expect(find.text('Workers can no longer apply.'), findsOneWidget);
      expect(find.text('Done'), findsNothing);
      await _drainToasts(tester);
    });

    testWidgets('a refused Close names what failed and why',
        (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(),
      ]);
      api.failClose = const PayerApiException(409);

      await _askToClose(tester);
      await tester.tap(find.byKey(kCloseJobConfirmKey));
      await tester.pumpAndSettle();

      expect(find.text("Couldn't close"), findsOneWidget);
      expect(find.text('This job is already closed.'), findsOneWidget);
      expect(find.text('Not now'), findsNothing);
      await _drainToasts(tester);
    });

    testWidgets('a Pause names itself and offers Undo; Undo resumes the job',
        (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(),
      ]);

      await _openMenu(tester);
      await tester.tap(find.text('Pause'));
      await tester.pumpAndSettle();

      expect(api.calls, <String>['pause:job-1']);
      expect(find.text('Paused'), findsOneWidget);
      expect(find.text('Job paused'), findsOneWidget);
      expect(find.text(kJobUndoLabel), findsOneWidget);

      await tester.tap(find.text(kJobUndoLabel));
      await tester.pumpAndSettle();

      expect(api.calls, <String>['pause:job-1', 'resume:job-1']);
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Job resumed'), findsOneWidget);
      await _drainToasts(tester);
    });

    /// ⋯ → Pause on the first card, leaving its Undo toast up.
    Future<void> pauseFirst(WidgetTester tester) async {
      await _openMenu(tester);
      await tester.tap(find.text('Pause'));
      await tester.pumpAndSettle();
      expect(find.text(kJobUndoLabel), findsOneWidget);
    }

    testWidgets('an Undo that lands while the card is already resuming sends '
        'nothing — one tap, one request', (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(),
      ]);
      await pauseFirst(tester);

      // The card's own Resume goes first and is slow; the Undo lands on the
      // same frame, while that request is still out.
      api.resumeDelay = const Duration(seconds: 1);
      await tester.tap(find.text('Resume'));
      await tester.tap(find.text(kJobUndoLabel));
      await tester.pumpAndSettle();

      expect(api.calls, <String>['pause:job-1', 'resume:job-1']);
      expect(find.text('Open'), findsOneWidget);
      expect(find.text('Job resumed'), findsOneWidget);
      expect(find.text("Couldn't resume"), findsNothing);
      await _drainToasts(tester);
    });

    testWidgets("starting an action takes the Pause's Undo toast down at once",
        (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(),
      ]);
      await pauseFirst(tester);

      api.resumeDelay = const Duration(seconds: 2);
      await tester.tap(find.text('Resume'));
      // Past the toast's exit, still inside the request: the stale Undo is
      // gone rather than offering a second resume.
      await tester.pump(); // the exit's first frame
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text(kJobUndoLabel), findsNothing);
      expect(find.text('Job resumed'), findsNothing, reason: 'still in flight');

      await tester.pumpAndSettle();
      expect(api.calls, <String>['pause:job-1', 'resume:job-1']);
      expect(find.text('Job resumed'), findsOneWidget);
      await _drainToasts(tester);
    });

    testWidgets('a card scrolled out of the lazy list still honours its Undo',
        (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        for (int i = 0; i < 40; i++) _posting(id: 'job-$i', title: 'Job $i'),
      ]);
      await pauseFirst(tester);

      // Far enough down that the list disposes the paused card.
      final ScrollPosition list =
          tester.state<ScrollableState>(find.byType(Scrollable)).position;
      list.jumpTo(list.maxScrollExtent);
      await tester.pump();
      expect(find.text('Job 0', skipOffstage: false), findsNothing);

      await tester.tap(find.text(kJobUndoLabel));
      await tester.pumpAndSettle();
      expect(api.calls, <String>['pause:job-0', 'resume:job-0']);

      list.jumpTo(0);
      await tester.pumpAndSettle();
      expect(find.text('Job 0'), findsOneWidget);
      expect(find.text('Paused'), findsNothing);
      await _drainToasts(tester);
    });

    testWidgets('a paused card: Resume is the main action; its ⋯ offers Edit '
        'only', (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(wire: 'paused'),
      ]);

      expect(find.text('Applicants'), findsNothing);
      await _openMenu(tester);
      expect(find.text('Edit details'), findsOneWidget);
      expect(find.text('Pause'), findsNothing);
      expect(find.text(kCloseJobConfirmLabel), findsNothing);
      await _tapScrim(tester);

      await tester.tap(find.text('Resume'));
      await tester.pumpAndSettle();
      expect(api.calls, <String>['resume:job-1']);
      expect(find.text('Job resumed'), findsOneWidget);
      await _drainToasts(tester);
    });

    testWidgets('a draft card: Publish is the main action; its ⋯ offers Edit '
        'and Close', (WidgetTester tester) async {
      await _pumpCompany(tester, <JobPosting>[_posting(wire: 'draft')]);

      expect(find.text('Publish'), findsOneWidget);
      await _openMenu(tester);
      expect(find.text('Edit details'), findsOneWidget);
      expect(find.text(kCloseJobConfirmLabel), findsOneWidget);
      expect(find.text('Pause'), findsNothing);
      await _tapScrim(tester);

      await tester.tap(find.text('Publish'));
      await tester.pumpAndSettle();
      expect(find.text('Job published'), findsOneWidget);
      await _drainToasts(tester);
    });
  });

  group('agency My jobs', () {
    testWidgets('a new agency account sees the empty state, and its CTA posts',
        (WidgetTester tester) async {
      int posts = 0;
      await _pumpAgency(tester, const <AgencyJobView>[], onPost: () => posts++);

      expect(find.text(kJobsEmptyTitle), findsOneWidget);
      expect(find.text('0 jobs'), findsNothing);
      await tester.tap(find.text(kJobsEmptyCta));
      await tester.pumpAndSettle();
      expect(posts, 1);
    });

    testWidgets('one main action (Applicants), and counts agree with nouns',
        (WidgetTester tester) async {
      int applicants = 0;
      await _pumpAgency(
        tester,
        <AgencyJobView>[_agencyJob()],
        onApplicants: () => applicants++,
      );

      expect(find.text('1 job'), findsOneWidget);
      expect(find.text('1 applicant received'), findsOneWidget);
      expect(find.text('Edit details'), findsNothing);
      expect(find.text('Close'), findsNothing);

      await tester.tap(find.text('Applicants'));
      await tester.pumpAndSettle();
      expect(applicants, 1);
    });

    testWidgets('Close requires confirmation on the agency card too',
        (WidgetTester tester) async {
      final _AgencyApi api = await _pumpAgency(
        tester,
        <AgencyJobView>[_agencyJob()],
      );

      await _askToClose(tester);
      expect(api.closed, isEmpty, reason: 'nothing is sent before the confirm');
      await tester.tap(find.byKey(kCloseJobCancelKey));
      await tester.pumpAndSettle();
      expect(api.closed, isEmpty);
      expect(find.text('Open'), findsOneWidget);

      await _askToClose(tester);
      await tester.tap(find.byKey(kCloseJobConfirmKey));
      await tester.pumpAndSettle();

      expect(api.closed, <String>['agency-1']);
      expect(find.text('This job is closed.'), findsOneWidget);
      expect(find.text('Job closed'), findsOneWidget);
      expect(find.text('No longer taking applicants.'), findsOneWidget);
      await _drainToasts(tester);
    });
  });

  group('360dp handset', () {
    Future<void> narrow(WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      await tester.pumpAndSettle();
    }

    const String longTitle =
        'Senior CNC Setter and Programmer — Night shift, Chakan MIDC Phase 2';

    testWidgets('a long-titled card and both sheets lay out without overflow',
        (WidgetTester tester) async {
      await _pumpCompany(tester, <JobPosting>[
        _posting(title: longTitle, createdAt: '2026-07-20T12:00:00Z'),
      ]);
      await narrow(tester);
      expect(tester.takeException(), isNull);
      expect(find.text('Applicants'), findsOneWidget);

      await _askToClose(tester);
      expect(tester.takeException(), isNull);
      expect(find.byKey(kCloseJobConfirmKey), findsOneWidget);
      expect(find.byKey(kCloseJobCancelKey), findsOneWidget);
    });

    testWidgets('the empty state (with the AI path) fits without overflow',
        (WidgetTester tester) async {
      await _pumpCompany(
        tester,
        const <JobPosting>[],
        onAiPost: (String? _) {},
      );
      await narrow(tester);
      expect(tester.takeException(), isNull);
      expect(find.text(kJobsEmptyCta), findsOneWidget);
      expect(find.text(kAiPostLabel), findsOneWidget);
    });
  });

  group('motion', () {
    Duration routeDuration(WidgetTester tester, Finder inSheet) =>
        ModalRoute.of(tester.element(inSheet))!.transitionDuration;

    testWidgets('the ⋯ sheet and the Close confirmation slide up over '
        'AppMotion.sheet (280ms)', (WidgetTester tester) async {
      await _pumpCompany(tester, <JobPosting>[_posting()]);

      await _openMenu(tester);
      expect(routeDuration(tester, find.text('Pause')), AppMotion.sheet);
      expect(AppMotion.sheet, const Duration(milliseconds: 280));

      await tester.tap(find.text(kCloseJobConfirmLabel));
      await tester.pumpAndSettle();
      expect(
        routeDuration(tester, find.text(kCloseJobTitle)),
        AppMotion.sheet,
      );
    });

    testWidgets('with animations disabled both sheets are instant and a '
        'closed card snaps (no collapse, no assert)',
        (WidgetTester tester) async {
      await _pumpCompany(tester, <JobPosting>[_posting()], reduced: true);
      double cardHeight() =>
          tester.getSize(find.byType(JobCardSurface)).height;
      final double open = cardHeight();

      // No size animation at all: a zero-length AnimatedSize re-dirties its
      // own layout on the first change and throws.
      expect(
        find.descendant(
          of: find.byType(JobCardSurface),
          matching: find.byType(AnimatedSize),
        ),
        findsNothing,
      );
      final AnimatedOpacity fade = tester.widget<AnimatedOpacity>(
        find.descendant(
          of: find.byType(JobCardSurface),
          matching: find.byType(AnimatedOpacity),
        ),
      );
      expect(fade.duration, Duration.zero);

      await _openMenu(tester);
      expect(routeDuration(tester, find.text('Pause')), Duration.zero);
      await tester.tap(find.text(kCloseJobConfirmLabel));
      await tester.pumpAndSettle();
      expect(routeDuration(tester, find.text(kCloseJobTitle)), Duration.zero);

      await tester.tap(find.byKey(kCloseJobConfirmKey));
      for (int i = 0;
          i < 5 && find.text('This job is closed.').evaluate().isEmpty;
          i++) {
        await tester.pump();
      }
      expect(find.text('This job is closed.'), findsOneWidget);
      final double closedNow = cardHeight();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(closedNow, lessThan(open));
      expect(cardHeight(), closedNow, reason: 'already at rest — it snapped');
      await _drainToasts(tester);
    });

    testWidgets('a closed card collapses its height and fades over '
        'AppMotion.base (220ms)', (WidgetTester tester) async {
      final _CompanyApi api = await _pumpCompany(tester, <JobPosting>[
        _posting(),
      ]);
      double cardHeight() =>
          tester.getSize(find.byType(JobCardSurface)).height;
      final double open = cardHeight();

      await _askToClose(tester);
      // Frames render while the refetch is in flight: the list must stay
      // mounted through them (a loading flash would rebuild the card closed,
      // with nothing to collapse from).
      api.fetchDelay = const Duration(milliseconds: 50);
      await tester.tap(find.byKey(kCloseJobConfirmKey));
      for (int i = 0;
          i < 20 && find.text('This job is closed.').evaluate().isEmpty;
          i++) {
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(find.text('This job is closed.'), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 110));
      final double midway = cardHeight();
      await tester.pumpAndSettle();
      final double closed = cardHeight();

      expect(closed, lessThan(open), reason: 'the action row is gone');
      expect(midway, lessThan(open), reason: 'the height animates down…');
      expect(midway, greaterThan(closed), reason: '…rather than snapping');

      final AnimatedOpacity fade = tester.widget<AnimatedOpacity>(
        find.descendant(
          of: find.byType(JobCardSurface),
          matching: find.byType(AnimatedOpacity),
        ),
      );
      expect(fade.opacity, JobCardSurface.dimOpacity);
      expect(fade.duration, AppMotion.base);
      expect(fade.curve, AppMotion.easeIn, reason: 'ease-in to exit');
      expect(AppMotion.base, const Duration(milliseconds: 220));
      await _drainToasts(tester);
    });

    testWidgets('the Undo toast slides up ≤6px over AppMotion.base, and is '
        'instant under reduced motion', (WidgetTester tester) async {
      double riseOffset() => tester
          .widget<Transform>(find.descendant(
            of: find.byType(JobToastRise),
            matching: find.byType(Transform),
          ))
          .transform
          .getTranslation()
          .y;

      Future<void> pauseFirstJob() async {
        await _openMenu(tester);
        await tester.tap(find.text('Pause'));
        for (int i = 0;
            i < 5 && find.byType(JobToastRise).evaluate().isEmpty;
            i++) {
          await tester.pump();
        }
        expect(find.byType(JobToastRise), findsOneWidget);
      }

      await _pumpCompany(tester, <JobPosting>[_posting()]);
      await pauseFirstJob();
      expect(
        tester.widget<JobToastRise>(find.byType(JobToastRise)).duration,
        AppMotion.base,
      );
      expect(JobToastRise.distance, lessThanOrEqualTo(6));
      expect(riseOffset(), closeTo(JobToastRise.distance, 0.01),
          reason: 'it starts below its resting place…');
      await tester.pump(AppMotion.base);
      expect(riseOffset(), closeTo(0, 0.01), reason: '…and rises into it');
      await _drainToasts(tester);

      await _pumpCompany(tester, <JobPosting>[_posting()], reduced: true);
      await pauseFirstJob();
      expect(riseOffset(), closeTo(0, 0.01), reason: 'no travel when reduced');
      await _drainToasts(tester);
    });
  });
}

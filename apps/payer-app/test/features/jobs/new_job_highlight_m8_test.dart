import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/core/widgets/bb_card.dart';
import 'package:payer_app/core/widgets/bb_new_item_highlight.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';
import 'package:payer_app/features/job_posting_chat/presentation/job_posting_chat_screen.dart';
import 'package:payer_app/features/jobs/presentation/agency_jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/cubit/jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/post_job_screen.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2596 (M8) — after posting a job the payer lands on Jobs with the NEW card
/// scrolled into view and briefly tinted with the brand's haldi tint (fading
/// over 1.5s) — once, never on a later visit. Acceptance: "The new job is
/// scrolled into view and highlighted".
const String _newId = 'job-new';

JobPosting _job(String id, String title) => JobPosting(
      id: id,
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.review,
      verified: false,
      boosted: false,
      wireStatus: 'draft',
      locationLabel: 'Pune',
    );

/// Company postings, the new one FOURTH so it starts below the fold on a
/// 360×640 phone with the compact M6 card (the server lists newest first, so
/// in production it is the first card — this is the harder case).
class _JobsApi extends MockPayerApiClient {
  _JobsApi(this.jobs);

  List<JobPosting> jobs;

  /// True → the list read fails (an outage), so no row is ever built.
  bool failList = false;

  /// While set, a list read waits on it, so a test can hold the loading frame.
  Completer<void>? gate;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async {
    final Completer<void>? hold = gate;
    if (hold != null) await hold.future;
    if (failList) throw const PayerApiException(503);
    return jobs;
  }
}

final List<JobPosting> _list = <JobPosting>[
  _job('job-a', 'VMC Operator'),
  _job('job-b', 'Welder'),
  _job('job-d', 'Grinder'),
  _job(_newId, 'CNC Setter (new)'),
  _job('job-c', 'Fitter'),
];

/// The surface colour the highlight hands its card (null: the card's own).
Color? _tintOf(WidgetTester tester) => tester
    .widget<BbCardSurfaceTint>(find.byKey(BbNewItemHighlight.tintKey))
    .color;

const Color _haldiTint = AppColors.haldiTint;
const Color? _noTint = null;

/// The colour the card titled [title] actually paints its surface with.
Color? _surfaceOf(WidgetTester tester, String title) {
  final Finder card = find
      .ancestor(of: find.text(title), matching: find.byType(BbCard))
      .first;
  final Container surface = tester.widget<Container>(
    find.descendant(of: card, matching: find.byType(Container)).first,
  );
  return (surface.decoration! as BoxDecoration).color;
}

/// The tinted subtree must be the NEW card's.
Finder _tinted(String title) => find.descendant(
      of: find.byKey(BbNewItemHighlight.tintKey),
      matching: find.text(title),
    );

void main() {
  late _JobsApi api;

  setUp(() async {
    await GetIt.instance.reset();
    api = _JobsApi(List<JobPosting>.of(_list));
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  void phone(WidgetTester tester) {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
  }

  Widget host(Widget child, {bool reduced = true}) => MaterialApp(
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: app!,
        ),
        home: Scaffold(body: child),
      );

  /// True when [finder]'s whole box sits inside its list's visible viewport.
  bool fullyOnScreen(WidgetTester tester, Finder finder) {
    final Rect r = tester.getRect(finder);
    final Rect viewport = tester.getRect(
      find.ancestor(of: finder, matching: find.byType(Scrollable)).first,
    );
    return r.top >= viewport.top - 0.5 && r.bottom <= viewport.bottom + 0.5;
  }

  Finder cardOf(String title) => find.ancestor(
        of: find.text(title),
        matching: find.byType(BbNewItemHighlight),
      );

  group('JobsScreen — company', () {
    testWidgets('the new card is scrolled into view and highlighted',
        (WidgetTester tester) async {
      phone(tester);
      // Control: with no request the new card starts below the fold.
      await tester.pumpWidget(host(JobsScreen(onPost: () {})));
      await tester.pumpAndSettle();
      expect(fullyOnScreen(tester, cardOf('CNC Setter (new)')), isFalse);
      expect(find.byKey(BbNewItemHighlight.tintKey), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(host(JobsScreen(
        onPost: () {},
        highlight: BbHighlightRequest(_newId),
      )));
      await tester.pump(); // loading → ready
      await tester.pump(); // the post-frame scroll

      expect(fullyOnScreen(tester, cardOf('CNC Setter (new)')), isTrue);
      // Exactly one card is tinted — the new one — in the haldi tint.
      expect(find.byKey(BbNewItemHighlight.tintKey), findsOneWidget);
      expect(_tinted('CNC Setter (new)'), findsOneWidget);
      expect(_tintOf(tester), _haldiTint);
      expect(_surfaceOf(tester, 'CNC Setter (new)'), AppColors.haldiTint);
      expect(_surfaceOf(tester, 'Welder'), AppColors.surfaceCard);

      // Reduced motion: the tint holds for the full 1.5s, then goes (no fade).
      await tester.pump(const Duration(milliseconds: 1400));
      expect(_tintOf(tester), _haldiTint);
      await tester.pump(const Duration(milliseconds: 150));
      expect(_tintOf(tester), _noTint);
      expect(_surfaceOf(tester, 'CNC Setter (new)'), AppColors.surfaceCard);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
        'ONLY the surface is tinted — nothing on the card is recoloured '
        '(no filter over its text, buttons, badges or hairline)',
        (WidgetTester tester) async {
      phone(tester);
      await tester.pumpWidget(host(JobsScreen(
        onPost: () {},
        highlight: BbHighlightRequest(_newId),
      )));
      await tester.pump();
      await tester.pump();

      expect(_surfaceOf(tester, 'CNC Setter (new)'), AppColors.haldiTint);
      // No colour filter anywhere above the card's content.
      expect(
        find.ancestor(
          of: find.text('CNC Setter (new)'),
          matching: find.byType(ColorFiltered),
        ),
        findsNothing,
      );
      expect(find.byType(ColorFiltered), findsNothing);
      // The hairline keeps its token.
      final Finder card = find
          .ancestor(
            of: find.text('CNC Setter (new)'),
            matching: find.byType(BbCard),
          )
          .first;
      final BoxDecoration surface = tester
          .widget<Container>(
            find.descendant(of: card, matching: find.byType(Container)).first,
          )
          .decoration! as BoxDecoration;
      expect((surface.border! as Border).top.color, AppColors.border);
      await tester.pumpAndSettle();
    });

    testWidgets('with animations on, the tint fades out over 1.5s',
        (WidgetTester tester) async {
      phone(tester);
      await tester.pumpWidget(host(
        JobsScreen(onPost: () {}, highlight: BbHighlightRequest(_newId)),
        reduced: false,
      ));
      await tester.pump();
      await tester.pump();
      expect(_tintOf(tester), _haldiTint);

      await tester.pump(const Duration(milliseconds: 750));
      final Color? mid = _tintOf(tester);
      expect(mid, isNotNull);
      expect(mid, isNot(_haldiTint));
      expect(mid, isNot(AppColors.surfaceCard));

      await tester.pumpAndSettle();
      expect(_tintOf(tester), _noTint);
      expect(fullyOnScreen(tester, cardOf('CNC Setter (new)')), isTrue);
    });

    testWidgets('it plays once — a refetch or a remount never re-highlights',
        (WidgetTester tester) async {
      phone(tester);
      final BbHighlightRequest request = BbHighlightRequest(_newId);
      await tester.pumpWidget(
        host(JobsScreen(onPost: () {}, highlight: request)),
      );
      await tester.pumpAndSettle();
      expect(request.claimed, isTrue);
      expect(_tintOf(tester), _noTint, reason: 'faded out after 1.5s');

      // A lifecycle action refetches the list: the tint does not come back.
      // The read is held so the loading frame really renders: it replaces the
      // list, so every row unmounts and is built fresh, which is the case
      // where a replay could happen.
      final JobsCubit cubit = BlocProvider.of<JobsCubit>(
        tester.element(find.byType(ListView)),
      );
      final Completer<void> gate = Completer<void>();
      api.gate = gate;
      final Future<void> refetch = cubit.load();
      await tester.pump(); // delivers the loading state
      await tester.pump(); // draws it
      expect(find.text('CNC Setter (new)'), findsNothing,
          reason: 'the loading view replaced the rows');
      api.gate = null;
      gate.complete();
      await refetch;
      // Checked before the 1.5s fade could finish: a replayed highlight would
      // still be showing here.
      await tester.pump();
      await tester.pump();
      expect(find.text('CNC Setter (new)', skipOffstage: false),
          findsOneWidget);
      expect(find.byKey(BbNewItemHighlight.tintKey), findsNothing);
      expect(_surfaceOf(tester, 'CNC Setter (new)'), AppColors.surfaceCard);
      await tester.pumpAndSettle();

      // A later visit (a fresh mount holding the same request): nothing.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(
        host(JobsScreen(onPost: () {}, highlight: request)),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(BbNewItemHighlight.tintKey), findsNothing);
    });

    testWidgets('a request for a row that is not listed tints nothing',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(JobsScreen(
        onPost: () {},
        highlight: BbHighlightRequest('job-unknown'),
      )));
      await tester.pumpAndSettle();
      expect(find.byKey(BbNewItemHighlight.tintKey), findsNothing);
    });
  });

  testWidgets('AgencyJobsView — the new agency card is highlighted too',
      (WidgetTester tester) async {
    phone(tester);
    locator<AppSessionCubit>().signIn(PayerRole.agency);
    final AgencyJobView created = await api.createAgencyJob(
      tradeKey: 'cnc_vmc_setter',
      title: 'Lathe hand (new)',
      city: 'Pune',
    );
    await tester.pumpWidget(host(AgencyJobsView(
      onPost: () {},
      highlight: BbHighlightRequest(created.id),
    )));
    await tester.pumpAndSettle();

    expect(_tinted('Lathe hand (new)'), findsOneWidget);
    expect(find.byKey(BbNewItemHighlight.tintKey), findsOneWidget);
    expect(fullyOnScreen(tester, cardOf('Lathe hand (new)')), isTrue);
  });

  group('AppShell — a post lands on Jobs with the new card highlighted', () {
    const AppSession session = AppSession(
      role: PayerRole.company,
      account: PayerAccount(
        name: 'Kalyani Industries',
        plan: 'Starter',
        initials: 'KI',
      ),
    );

    // Default surface: the Post form's own header is not this issue's (M7).
    Future<void> pumpShell(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          builder: (BuildContext context, Widget? app) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: app!,
          ),
          home: BlocProvider<AppSessionCubit>.value(
            value: locator<AppSessionCubit>(),
            child: const AppShell(session: session),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    String navId(WidgetTester tester) =>
        tester.widget<BbBottomNav>(find.byType(BbBottomNav)).currentId;

    Future<void> tapNav(WidgetTester tester, String label) async {
      await tester.tap(find.descendant(
        of: find.byType(BbBottomNav),
        matching: find.text(label),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'Post a job (from Home) → Jobs, new card in view + tinted; '
        'a later visit does not replay it', (WidgetTester tester) async {
      await pumpShell(tester);
      await tester.tap(find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('Post a job'),
      ));
      await tester.pumpAndSettle();

      // The form's success hand-off (its submit is covered on its own below).
      tester
          .widget<PostJobScreen>(find.byType(PostJobScreen))
          .onPosted!(_newId);
      await tester.pump(); // the shell lands on Jobs (list loading)
      await tester.pump(); // ready: the new card claims the highlight
      await tester.pump(); // its post-frame scroll into view

      expect(navId(tester), 'jobs');
      expect(find.byType(PostJobScreen, skipOffstage: false), findsNothing);
      expect(_tinted('CNC Setter (new)'), findsOneWidget);
      expect(fullyOnScreen(tester, cardOf('CNC Setter (new)')), isTrue);
      await tester.pumpAndSettle();

      await tapNav(tester, 'Home');
      await tapNav(tester, 'Jobs');
      // #2592 — a later visit re-reads the KEPT list in place, so the faded
      // scope may still be in the tree; what matters is that nothing is
      // tinted again.
      expect(
        tester
            .widgetList<BbCardSurfaceTint>(
                find.byKey(BbNewItemHighlight.tintKey))
            .where((BbCardSurfaceTint t) => t.color != null),
        isEmpty,
      );
    });

    testWidgets(
        'a highlight no row claimed is dropped with the visit: the landing '
        'list fails, the payer leaves and comes back → no tint',
        (WidgetTester tester) async {
      // Newest first, as the server lists them: the new row is built at once.
      api.jobs = <JobPosting>[
        _job(_newId, 'CNC Setter (new)'),
        _job('job-a', 'VMC Operator'),
      ];
      await pumpShell(tester);
      await tester.tap(find.descendant(
        of: find.byType(HomeScreen),
        matching: find.text('Post a job'),
      ));
      await tester.pumpAndSettle();

      api.failList = true;
      tester
          .widget<PostJobScreen>(find.byType(PostJobScreen))
          .onPosted!(_newId);
      await tester.pumpAndSettle();
      expect(navId(tester), 'jobs');
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byKey(BbNewItemHighlight.tintKey), findsNothing);

      // Minutes later the list loads fine — on a NEW visit, not the landing.
      api.failList = false;
      await tapNav(tester, 'Home');
      await tapNav(tester, 'Jobs');
      expect(find.text('CNC Setter (new)'), findsOneWidget);
      expect(find.byKey(BbNewItemHighlight.tintKey), findsNothing);
    });

    testWidgets('an AI-chat publish lands the same way',
        (WidgetTester tester) async {
      // #2592 — Jobs keeps its list across the chat, so the new posting is
      // listed only once it is published (as the server would list it).
      api.jobs = _list.where((JobPosting j) => j.id != _newId).toList();
      await pumpShell(tester);
      await tapNav(tester, 'Jobs');
      await tester.tap(find.text(kAiPostLabel));
      await tester.pumpAndSettle();

      api.jobs = List<JobPosting>.of(_list);
      tester
          .widget<JobPostingChatScreen>(find.byType(JobPostingChatScreen))
          .onPostedJob!(_newId);
      // #2592 — Jobs was already open: the landing re-reads its kept list
      // quietly, a frame after the return signal; then the new card claims
      // the highlight and scrolls into view.
      await tester.pump();
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(navId(tester), 'jobs');
      expect(
        find.byType(JobPostingChatScreen, skipOffstage: false),
        findsNothing,
      );
      expect(_tinted('CNC Setter (new)'), findsOneWidget);
      await tester.pumpAndSettle();
    });
  });
}

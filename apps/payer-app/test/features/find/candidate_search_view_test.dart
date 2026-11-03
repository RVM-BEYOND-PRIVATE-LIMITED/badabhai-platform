import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/widgets/bb_avatar.dart';
import 'package:payer_app/features/find/presentation/candidate_search_view.dart';
import 'package:payer_app/features/find/presentation/cubit/candidate_search_cubit.dart';
import 'package:payer_app/features/find/presentation/find_screen.dart';
import 'package:payer_app/features/find/presentation/reveal_args.dart';
import 'package:payer_app/features/find/presentation/widgets/find_view_switch.dart';

/// Find's All-candidates view, end to end over a scripted data seam (the real
/// route is not running): the segmented control, the masked card, the count
/// badge copy, the "Other candidates" line, strict-zero / empty-pool / 429 /
/// refused-cursor states, "Load more", the filter sheet, and the unlock →
/// reveal hand-off with NO job.
final Map<String, dynamic> _fixture = jsonDecode(
  File('../../packages/types/fixtures/candidate-search-contract.json')
      .readAsStringSync(),
) as Map<String, dynamic>;

final CandidateSearchPage _fixturePage =
    CandidateSearchPage.tryFromJson(_fixture['response'] as Map<String, dynamic>)!;
final CandidateSearchPage _fixtureStrictZero = CandidateSearchPage.tryFromJson(
    _fixture['emptyStrictResponse'] as Map<String, dynamic>)!;
final CandidateFilters _fixtureFilters =
    CandidateFilters.tryFromJson(_fixture['filters'] as Map<String, dynamic>)!;

/// Row 1 of the fixture: a CNC Turner in Pune, a Setter, tier 1, a match.
final CandidateSearchRow _turner = _fixturePage.candidates[0];

/// Row 2: a VMC Operator, tier 2 (related), NOT a match, city + industry
/// tenure not recorded.
final CandidateSearchRow _vmc = _fixturePage.candidates[1];

CandidateSearchPage _page(
  List<CandidateSearchRow> rows, {
  int total = 62,
  int matched = 14,
  int unrecorded = 0,
  bool filtered = false,
  bool strict = false,
  String? next,
}) =>
    CandidateSearchPage(
      total: total,
      matched: matched,
      unrecorded: unrecorded,
      filtered: filtered,
      strict: strict,
      candidates: rows,
      nextCursor: next,
    );

class _ViewApi extends MockPayerApiClient {
  final List<CandidateSearchQuery> searches = <CandidateSearchQuery>[];
  Future<CandidateSearchPage> Function(CandidateSearchQuery q) onSearch =
      (CandidateSearchQuery q) async => _page(<CandidateSearchRow>[_turner, _vmc]);
  List<PayerUnlock> history = const <PayerUnlock>[];
  int applicantListLoads = 0;
  final List<({String workerId, String? jobId})> unlockCalls =
      <({String workerId, String? jobId})>[];

  @override
  Future<CandidateSearchPage> searchCandidates(CandidateSearchQuery query) {
    searches.add(query);
    return onSearch(query);
  }

  @override
  Future<CandidateFilters> fetchCandidateFilters() async => _fixtureFilters;

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() async => history;

  @override
  Future<List<Candidate>> fetchCandidates() {
    applicantListLoads++;
    return super.fetchCandidates();
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async {
    unlockCalls.add((workerId: workerId, jobId: jobId));
    return const UnlockResult.granted(unlockId: 'unl-search-1');
  }
}

const CandidateSearchQuery _turnerQuery =
    CandidateSearchQuery(skillIds: <String>['mskill_cnc_turner']);

void main() {
  late _ViewApi api;
  late List<RevealArgs> revealed;
  CandidateSearchCubit? cubit;

  setUp(() async {
    await GetIt.instance.reset();
    api = _ViewApi();
    revealed = <RevealArgs>[];
    cubit = null;
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    // Capture the screen's cubit so a test can drive a query directly.
    locator.unregister<CandidateSearchCubit>();
    locator.registerFactory<CandidateSearchCubit>(
      () => cubit = CandidateSearchCubit(locator<PayerApiClient>()),
    );
  });

  Future<void> pumpFind(
    WidgetTester tester, {
    FindView initialView = FindView.allCandidates,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: FindScreen(onReveal: revealed.add, initialView: initialView),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> runQuery(WidgetTester tester, CandidateSearchQuery q) async {
    // ignore: discarded_futures
    cubit!.applyQuery(q);
    await tester.pumpAndSettle();
  }

  /// The counts line — the badge's FIRST RichText (a strict note below it is a
  /// Text, which renders a RichText of its own).
  String badgeText(WidgetTester tester) => tester
      .widget<RichText>(find
          .descendant(
            of: find.byKey(const Key('candidate_count_badge')),
            matching: find.byType(RichText),
          )
          .first)
      .text
      .toPlainText();

  FindView selectedView(WidgetTester tester) =>
      tester.widget<FindViewSwitch>(find.byType(FindViewSwitch)).selected;

  group('the segmented control', () {
    testWidgets('opens on All candidates; Applicants stays unloaded until opened',
        (WidgetTester tester) async {
      await pumpFind(tester);

      expect(selectedView(tester), FindView.allCandidates);
      expect(find.text('ALL CANDIDATES'), findsOneWidget);
      expect(api.searches, hasLength(1));
      expect(api.applicantListLoads, 0,
          reason: 'a view the payer never opens costs no request');
    });

    testWidgets('switching shows the per-job feed; coming back keeps the list',
        (WidgetTester tester) async {
      await pumpFind(tester);

      await tester.tap(find.byKey(const Key('find_view_applicants')));
      await tester.pumpAndSettle();

      expect(selectedView(tester), FindView.applicants);
      expect(find.text('CANDIDATES FOR CNC SETTER'), findsOneWidget);
      expect(find.text('ALL CANDIDATES'), findsNothing);
      expect(api.applicantListLoads, 1);

      await tester.tap(find.byKey(const Key('find_view_all')));
      await tester.pumpAndSettle();

      expect(find.text('ALL CANDIDATES'), findsOneWidget);
      expect(find.text('CNC Turner'), findsOneWidget);
      expect(api.searches, hasLength(1),
          reason: 'the hidden view kept its page — no refetch on a peek');
    });

    testWidgets('with no view named, Find opens on All candidates',
        (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: FindScreen(onReveal: revealed.add))),
      );
      await tester.pumpAndSettle();

      expect(selectedView(tester), FindView.allCandidates);
      expect(api.searches, hasLength(1));
    });

    testWidgets('a Jobs "Applicants" entry opens on the Applicants view',
        (WidgetTester tester) async {
      await pumpFind(tester, initialView: FindView.applicants);

      expect(selectedView(tester), FindView.applicants);
      expect(api.searches, isEmpty);
      expect(api.applicantListLoads, 1);
    });
  });

  group('the masked card', () {
    testWidgets('leads with the role; facts only — no name, phone or photo',
        (WidgetTester tester) async {
      await pumpFind(tester);

      // Row 1 — every recorded fact.
      expect(find.text('CNC Turner'), findsOneWidget);
      expect(find.text('Worker ••0003'), findsOneWidget);
      expect(find.text('4 yrs experience'), findsOneWidget);
      expect(find.text('Industrial Manufacturing · 4.5 yrs'), findsOneWidget);
      expect(find.text('Pune'), findsOneWidget);
      expect(find.text('Setter'), findsOneWidget, reason: 'the stated rung');
      expect(find.text('CNC Setter-Operator'), findsOneWidget,
          reason: 'his other role, as a tag');

      // Row 2 — the unrecorded facts read as such; no city is invented.
      expect(find.text('VMC Operator'), findsOneWidget);
      expect(find.text('2 yrs experience'), findsOneWidget);
      expect(find.text('Industrial Manufacturing · years not recorded'),
          findsOneWidget);

      // Faceless: masked avatars only, and nothing phone- or name-shaped.
      for (final BbAvatar a in tester.widgetList<BbAvatar>(find.byType(BbAvatar))) {
        expect(a.mode, BbAvatarMode.masked);
        expect(a.initials, '••');
      }
      final RegExp phone = RegExp(r'(\+91|\b\d{10}\b|\d{5}\s\d{5})');
      for (final Text t in tester.widgetList<Text>(find.byType(Text))) {
        final String s = t.data ?? t.textSpan?.toPlainText() ?? '';
        expect(phone.hasMatch(s), isFalse, reason: '"$s" looks like a phone');
        for (final String name in <String>['Ramesh', 'Suresh', 'Imran']) {
          expect(s.contains(name), isFalse);
        }
      }
      expect(find.text('₹40'), findsNWidgets(2));
    });

    testWidgets('a related-role row says what it is related to',
        (WidgetTester tester) async {
      await pumpFind(tester);

      await runQuery(tester, _turnerQuery);

      // Row 2 is tier 2 under a CNC Turner search.
      expect(find.text('Related to CNC Turner'), findsOneWidget);
    });
  });

  group('the count badge — three numbers, from the same response', () {
    testWidgets('unfiltered: "N candidates", no strict note',
        (WidgetTester tester) async {
      api.onSearch = (_) async => _page(<CandidateSearchRow>[_turner]);
      await pumpFind(tester);

      expect(badgeText(tester), '62 candidates');
      expect(find.text(kStrictNote), findsNothing);
    });

    testWidgets('filtered: "M of N match · U not recorded" — never folded',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async => q.hasFilters
          ? _page(<CandidateSearchRow>[_turner, _vmc],
              matched: 14, unrecorded: 9, filtered: true)
          : _page(<CandidateSearchRow>[_turner], total: 1);
      await pumpFind(tester);
      expect(badgeText(tester), '1 candidate');

      await runQuery(tester, _turnerQuery);

      expect(badgeText(tester), '14 of 62 match · 9 not recorded');
      expect(find.text(kStrictNote), findsNothing);
      expect(find.text(kStrictNoteWithUnrecorded), findsNothing);
    });

    testWidgets('filtered with nothing unrecorded drops the third number',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async => _page(
            <CandidateSearchRow>[_turner],
            matched: 14,
            filtered: q.hasFilters,
          );
      await pumpFind(tester);

      await runQuery(tester, _turnerQuery);

      expect(badgeText(tester), '14 of 62 match');
    });

    testWidgets('strict says only the matches are shown — plus the unrecorded',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async => _page(
            <CandidateSearchRow>[_turner],
            matched: 14,
            unrecorded: q.city == null ? 0 : 3,
            filtered: q.hasFilters,
            strict: q.strict,
          );
      await pumpFind(tester);

      await runQuery(
          tester,
          const CandidateSearchQuery(
              skillIds: <String>['mskill_cnc_turner'], strict: true));
      expect(find.text(kStrictNote), findsOneWidget);

      await runQuery(
          tester,
          const CandidateSearchQuery(
              skillIds: <String>['mskill_cnc_turner'],
              city: 'Pune',
              strict: true));
      expect(badgeText(tester), '14 of 62 match · 3 not recorded');
      expect(find.text(kStrictNoteWithUnrecorded), findsOneWidget);
      expect(find.text('Only matches'), findsOneWidget,
          reason: 'the filter bar says strict is on');
    });
  });

  group('"Other candidates"', () {
    testWidgets('sits between the matches and the rest in reorder mode',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async => _page(
            <CandidateSearchRow>[_turner, _vmc],
            filtered: q.hasFilters,
            strict: q.strict,
          );
      await pumpFind(tester);
      expect(find.text('Other candidates'), findsNothing, reason: 'unfiltered');

      await runQuery(tester, _turnerQuery);

      expect(find.text('Other candidates'), findsOneWidget);
      final double line = tester.getTopLeft(find.text('Other candidates')).dy;
      // The masked handles are unique per card (the filter summary also reads
      // "CNC Turner").
      expect(tester.getTopLeft(find.text('Worker ••0003')).dy, lessThan(line),
          reason: 'the match leads');
      expect(tester.getTopLeft(find.text('Worker ••0007')).dy,
          greaterThan(line));

      await runQuery(
          tester,
          const CandidateSearchQuery(
              skillIds: <String>['mskill_cnc_turner'], strict: true));
      expect(find.text('Other candidates'), findsNothing, reason: 'strict');
    });
  });

  group('never an unexplained empty screen', () {
    testWidgets('strict-zero keeps the counts and offers the way back',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async =>
          q.strict ? _fixtureStrictZero : _fixturePage;
      await pumpFind(tester);
      const CandidateSearchQuery strict = CandidateSearchQuery(
        skillIds: <String>['mskill_cnc_turner'],
        city: 'Pune',
        strict: true,
      );

      await runQuery(tester, strict);

      expect(find.text('No candidates match every filter'), findsOneWidget);
      expect(badgeText(tester), '0 of 62 match');

      await tester.tap(find.byKey(const Key('candidate_drop_strict')));
      await tester.pumpAndSettle();

      final CandidateSearchQuery sent = api.searches.last;
      expect(sent.strict, isFalse);
      expect(sent.city, 'Pune');
      expect(sent.skillIds, <String>['mskill_cnc_turner']);
      expect(find.text('CNC Turner'), findsOneWidget);
    });

    testWidgets('an empty pool is calm — no counts shouting zero',
        (WidgetTester tester) async {
      api.onSearch = (_) async =>
          _page(const <CandidateSearchRow>[], total: 0, matched: 0);
      await pumpFind(tester);

      expect(find.text('No candidates to show yet'), findsOneWidget);
      expect(find.byKey(const Key('candidate_count_badge')), findsNothing);
      expect(find.textContaining('0 candidates'), findsNothing);
    });

    testWidgets('a 429 is a calm "too many requests" with a Retry',
        (WidgetTester tester) async {
      api.onSearch = (_) async => throw const PayerApiException(429);
      await pumpFind(tester);

      expect(find.text(kSearchCappedTitle), findsOneWidget);
      expect(find.text(kSearchCappedMessage), findsOneWidget);

      api.onSearch = (_) async => _page(<CandidateSearchRow>[_turner]);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(api.searches, hasLength(2));
      expect(find.text('CNC Turner'), findsOneWidget);
    });

    testWidgets('an outage names its cause with a Retry', (WidgetTester tester) async {
      api.onSearch = (_) async => throw const PayerApiException(503);
      await pumpFind(tester);

      expect(find.text('Something went wrong'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
    });
  });

  group('paging', () {
    testWidgets('"Load more" appends the next page, sent with the cursor',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async => q.cursor == null
          ? _page(<CandidateSearchRow>[_turner], next: 'cursor-1')
          : _page(<CandidateSearchRow>[_vmc]);
      await pumpFind(tester);

      await tester.ensureVisible(find.byKey(const Key('candidate_load_more')));
      await tester.tap(find.byKey(const Key('candidate_load_more')));
      await tester.pumpAndSettle();

      expect(api.searches.last.cursor, 'cursor-1');
      expect(find.text('CNC Turner'), findsOneWidget);
      // The list is lazy: scroll the appended card and the footer into view.
      await tester.scrollUntilVisible(
        find.text("That's everyone for now."),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('VMC Operator'), findsOneWidget);
      expect(find.text("That's everyone for now."), findsOneWidget);
    });

    testWidgets('a refused cursor restarts from the first page, calmly',
        (WidgetTester tester) async {
      api.onSearch = (CandidateSearchQuery q) async {
        if (q.cursor != null) throw const PayerApiException(400);
        return _page(<CandidateSearchRow>[_turner], next: 'stale');
      };
      await pumpFind(tester);

      await tester.ensureVisible(find.byKey(const Key('candidate_load_more')));
      await tester.tap(find.byKey(const Key('candidate_load_more')));
      await tester.pumpAndSettle();

      expect(find.text(kCursorRefusedMessage), findsOneWidget);
      expect(find.text('Retry'), findsNothing,
          reason: 'retrying would resend the refused cursor');
      expect(api.searches.last.cursor, isNull);
      expect(find.text('CNC Turner'), findsOneWidget);
    });
  });

  group('unlock → reveal: the applicant card\'s flow, with no job', () {
    testWidgets('same confirm, a job-less spend, the relay reveal',
        (WidgetTester tester) async {
      await pumpFind(tester);

      await tester.tap(find.text('₹40').first);
      await tester.pumpAndSettle();

      expect(find.text('Unlock this candidate?'), findsOneWidget);
      expect(find.textContaining('Worker ••0003', findRichText: true),
          findsWidgets);
      expect(find.textContaining('1 credit (₹40)', findRichText: true),
          findsOneWidget);

      await tester.tap(find.text('Unlock for ₹40'));
      await tester.pumpAndSettle();

      expect(api.unlockCalls.single.workerId, _turner.workerId);
      expect(api.unlockCalls.single.jobId, isNull);
      final RevealArgs args = revealed.single;
      expect(args.isReal, isTrue);
      expect(args.applicant, isNull);
      expect(args.workerId, _turner.workerId);
      expect(args.unlockId, 'unl-search-1');
      expect(args.jobId, isNull, reason: 'the masked résumé goes out posting-less');
      expect(args.title, 'Worker ••0003');
      expect(args.facets, <String>['CNC Turner', '4 yrs experience', 'Pune']);
      // The card now offers the reveal, not a second spend.
      expect(find.text('View'), findsOneWidget);
      expect(find.text('₹40'), findsOneWidget);
    });

    testWidgets('cancel spends nothing', (WidgetTester tester) async {
      await pumpFind(tester);

      await tester.tap(find.text('₹40').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(api.unlockCalls, isEmpty);
      expect(revealed, isEmpty);
    });

    testWidgets('a live grant from the unlock history opens on View',
        (WidgetTester tester) async {
      api.history = <PayerUnlock>[
        PayerUnlock(
          unlockId: 'held-1',
          workerId: _turner.workerId,
          status: 'granted',
          expiresAt: DateTime.now()
              .toUtc()
              .add(const Duration(days: 7))
              .toIso8601String(),
        ),
      ];
      await pumpFind(tester);

      expect(find.text('View'), findsOneWidget);
      await tester.tap(find.text('View'));
      await tester.pumpAndSettle();

      expect(api.unlockCalls, isEmpty, reason: 'no second credit for a held grant');
      expect(revealed.single.unlockId, 'held-1');
    });
  });

  group('the filter sheet', () {
    testWidgets('sends the picked role, bucket and strict; resets the cursor',
        (WidgetTester tester) async {
      await pumpFind(tester);

      await tester.tap(find.byKey(const Key('candidate_filters_open')));
      await tester.pumpAndSettle();
      expect(find.text('Filter candidates'), findsOneWidget);

      // Role — the server's options, one at most.
      await tester.tap(find.descendant(
        of: find.byKey(const Key('filter_role')),
        matching: find.byType(DropdownButtonFormField<String>),
      ));
      await tester.pumpAndSettle();
      await tester.tap(find.text('CNC Turner').last);
      await tester.pumpAndSettle();
      // Years in role.
      await tester.tap(find.byKey(const Key('filter_experience:1_3')));
      await tester.pumpAndSettle();
      // Only show matches.
      await tester.ensureVisible(find.byKey(const Key('filter_strict')));
      await tester.tap(find.byKey(const Key('filter_strict')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('filters_apply')));
      await tester.pumpAndSettle();

      final CandidateSearchQuery sent = api.searches.last;
      expect(sent.toJson(), <String, dynamic>{
        'skill_ids': <String>['mskill_cnc_turner'],
        'experience': '1_3',
        'strict': true,
      });
      expect(find.text('Filters · 2'), findsOneWidget);
      expect(find.text('CNC Turner · 1–3 years in role'), findsOneWidget);
    });

    testWidgets('"Only show matches" is off and inert until a filter is picked',
        (WidgetTester tester) async {
      await pumpFind(tester);

      await tester.tap(find.byKey(const Key('candidate_filters_open')));
      await tester.pumpAndSettle();

      final Switch strict =
          tester.widget<Switch>(find.byKey(const Key('filter_strict')));
      expect(strict.value, isFalse);
      expect(strict.onChanged, isNull);
    });

    testWidgets('"Clear" drops every filter back to the unfiltered page',
        (WidgetTester tester) async {
      await pumpFind(tester);
      await runQuery(tester, _turnerQuery);

      await tester.tap(find.byKey(const Key('candidate_filters_clear')));
      await tester.pumpAndSettle();

      expect(api.searches.last.toJson(), <String, dynamic>{});
      expect(find.text('Filters'), findsOneWidget);
    });
  });
}

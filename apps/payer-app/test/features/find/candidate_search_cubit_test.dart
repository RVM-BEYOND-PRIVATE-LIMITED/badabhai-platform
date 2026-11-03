import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/error/payer_failure.dart';
import 'package:payer_app/features/find/presentation/cubit/candidate_search_cubit.dart';

/// [CandidateSearchCubit] — Find's All-candidates view. Locks the seams that
/// would rot silently: the cursor resets on a filter change, "Load more"
/// appends, a STALE response never overwrites a newer query, strict-zero keeps
/// its counts, a 429 / refused cursor / outage each land in their own state,
/// and the unlock is the 1-credit, job-less spend the applicant card makes.
class _ScriptedApi extends MockPayerApiClient {
  final List<CandidateSearchQuery> searches = <CandidateSearchQuery>[];

  /// Answers each search; defaults to one page of [_rowA] + [_rowB].
  Future<CandidateSearchPage> Function(CandidateSearchQuery q) onSearch =
      (CandidateSearchQuery q) async => _page(<CandidateSearchRow>[_rowA, _rowB]);

  Object? filtersError;
  int filterLoads = 0;
  List<PayerUnlock> history = const <PayerUnlock>[];
  Object? historyError;

  UnlockResult unlockResult = const UnlockResult.granted(unlockId: 'unl-1');
  Object? unlockError;
  Completer<UnlockResult>? unlockGate;
  final List<({String workerId, String? jobId})> unlockCalls =
      <({String workerId, String? jobId})>[];

  @override
  Future<CandidateSearchPage> searchCandidates(CandidateSearchQuery query) {
    searches.add(query);
    return onSearch(query);
  }

  @override
  Future<CandidateFilters> fetchCandidateFilters() async {
    filterLoads++;
    if (filtersError != null) throw filtersError!;
    return _filters;
  }

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() async {
    if (historyError != null) throw historyError!;
    return history;
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async {
    unlockCalls.add((workerId: workerId, jobId: jobId));
    if (unlockGate != null) return unlockGate!.future;
    if (unlockError != null) throw unlockError!;
    return unlockResult;
  }
}

const String _workerA = 'face2000-0000-4000-8000-00000000000a';
const String _workerB = 'face2000-0000-4000-8000-00000000000b';
const String _workerC = 'face2000-0000-4000-8000-00000000000c';

const LabelledId _turner = LabelledId(id: 'mskill_cnc_turner', label: 'CNC Turner');
const LabelledId _im = LabelledId(
  id: 'ind_industrial_manufacturing',
  label: 'Industrial Manufacturing',
);

CandidateSearchRow _row(String workerId, {bool matches = true}) =>
    CandidateSearchRow(
      workerId: workerId,
      matchesFilters: matches,
      matchTier: null,
      role: _turner,
      otherRoles: const <LabelledId>[],
      skillMonths: 48,
      industry: _im,
      industryMonths: 54,
      city: 'Pune',
      tradeLevels: const <CandidateTradeLevel>[],
    );

final CandidateSearchRow _rowA = _row(_workerA);
final CandidateSearchRow _rowB = _row(_workerB, matches: false);
final CandidateSearchRow _rowC = _row(_workerC, matches: false);

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

const CandidateFilters _filters = CandidateFilters(
  roles: <CandidateRoleOption>[
    CandidateRoleOption(
      id: 'mskill_cnc_turner',
      label: 'CNC Turner',
      industryId: 'ind_industrial_manufacturing',
    ),
  ],
  industries: <LabelledId>[_im],
  experienceBuckets: <LabelledId>[LabelledId(id: '1_3', label: '1–3 years')],
  cities: <String>['Pune'],
  maxRoles: 5,
);

const CandidateSearchQuery _turnerQuery =
    CandidateSearchQuery(skillIds: <String>['mskill_cnc_turner']);

final DateTime _now = DateTime.utc(2026, 11, 3, 12);

void main() {
  late _ScriptedApi api;
  late CandidateSearchCubit cubit;

  setUp(() {
    api = _ScriptedApi();
    cubit = CandidateSearchCubit(api, clock: () => _now);
  });

  tearDown(() => cubit.close());

  group('load', () {
    test('loads the filters and the UNFILTERED first page together', () async {
      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(api.searches.single, const CandidateSearchQuery(),
          reason: 'the first page is the unfiltered {} body, no cursor');
      expect(cubit.state.filters, _filters);
      expect(cubit.state.rows, <CandidateSearchRow>[_rowA, _rowB]);
      // Counts come from the page itself — the SAME response as the rows.
      expect(cubit.state.total, 62);
      expect(cubit.state.page, isNotNull);
    });

    test('an empty POOL (total 0) is the empty state, not ready', () async {
      api.onSearch = (_) async => _page(const <CandidateSearchRow>[],
          total: 0, matched: 0);

      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.empty);
    });

    test('a failed filter read never blocks the list; reloadFilters recovers',
        () async {
      api.filtersError = const PayerApiException(503);

      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.filters, isNull);
      expect(cubit.state.filtersFailed, isTrue);

      api.filtersError = null;
      await cubit.reloadFilters();

      expect(cubit.state.filters, _filters);
      expect(cubit.state.filtersFailed, isFalse);
    });

    test('rows the payer holds a LIVE grant for start unlocked', () async {
      api.history = const <PayerUnlock>[
        PayerUnlock(
          unlockId: 'live',
          workerId: _workerA,
          status: 'revealed',
          expiresAt: '2026-11-10T00:00:00.000Z',
        ),
        PayerUnlock(
          unlockId: 'old',
          workerId: _workerB,
          status: 'expired',
          expiresAt: '2026-10-01T00:00:00.000Z',
        ),
        PayerUnlock(
          unlockId: 'lapsed',
          workerId: _workerC,
          status: 'granted',
          expiresAt: '2026-11-02T00:00:00.000Z',
        ),
      ];

      await cubit.load();

      expect(cubit.state.unlockIdFor(_workerA), 'live');
      expect(cubit.state.unlockIdFor(_workerB), isNull,
          reason: 'an expired grant must cost a fresh unlock');
      expect(cubit.state.unlockIdFor(_workerC), isNull,
          reason: 'a live status past its window is not live');
    });

    test('a failed unlock-history read is silent — rows simply start locked',
        () async {
      api.historyError = const PayerApiException(500);

      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.unlocks, isEmpty);
    });
  });

  group('filters change → cursor resets, rows replaced', () {
    test('a new query drops the cursor and REPLACES the loaded pages', () async {
      api.onSearch = (CandidateSearchQuery q) async => q.cursor == null &&
              q.skillIds.isEmpty
          ? _page(<CandidateSearchRow>[_rowA], next: 'cursor-1')
          : q.cursor == 'cursor-1'
              ? _page(<CandidateSearchRow>[_rowB], next: 'cursor-2')
              : _page(<CandidateSearchRow>[_rowC], filtered: true);
      await cubit.load();
      await cubit.loadMore();
      expect(cubit.state.rows.length, 2);

      await cubit.applyQuery(_turnerQuery);

      expect(api.searches.last, _turnerQuery,
          reason: 'no cursor survives a filter change');
      expect(api.searches.last.cursor, isNull);
      expect(cubit.state.query, _turnerQuery);
      expect(cubit.state.rows, <CandidateSearchRow>[_rowC]);
      expect(cubit.state.nextCursor, isNull);
    });

    test('re-applying the query already on screen spends no request', () async {
      await cubit.load();
      await cubit.applyQuery(_turnerQuery);
      final int before = api.searches.length;

      await cubit.applyQuery(_turnerQuery);

      expect(api.searches.length, before);
    });

    test('a query with no filter drops "only show matches" too', () async {
      await cubit.load();
      await cubit.applyQuery(_turnerQuery);

      await cubit.applyQuery(const CandidateSearchQuery(strict: true));

      expect(cubit.state.query.strict, isFalse);
      expect(api.searches.last.toJson(), <String, dynamic>{},
          reason: 'strict alone is the unfiltered page — sent as {}');

      // …and strict alone on the unfiltered page already on screen is a no-op.
      final int before = api.searches.length;
      await cubit.applyQuery(const CandidateSearchQuery(strict: true));
      expect(api.searches.length, before);
    });
  });

  group('loadMore', () {
    test('appends the next page, sent with the cursor; counts follow it',
        () async {
      api.onSearch = (CandidateSearchQuery q) async => q.cursor == null
          ? _page(<CandidateSearchRow>[_rowA], next: 'cursor-1')
          : _page(<CandidateSearchRow>[_rowB, _rowA], total: 63);
      await cubit.load();

      await cubit.loadMore();

      expect(api.searches.last.cursor, 'cursor-1');
      expect(api.searches.last.skillIds, isEmpty,
          reason: 'the filters ride along with the cursor');
      expect(cubit.state.rows, <CandidateSearchRow>[_rowA, _rowB],
          reason: 'appended in order, a repeated worker kept once');
      expect(cubit.state.total, 63);
      expect(cubit.state.nextCursor, isNull);
      expect(cubit.state.loadingMore, isFalse);
    });

    test('a no-op on the last page, and while a page is already loading',
        () async {
      final Completer<CandidateSearchPage> second = Completer<CandidateSearchPage>();
      api.onSearch = (CandidateSearchQuery q) => q.cursor == null
          ? Future<CandidateSearchPage>.value(
              _page(<CandidateSearchRow>[_rowA], next: 'cursor-1'))
          : second.future;
      await cubit.load();

      final Future<void> first = cubit.loadMore();
      await cubit.loadMore(); // ignored — one page in flight
      expect(api.searches.length, 2);

      second.complete(_page(<CandidateSearchRow>[_rowB]));
      await first;
      await cubit.loadMore(); // ignored — no cursor left

      expect(api.searches.length, 2);
    });

    test('a 400 on a cursor = a refused cursor: calm restart, never Retry',
        () async {
      api.onSearch = (CandidateSearchQuery q) async {
        if (q.cursor != null) throw const PayerApiException(400);
        return _page(<CandidateSearchRow>[_rowA], next: 'cursor-x');
      };
      await cubit.load();
      await cubit.applyQuery(_turnerQuery);

      await cubit.loadMore();

      expect(api.searches.last, _turnerQuery,
          reason: 'restarted from the FIRST page, filters kept');
      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.notice, CandidateSearchNotice.cursorRefused);
      expect(cubit.state.loadMoreFailure, isNull);
      expect(cubit.state.rows, <CandidateSearchRow>[_rowA]);

      // The notice is for that restart only — the next query clears it.
      await cubit.clearFilters();
      expect(cubit.state.notice, isNull);
    });

    test('any other failure keeps the rows and offers an inline retry',
        () async {
      int calls = 0;
      api.onSearch = (CandidateSearchQuery q) async {
        if (q.cursor != null && calls++ == 0) throw const PayerApiException(500);
        return q.cursor == null
            ? _page(<CandidateSearchRow>[_rowA], next: 'cursor-1')
            : _page(<CandidateSearchRow>[_rowB]);
      };
      await cubit.load();

      await cubit.loadMore();

      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.rows, <CandidateSearchRow>[_rowA]);
      expect(cubit.state.loadMoreFailure?.kind, PayerFailureKind.server);

      await cubit.loadMore();

      expect(cubit.state.rows, <CandidateSearchRow>[_rowA, _rowB]);
      expect(cubit.state.loadMoreFailure, isNull);
    });
  });

  group('stale responses are ignored', () {
    test('a slow older query never overwrites the newer one', () async {
      await cubit.load();
      final Completer<CandidateSearchPage> slow = Completer<CandidateSearchPage>();
      final Completer<CandidateSearchPage> fast = Completer<CandidateSearchPage>();
      api.onSearch = (CandidateSearchQuery q) =>
          q.city == 'Pune' ? slow.future : fast.future;

      final Future<void> older =
          cubit.applyQuery(const CandidateSearchQuery(city: 'Pune'));
      final Future<void> newer = cubit.applyQuery(_turnerQuery);
      fast.complete(_page(<CandidateSearchRow>[_rowC], filtered: true));
      await newer;
      slow.complete(_page(<CandidateSearchRow>[_rowA, _rowB], filtered: true));
      await older;

      expect(cubit.state.query, _turnerQuery);
      expect(cubit.state.rows, <CandidateSearchRow>[_rowC],
          reason: 'the late Pune page lost the race and is dropped');
    });

    test('a "Load more" overtaken by a filter change is dropped', () async {
      final Completer<CandidateSearchPage> more = Completer<CandidateSearchPage>();
      api.onSearch = (CandidateSearchQuery q) {
        if (q.cursor != null) return more.future;
        return Future<CandidateSearchPage>.value(q.skillIds.isEmpty
            ? _page(<CandidateSearchRow>[_rowA], next: 'cursor-1')
            : _page(<CandidateSearchRow>[_rowC], filtered: true));
      };
      await cubit.load();

      final Future<void> loading = cubit.loadMore();
      await cubit.applyQuery(_turnerQuery);
      more.complete(_page(<CandidateSearchRow>[_rowB]));
      await loading;

      expect(cubit.state.rows, <CandidateSearchRow>[_rowC]);
      expect(cubit.state.loadingMore, isFalse);
    });
  });

  group('strict', () {
    test('strict that matches nobody keeps its counts; dropStrict is the way back',
        () async {
      api.onSearch = (CandidateSearchQuery q) async => q.strict
          ? _page(const <CandidateSearchRow>[],
              total: 62, matched: 0, filtered: true, strict: true)
          : _page(<CandidateSearchRow>[_rowB], matched: 0, filtered: true);
      await cubit.load();
      const CandidateSearchQuery strict = CandidateSearchQuery(
        skillIds: <String>['mskill_cnc_turner'],
        city: 'Pune',
        strict: true,
      );

      await cubit.applyQuery(strict);

      expect(cubit.state.status, CandidateSearchStatus.ready,
          reason: 'not the empty-POOL state: 62 people are on the portal');
      expect(cubit.state.rows, isEmpty);
      expect(cubit.state.total, 62);
      expect(cubit.state.matched, 0);
      expect(cubit.state.strict, isTrue);

      await cubit.dropStrict();

      final CandidateSearchQuery sent = api.searches.last;
      expect(sent.strict, isFalse);
      expect(sent.skillIds, <String>['mskill_cnc_turner']);
      expect(sent.city, 'Pune', reason: 'only strict is dropped — filters kept');
      expect(cubit.state.rows, <CandidateSearchRow>[_rowB]);
    });

    test('"Other candidates" sits at the first non-match, in reorder mode only',
        () async {
      api.onSearch = (CandidateSearchQuery q) async => _page(
            <CandidateSearchRow>[_rowA, _rowB, _rowC],
            filtered: q.hasFilters,
            strict: q.strict,
          );
      await cubit.load();
      expect(cubit.state.otherCandidatesIndex, -1, reason: 'unfiltered');

      await cubit.applyQuery(_turnerQuery);
      expect(cubit.state.otherCandidatesIndex, 1);

      await cubit.applyQuery(const CandidateSearchQuery(
        skillIds: <String>['mskill_cnc_turner'],
        strict: true,
      ));
      expect(cubit.state.otherCandidatesIndex, -1, reason: 'strict');
    });
  });

  group('errors', () {
    test('a first-page outage is the error state; retry re-sends the query',
        () async {
      api.onSearch = (_) async => throw const PayerApiException(503);
      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.error);
      expect(cubit.state.failure?.kind, PayerFailureKind.server);
      expect(cubit.state.rateLimited, isFalse);

      api.onSearch = (_) async => _page(<CandidateSearchRow>[_rowA]);
      await cubit.retry();

      expect(api.searches.length, 2);
      expect(api.searches.last, const CandidateSearchQuery());
      expect(cubit.state.status, CandidateSearchStatus.ready);
    });

    test('a 429 is the hourly cap — its own state, never a fake empty pool',
        () async {
      api.onSearch = (_) async => throw const PayerApiException(429);

      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.error);
      expect(cubit.state.status, isNot(CandidateSearchStatus.empty));
      expect(cubit.state.rateLimited, isTrue);
    });
  });

  group('unlock — the same 1-credit spend, with no job', () {
    test('spends against the opaque worker id with job_id null', () async {
      await cubit.load();

      final UnlockResult result = await cubit.unlock(_rowA);

      expect(result.granted, isTrue);
      expect(api.unlockCalls.single.workerId, _workerA);
      expect(api.unlockCalls.single.jobId, isNull);
      expect(cubit.state.unlockIdFor(_workerA), 'unl-1');
      expect(cubit.state.unlockIdFor(_workerB), isNull);
      expect(cubit.state.isUnlocking(_workerA), isFalse);
    });

    test('the neutral DENY is not success — nothing is marked unlocked',
        () async {
      api.unlockResult = const UnlockResult.unavailable();
      await cubit.load();

      final UnlockResult result = await cubit.unlock(_rowA);

      expect(result.granted, isFalse);
      expect(cubit.state.unlocks, isEmpty);
    });

    test('an OUTAGE rethrows and leaves the list on screen', () async {
      api.unlockError = const PayerApiException(503);
      await cubit.load();

      await expectLater(
          cubit.unlock(_rowA), throwsA(isA<PayerApiException>()));

      expect(cubit.state.status, CandidateSearchStatus.ready,
          reason: 'one failed unlock must not blank the page');
      expect(cubit.state.rows, <CandidateSearchRow>[_rowA, _rowB]);
      expect(cubit.state.unlocks, isEmpty);
      expect(cubit.state.isUnlocking(_workerA), isFalse);
    });

    test('single-flight: a second tap while one is in flight never spends twice',
        () async {
      await cubit.load();
      api.unlockGate = Completer<UnlockResult>();

      final Future<UnlockResult> first = cubit.unlock(_rowA);
      final Future<UnlockResult> second = cubit.unlock(_rowA);
      expect(cubit.state.isUnlocking(_workerA), isTrue);
      api.unlockGate!.complete(const UnlockResult.granted(unlockId: 'unl-7'));

      expect((await first).unlockId, 'unl-7');
      expect((await second).unlockId, 'unl-7');
      expect(api.unlockCalls, hasLength(1));
    });
  });

  test('a cubit closed mid-request never emits (no StateError)', () async {
    final Completer<CandidateSearchPage> page = Completer<CandidateSearchPage>();
    api.onSearch = (_) => page.future;
    final Future<void> loading = cubit.load();

    await cubit.close();
    page.complete(_page(<CandidateSearchRow>[_rowA]));

    await expectLater(loading, completes);
  });
}

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/candidate_search_models.dart';
import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';

/// Drives Find's ALL-CANDIDATES view (ADR-0040, phase E2; owner rulings
/// 2026-11-03): every worker in the eligible pool, masked, ordered by the
/// payer's filters. Company and agency sessions alike — nothing here depends
/// on owned postings.
///
/// One cubit per Find mount. It loads three things at once: the filter options,
/// the first page, and the payer's own unlock history (so a card already paid
/// for opens on "View"). Only the page decides the screen; the other two fail
/// soft.
///
/// PAGING. A filter change resets the cursor and REPLACES the rows (a cursor is
/// a position in the order of the filters that minted it). "Load more" appends.
/// Every list-replacing request bumps [_generation]; a response carrying an
/// older generation lost a race to a newer query and is dropped — so a slow
/// first page can never overwrite the filters the payer picked after it.
///
/// KEPT ROWS (#2592). A filter change keeps the current rows on screen —
/// dimmed, under a thin progress bar ([CandidateSearchReload.filters]) — until
/// the new first page replaces them; [refresh] re-reads quietly with no dim
/// at all. While either is in flight there is no "Load more": the cursor on
/// screen belongs to the rows being replaced.
///
/// ERRORS. A failed first page is the error state (with [PayerFailure]'s
/// honest copy; a 429 is the payer's hourly search cap). A failed "Load more"
/// keeps the rows and offers an inline retry — EXCEPT a 400, which on a cursor
/// request means the server refused the cursor: that restarts from the first
/// page with a calm notice, because retrying would resend the same cursor.
class CandidateSearchCubit extends Cubit<CandidateSearchState> {
  CandidateSearchCubit(this._api, {DateTime Function()? clock})
      : _clock = clock ?? DateTime.now,
        super(const CandidateSearchState());

  final PayerApiClient _api;

  /// Reads "now" for the unlock-history expiry check (injected in tests).
  final DateTime Function() _clock;

  int _generation = 0;

  final Map<String, Future<UnlockResult>> _unlocksInFlight =
      <String, Future<UnlockResult>>{};

  /// Filters + the first page + the unlock history, concurrently. [query] is
  /// the search to start on — #2671 a job's "Find matching workers" prefills the
  /// trade, the listed city and strict; an ordinary visit starts unfiltered.
  Future<void> load({CandidateSearchQuery? query}) {
    final CandidateSearchQuery start = query ?? state.query;
    return Future.wait(<Future<void>>[
      _loadFilters(),
      _loadUnlockHistory(),
      _replace(start.firstPage()),
    ]);
  }

  /// The filter sheet's result. The cursor resets and the rows are replaced. A
  /// query with no filter drops [CandidateSearchQuery.strict] too — "only show
  /// matches" means nothing when nothing is filtered. Re-applying the query
  /// already on screen is a no-op (it would spend a unit of the hourly cap to
  /// redraw the same page).
  Future<void> applyQuery(CandidateSearchQuery query) async {
    final CandidateSearchQuery next =
        query.hasFilters ? query.firstPage() : query.firstPage(strict: false);
    if (next == state.query && state.status == CandidateSearchStatus.ready) {
      return;
    }
    await _replace(next, keepRows: true);
  }

  /// #2592 — pull-to-refresh and a return to the tab: the current filters
  /// from the first page, plus the unlock history, with the rows on screen
  /// staying put (no skeleton, no dim) until the fresh page lands. A failure
  /// keeps the rows and is returned for the caller to say why; null on
  /// success. With nothing on screen it is the normal path ([retry]).
  ///
  /// [keepPages] (a tab return): once the payer has paged past the first page,
  /// a first-page reload would throw their place away, so only the unlock
  /// history is re-read. Pull-to-refresh — always at the top — reloads.
  Future<PayerFailure?> refresh({bool keepPages = false}) async {
    if (isClosed) return null;
    switch (state.status) {
      case CandidateSearchStatus.initial:
      case CandidateSearchStatus.loading:
        return null; // the first page is already on its way
      case CandidateSearchStatus.error:
        await retry();
        return null;
      case CandidateSearchStatus.ready:
      case CandidateSearchStatus.empty:
        break;
    }
    // A filter change is already reading these filters' first page.
    if (state.reload != CandidateSearchReload.none) return null;
    final Future<void> unlocks = _loadUnlockHistory();
    if (keepPages && state.pagedBeyondFirst) {
      await unlocks;
      return null;
    }
    final int generation = ++_generation;
    // A failed "Load more" stays recorded until a fresh first page replaces
    // the rows: a refresh that fails too keeps the Retry, so automatic
    // load-more never re-asks the failed page by itself.
    emit(state.copyWith(
      reload: CandidateSearchReload.quiet,
      loadingMore: false,
    ));
    try {
      final CandidateSearchPage page =
          await _api.searchCandidates(state.query.firstPage());
      if (isClosed || generation != _generation) return null;
      emit(state.copyWith(
        status: page.total == 0
            ? CandidateSearchStatus.empty
            : CandidateSearchStatus.ready,
        page: page,
        rows: page.candidates,
        reload: CandidateSearchReload.none,
        loadMoreFailure: null,
        notice: null,
        pagingStalled: false,
      ));
      await unlocks;
      return null;
    } catch (e) {
      if (isClosed || generation != _generation) return null;
      emit(state.copyWith(reload: CandidateSearchReload.none));
      await unlocks;
      return PayerFailure.from(e);
    }
  }

  /// The strict-zero way back: the same filters, every candidate, matches first.
  Future<void> dropStrict() => applyQuery(state.query.firstPage(strict: false));

  Future<void> clearFilters() => applyQuery(const CandidateSearchQuery());

  /// The error state's Retry: the current filters from the first page (and
  /// the filter options, if those failed too).
  Future<void> retry() => Future.wait(<Future<void>>[
        if (state.filters == null) _loadFilters(),
        _replace(state.query.firstPage()),
      ]);

  /// The filter options alone (the sheet's own retry).
  Future<void> reloadFilters() => _loadFilters();

  /// Appends the next page. A no-op unless a page is on screen, there is a
  /// cursor, and no other page is already loading.
  Future<void> loadMore() async {
    final String? cursor = state.nextCursor;
    if (isClosed || !state.canLoadMore || cursor == null) return;
    final int generation = _generation;
    final CandidateSearchQuery query = state.query;
    emit(state.copyWith(loadingMore: true, loadMoreFailure: null));
    try {
      final CandidateSearchPage page =
          await _api.searchCandidates(query.after(cursor));
      if (isClosed || generation != _generation) return;
      // Keyset pages cannot overlap, but a worker whose sort keys moved between
      // two reads could; one row per worker keeps the unlock state unambiguous.
      final Set<String> seen =
          state.rows.map((CandidateSearchRow r) => r.workerId).toSet();
      final List<CandidateSearchRow> added = page.candidates
          .where((CandidateSearchRow r) => seen.add(r.workerId))
          .toList(growable: false);
      emit(state.copyWith(
        page: page,
        rows: List<CandidateSearchRow>.unmodifiable(
          <CandidateSearchRow>[...state.rows, ...added],
        ),
        loadingMore: false,
        pagingStalled: added.isEmpty,
      ));
    } catch (e) {
      if (isClosed || generation != _generation) return;
      if (e is PayerApiException && e.statusCode == 400) {
        await _replace(query, notice: CandidateSearchNotice.cursorRefused);
        return;
      }
      emit(state.copyWith(
        loadingMore: false,
        loadMoreFailure: PayerFailure.from(e),
      ));
    }
  }

  /// Spends 1 credit on [row] (`POST /payer/unlocks` with NO job — a search row
  /// has no posting context). Returns the typed result for the tap handler:
  /// reveal on a grant, the neutral toast on a deny (never a fabricated reason).
  ///
  /// An OUTAGE rethrows so the handler can offer a retry (#348) — but unlike the
  /// per-job feed it does NOT swap the list for an error screen: one failed
  /// unlock must not cost the payer the page they were reading. Single-flight
  /// per worker: a second call while one is in flight joins it, never a second
  /// spend.
  ///
  /// A SAMPLE row (R74) is refused here with the server's own neutral reply and
  /// no request — the card offers no unlock, and this keeps any other caller
  /// from sending one. The server refuses it too; this is not the gate.
  Future<UnlockResult> unlock(CandidateSearchRow row) {
    if (row.isSample) {
      return Future<UnlockResult>.value(const UnlockResult.unavailable());
    }
    final String workerId = row.workerId;
    // A BLOCK body on purpose: `=> remove(...)` would return the removed value
    // — this very future — and `whenComplete` would wait on itself forever.
    return _unlocksInFlight[workerId] ??= _unlock(workerId).whenComplete(() {
      _unlocksInFlight.remove(workerId);
    });
  }

  Future<UnlockResult> _unlock(String workerId) async {
    if (!isClosed) {
      emit(state.copyWith(unlocking: <String>{...state.unlocking, workerId}));
    }
    try {
      final UnlockResult result =
          await _api.unlock(workerId: workerId, jobId: null);
      if (!isClosed) {
        final String? unlockId = result.granted ? result.unlockId : null;
        final DateTime? until = unlockId == null || result.expiresAt == null
            ? null
            : DateTime.tryParse(result.expiresAt!);
        emit(state.copyWith(
          unlocking: state.unlocking.difference(<String>{workerId}),
          unlocks: unlockId == null
              ? null
              : <String, String>{...state.unlocks, workerId: unlockId},
          unlockExpiries: until == null
              ? null
              : <String, DateTime>{...state.unlockExpiries, workerId: until},
        ));
      }
      return result;
    } catch (_) {
      if (!isClosed) {
        emit(state.copyWith(
          unlocking: state.unlocking.difference(<String>{workerId}),
        ));
      }
      rethrow;
    }
  }

  /// Replaces the list with [query]'s first page. The counts are cleared with
  /// the rows: until the new page lands there is no response to read them from.
  ///
  /// [keepRows] (#2592 — a filter change): rows already on screen stay there,
  /// dimmed, with the counts of the response they came from, until the new
  /// page replaces both at once.
  Future<void> _replace(
    CandidateSearchQuery query, {
    CandidateSearchNotice? notice,
    bool keepRows = false,
  }) async {
    if (isClosed) return;
    final int generation = ++_generation;
    final bool keep = keepRows && state.status == CandidateSearchStatus.ready;
    emit(keep
        ? state.copyWith(
            query: query,
            // The kept rows (and the badge's counts) are still the previous
            // filters' — a second change in flight keeps the FIRST rows' query.
            rowsQuery: state.rowsQuery ?? state.query,
            reload: CandidateSearchReload.filters,
            loadingMore: false,
            loadMoreFailure: null,
            notice: notice,
            pagingStalled: false,
          )
        : state.copyWith(
            status: CandidateSearchStatus.loading,
            query: query,
            page: null,
            rows: const <CandidateSearchRow>[],
            loadingMore: false,
            failure: null,
            loadMoreFailure: null,
            notice: notice,
            reload: CandidateSearchReload.none,
            pagingStalled: false,
            rowsQuery: null,
          ));
    try {
      final CandidateSearchPage page = await _api.searchCandidates(query);
      if (isClosed || generation != _generation) return;
      emit(state.copyWith(
        status: page.total == 0
            ? CandidateSearchStatus.empty
            : CandidateSearchStatus.ready,
        page: page,
        rows: page.candidates,
        reload: CandidateSearchReload.none,
        rowsQuery: null,
      ));
    } catch (e) {
      if (isClosed || generation != _generation) return;
      emit(state.copyWith(
        status: CandidateSearchStatus.error,
        failure: PayerFailure.from(e),
        page: null,
        rows: const <CandidateSearchRow>[],
        reload: CandidateSearchReload.none,
        rowsQuery: null,
      ));
    }
  }

  Future<void> _loadFilters() async {
    try {
      final CandidateFilters filters = await _api.fetchCandidateFilters();
      if (isClosed) return;
      emit(state.copyWith(filters: filters, filtersFailed: false));
    } catch (_) {
      if (isClosed) return;
      emit(state.copyWith(filtersFailed: true));
    }
  }

  /// Marks the rows this payer already holds a LIVE grant for. Fails soft:
  /// without it the rows start locked, which is safe — the server answers a
  /// re-unlock of a live grant with that grant and no second debit (F-6).
  Future<void> _loadUnlockHistory() async {
    try {
      final List<PayerUnlock> history = await _api.fetchOwnUnlocks();
      if (isClosed) return;
      final DateTime now = _clock();
      final Map<String, String> live = <String, String>{
        for (final PayerUnlock u in history)
          if (u.workerId != null && u.isLiveAt(now)) u.workerId!: u.unlockId,
      };
      if (live.isEmpty) return;
      final Map<String, DateTime> windows = <String, DateTime>{
        for (final PayerUnlock u in history)
          if (u.workerId != null &&
              live.containsKey(u.workerId) &&
              u.expiresAt != null &&
              DateTime.tryParse(u.expiresAt!) != null)
            u.workerId!: DateTime.parse(u.expiresAt!),
      };
      // An in-session grant is newer than anything this read saw: it wins.
      emit(state.copyWith(
        unlocks: <String, String>{...live, ...state.unlocks},
        unlockExpiries: <String, DateTime>{...windows, ...state.unlockExpiries},
      ));
    } catch (_) {
      // Deliberately silent — see the doc comment.
    }
  }
}

enum CandidateSearchStatus { initial, loading, ready, error, empty }

/// #2592 — a first-page re-read in flight while the previous rows stay on
/// screen.
enum CandidateSearchReload {
  none,

  /// Pull-to-refresh / a return to the tab — the rows are not dimmed.
  quiet,

  /// A filter change — the rows on screen are the OLD filters' and are
  /// dimmed under a progress bar.
  filters,
}

/// A calm one-line note above the list — information, never an error.
enum CandidateSearchNotice {
  /// "Load more" sent a cursor the server refused; the list restarted from
  /// the first page.
  cursorRefused,
}

class CandidateSearchState extends Equatable {
  const CandidateSearchState({
    this.status = CandidateSearchStatus.initial,
    this.query = const CandidateSearchQuery(),
    this.filters,
    this.filtersFailed = false,
    this.page,
    this.rows = const <CandidateSearchRow>[],
    this.loadingMore = false,
    this.failure,
    this.loadMoreFailure,
    this.notice,
    this.unlocks = const <String, String>{},
    this.unlockExpiries = const <String, DateTime>{},
    this.unlocking = const <String>{},
    this.reload = CandidateSearchReload.none,
    this.pagingStalled = false,
    this.rowsQuery,
  });

  final CandidateSearchStatus status;

  /// The filters on screen (the cursor lives on [page], not here).
  final CandidateSearchQuery query;

  /// The filter options; null until loaded (or while failed).
  final CandidateFilters? filters;
  final bool filtersFailed;

  /// The LATEST page response — the one source of the counts and the cursor,
  /// so the badge always reads the same response the rows came from (ADR-0040
  /// Decision 3). Null while a new query is loading.
  final CandidateSearchPage? page;

  /// Every row loaded for [query] so far, in server order.
  final List<CandidateSearchRow> rows;

  final bool loadingMore;

  /// Why the first page failed (drives the error copy). Null otherwise.
  final PayerFailure? failure;

  /// Why the last "Load more" failed; the rows stay on screen.
  final PayerFailure? loadMoreFailure;

  final CandidateSearchNotice? notice;

  /// workerId → unlockId for every live grant this payer holds.
  final Map<String, String> unlocks;

  /// workerId → when that grant's window closes, when the server said. A card
  /// whose window has closed reads as LOCKED again (Unlock, not View) — the
  /// server re-grants an expired worker with a fresh window.
  final Map<String, DateTime> unlockExpiries;

  /// Workers with an unlock in flight (their button shows progress).
  final Set<String> unlocking;

  /// #2592 — whether the rows on screen are being replaced, and how.
  final CandidateSearchReload reload;

  /// #2592 — the last "Load more" added no new row (the page held only
  /// workers already listed). Automatic load-more stops there — firing again
  /// would ask for the same thing forever — and waits for a tap.
  final bool pagingStalled;

  /// #2592 — while a filter change is in flight ([switchingFilters]), the
  /// filters the rows on screen came from; null otherwise (they are
  /// [query]'s). Everything said ABOUT those rows — the "Related to" badge,
  /// the count's "not recorded" clause — reads it, so the badge keeps reading
  /// the same response the rows came from (ADR-0040 Decision 3); only the
  /// filter bar shows the pending [query].
  final CandidateSearchQuery? rowsQuery;

  /// The filters the rows on screen came from.
  CandidateSearchQuery get _shownQuery => rowsQuery ?? query;

  /// The rows on screen belong to the previous filters (dim them).
  bool get switchingFilters => reload == CandidateSearchReload.filters;

  /// More than the first page is on screen ("Load more" has appended).
  bool get pagedBeyondFirst =>
      page != null && rows.length > page!.candidates.length;

  int get total => page?.total ?? 0;
  int get matched => page?.matched ?? 0;
  int get unrecorded => page?.unrecorded ?? 0;
  bool get filtered => page?.filtered ?? false;
  bool get strict => page?.strict ?? false;

  /// A filter on a field that can be UNRECORDED is on (city, years in role,
  /// years in industry): the badge then always says the "not recorded" number.
  bool get unrecordableFilter =>
      _shownQuery.city != null ||
      _shownQuery.experience != null ||
      _shownQuery.industryExperience != null;
  String? get nextCursor => page?.nextCursor;

  /// The first page hit the payer's hourly search cap.
  bool get rateLimited => failure?.statusCode == 429;

  bool get canLoadMore =>
      status == CandidateSearchStatus.ready &&
      nextCursor != null &&
      !loadingMore &&
      reload == CandidateSearchReload.none;

  /// Where the "Other candidates" line goes: the first row that does not match,
  /// in reorder mode only (strict mode holds matches alone). -1 = no line.
  int get otherCandidatesIndex => filtered && !strict
      ? rows.indexWhere((CandidateSearchRow r) => !r.matchesFilters)
      : -1;

  /// The label of the picked role (the tier-2 "Related to …" badge), if any.
  String? get pickedRoleLabel => _shownQuery.skillIds.isEmpty
      ? null
      : filters?.roleLabel(_shownQuery.skillIds.first);

  /// The live grant's id, or null — including once its window has closed
  /// while this view stayed open ([now] defaults to the device clock).
  String? unlockIdFor(String workerId, [DateTime? now]) {
    final DateTime? until = unlockExpiries[workerId];
    if (until != null && !until.isAfter(now ?? DateTime.now())) return null;
    return unlocks[workerId];
  }

  bool isUnlocking(String workerId) => unlocking.contains(workerId);

  static const Object _keep = Object();

  /// Nullable fields take [_keep] by default, so passing `null` CLEARS them.
  CandidateSearchState copyWith({
    CandidateSearchStatus? status,
    CandidateSearchQuery? query,
    CandidateFilters? filters,
    bool? filtersFailed,
    Object? page = _keep,
    List<CandidateSearchRow>? rows,
    bool? loadingMore,
    Object? failure = _keep,
    Object? loadMoreFailure = _keep,
    Object? notice = _keep,
    Map<String, String>? unlocks,
    Map<String, DateTime>? unlockExpiries,
    Set<String>? unlocking,
    CandidateSearchReload? reload,
    bool? pagingStalled,
    Object? rowsQuery = _keep,
  }) {
    return CandidateSearchState(
      status: status ?? this.status,
      query: query ?? this.query,
      filters: filters ?? this.filters,
      filtersFailed: filtersFailed ?? this.filtersFailed,
      page: identical(page, _keep) ? this.page : page as CandidateSearchPage?,
      rows: rows ?? this.rows,
      loadingMore: loadingMore ?? this.loadingMore,
      failure:
          identical(failure, _keep) ? this.failure : failure as PayerFailure?,
      loadMoreFailure: identical(loadMoreFailure, _keep)
          ? this.loadMoreFailure
          : loadMoreFailure as PayerFailure?,
      notice: identical(notice, _keep)
          ? this.notice
          : notice as CandidateSearchNotice?,
      unlocks: unlocks ?? this.unlocks,
      unlockExpiries: unlockExpiries ?? this.unlockExpiries,
      unlocking: unlocking ?? this.unlocking,
      reload: reload ?? this.reload,
      pagingStalled: pagingStalled ?? this.pagingStalled,
      rowsQuery: identical(rowsQuery, _keep)
          ? this.rowsQuery
          : rowsQuery as CandidateSearchQuery?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        query,
        filters,
        filtersFailed,
        page,
        rows,
        loadingMore,
        failure,
        loadMoreFailure,
        notice,
        unlocks,
        unlockExpiries,
        unlocking,
        reload,
        pagingStalled,
        rowsQuery,
      ];
}

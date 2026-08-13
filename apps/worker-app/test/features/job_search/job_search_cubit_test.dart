import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/job_search/domain/job_search_item.dart';
import 'package:badabhai_worker_app/features/job_search/domain/job_search_repository.dart';
import 'package:badabhai_worker_app/features/job_search/presentation/cubit/job_search_cubit.dart';
import 'package:badabhai_worker_app/features/job_search/presentation/cubit/job_search_state.dart';

class MockJobSearchRepository extends Mock implements JobSearchRepository {}

JobSearchItem _item(String id) =>
    JobSearchItem(jobId: id, title: id, city: 'Kota', state: 'Rajasthan');

JobSearchPage _page(
  List<String> ids, {
  int page = 1,
  bool hasMore = false,
}) =>
    JobSearchPage(
      items: ids.map(_item).toList(),
      page: page,
      limit: 20,
      hasMore: hasMore,
    );

List<String> _ids(JobSearchState s) =>
    s.items.map((JobSearchItem i) => i.jobId).toList();

/// Broad stub matching every named arg — individual tests `verify` the exact
/// city/state to prove the location parse.
void _stub(MockJobSearchRepository repo, JobSearchPage result) {
  when(() => repo.searchJobs(
        q: any(named: 'q'),
        city: any(named: 'city'),
        state: any(named: 'state'),
        limit: any(named: 'limit'),
        page: any(named: 'page'),
      )).thenAnswer((_) async => result);
}

void main() {
  late MockJobSearchRepository repo;

  setUp(() {
    repo = MockJobSearchRepository();
  });

  group('search', () {
    test('results: a non-empty page -> loading then results', () async {
      _stub(repo, _page(<String>['a', 'b']));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      final Future<void> done = cubit.search(title: 'CNC', location: 'Kota');
      // The synchronous first emit is the loading state.
      expect(cubit.state.status, JobSearchStatus.loading);
      await done;

      expect(cubit.state.status, JobSearchStatus.results);
      expect(_ids(cubit.state), <String>['a', 'b']);
    });

    test('empty: an empty page -> empty', () async {
      _stub(repo, _page(<String>[]));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'welder', location: 'Kota');

      expect(cubit.state.status, JobSearchStatus.empty);
      expect(cubit.state.items, isEmpty);
    });

    test('error: a Failure -> error carrying the HONEST reason', () async {
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: any(named: 'page'),
          )).thenThrow(const NetworkFailure());
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota');

      expect(cubit.state.status, JobSearchStatus.error);
      expect(cubit.state.failure, isA<NetworkFailure>());
    });
  });

  group('location parsing', () {
    test('"Kota, Rajasthan" -> city=Kota, state=Rajasthan (split on first comma)',
        () async {
      _stub(repo, _page(<String>['a']));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota, Rajasthan');

      verify(() => repo.searchJobs(
            q: 'CNC',
            city: 'Kota',
            state: 'Rajasthan',
            limit: any(named: 'limit'),
            page: 1,
          )).called(1);
    });

    test('"Jaipur" (no comma) -> city=Jaipur, state omitted (null)', () async {
      _stub(repo, _page(<String>['a']));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Jaipur');

      verify(() => repo.searchJobs(
            q: 'CNC',
            city: 'Jaipur',
            state: null,
            limit: any(named: 'limit'),
            page: 1,
          )).called(1);
    });

    test('extra whitespace + only the FIRST comma splits the pair', () async {
      _stub(repo, _page(<String>['a']));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: '  welder ', location: '  Kota ,  Rajasthan ');

      verify(() => repo.searchJobs(
            q: 'welder',
            city: 'Kota',
            state: 'Rajasthan',
            limit: any(named: 'limit'),
            page: 1,
          )).called(1);
    });

    test('a blank title + blank location is still a valid (broad) query',
        () async {
      _stub(repo, _page(<String>['a']));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: '   ', location: '   ');

      verify(() => repo.searchJobs(
            q: null,
            city: null,
            state: null,
            limit: any(named: 'limit'),
            page: 1,
          )).called(1);
    });
  });

  group('loadMore', () {
    test('appends the next page and STOPS at has_more=false', () async {
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 1,
          )).thenAnswer((_) async => _page(<String>['a', 'b'], page: 1, hasMore: true));
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).thenAnswer((_) async => _page(<String>['c'], page: 2, hasMore: false));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota, Rajasthan');
      expect(_ids(cubit.state), <String>['a', 'b']);
      expect(cubit.state.hasMore, isTrue);

      await cubit.loadMore();
      expect(_ids(cubit.state), <String>['a', 'b', 'c']); // appended, not replaced
      expect(cubit.state.page, 2);
      expect(cubit.state.hasMore, isFalse);
      expect(cubit.state.status, JobSearchStatus.results);

      // hasMore is now false — a further loadMore is a no-op (page 2 fetched once).
      await cubit.loadMore();
      verify(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).called(1);
    });

    test('loadMore re-issues the SAME parsed city/state on the next page',
        () async {
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 1,
          )).thenAnswer((_) async => _page(<String>['a'], page: 1, hasMore: true));
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).thenAnswer((_) async => _page(<String>['b'], page: 2, hasMore: false));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota, Rajasthan');
      await cubit.loadMore();

      verify(() => repo.searchJobs(
            q: 'CNC',
            city: 'Kota',
            state: 'Rajasthan',
            limit: any(named: 'limit'),
            page: 2,
          )).called(1);
    });

    test('loadMore is a no-op before any search (nothing to page)', () async {
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.loadMore();

      expect(cubit.state.status, JobSearchStatus.idle);
      verifyNever(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: any(named: 'page'),
          ));
    });

    test('a loadMore failure keeps the results on screen AND latches (no hammer)',
        () async {
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 1,
          )).thenAnswer((_) async => _page(<String>['a', 'b'], page: 1, hasMore: true));
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).thenThrow(const NetworkFailure());
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota, Rajasthan');
      await cubit.loadMore();

      // The page-1 results survive; the screen never drops to a full error view.
      expect(_ids(cubit.state), <String>['a', 'b']);
      expect(cubit.state.status, JobSearchStatus.results);

      // A worker parked at the bottom keeps scrolling — the latch suppresses the
      // failing page-2 fetch instead of re-firing it on every tick.
      await cubit.loadMore();
      await cubit.loadMore();
      verify(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).called(1);

      // A fresh search clears the latch (page-2 now succeeds under the new run).
      when(() => repo.searchJobs(
            q: any(named: 'q'),
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).thenAnswer((_) async => _page(<String>['c'], page: 2, hasMore: false));
      await cubit.search(title: 'CNC', location: 'Kota, Rajasthan');
      await cubit.loadMore();
      expect(_ids(cubit.state), <String>['a', 'b', 'c']);
    });

    test(
        'a search() fired while loadMore() is in flight discards the stale page '
        '(generation guard)', () async {
      final Completer<JobSearchPage> stalePage2 = Completer<JobSearchPage>();
      final Completer<JobSearchPage> freshPage1 = Completer<JobSearchPage>();

      // Q1 page 1 resolves immediately (enables load-more with hasMore=true).
      when(() => repo.searchJobs(
            q: 'CNC',
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 1,
          )).thenAnswer((_) async => _page(<String>['a', 'b'], page: 1, hasMore: true));
      // Q1 page 2 hangs — the stale load-more.
      when(() => repo.searchJobs(
            q: 'CNC',
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 2,
          )).thenAnswer((_) => stalePage2.future);
      // Q2 page 1 hangs — the superseding search.
      when(() => repo.searchJobs(
            q: 'VMC',
            city: any(named: 'city'),
            state: any(named: 'state'),
            limit: any(named: 'limit'),
            page: 1,
          )).thenAnswer((_) => freshPage1.future);

      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota');
      expect(_ids(cubit.state), <String>['a', 'b']);

      final Future<void> more = cubit.loadMore(); // Q1 page 2 in flight
      final Future<void> superseding =
          cubit.search(title: 'VMC', location: 'Kota'); // supersedes Q1

      // Resolve OUT OF ORDER: the stale page-2 lands first, then the new query.
      stalePage2.complete(_page(<String>['stale1', 'stale2'], page: 2, hasMore: true));
      freshPage1.complete(_page(<String>['x'], page: 1, hasMore: false));
      await Future.wait(<Future<void>>[more, superseding]);

      // Only the NEW query's page-1 survives — no Q1 page-2 rows appended, and
      // the cursor is page 1, not bumped to 2 by the stale reply.
      expect(_ids(cubit.state), <String>['x']);
      expect(cubit.state.page, 1);
      expect(cubit.state.hasMore, isFalse);
      expect(cubit.state.status, JobSearchStatus.results);
    });
  });

  group('clear', () {
    test('resets back to idle', () async {
      _stub(repo, _page(<String>['a']));
      final JobSearchCubit cubit = JobSearchCubit(repo);

      await cubit.search(title: 'CNC', location: 'Kota');
      expect(cubit.state.status, JobSearchStatus.results);

      cubit.clear();
      expect(cubit.state, const JobSearchState());
    });
  });
}

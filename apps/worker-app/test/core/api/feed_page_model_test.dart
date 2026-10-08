import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// #1961 / #2068 (ADR-0052) added ONE additive key to the `GET /feed`
/// envelope — `next_cursor`. The card shape is untouched, so the only thing to
/// prove here is the cursor's parsing, and above all that an ABSENT key reads
/// as null: that is what an older API build, and a rollback of PR #2067, send.
void main() {
  Map<String, dynamic> job(String id) => <String, dynamic>{
        'job_id': id,
        'trade_key': 'cnc_operator',
        'title': 'CNC Operator',
        'city': 'Pune',
        'area': 'Chakan',
        'rank': 1,
      };

  group('FeedPage.fromJson', () {
    test('a MISSING next_cursor key is null — the pre-paging wire shape', () {
      final FeedPage page = FeedPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[job('j1'), job('j2')],
      });

      expect(page.jobs.map((FeedItem j) => j.jobId), <String>['j1', 'j2']);
      expect(page.nextCursor, isNull);
    });

    test('an explicit null next_cursor is the end of the deck', () {
      final FeedPage page = FeedPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[job('j1')],
        'next_cursor': null,
      });

      expect(page.nextCursor, isNull);
    });

    test('a cursor is kept as the server minted it — byte for byte', () {
      const String cursor = 'eyJ2IjoxLCJtIjoiam9icyIsIm8iOjUwfQ';
      final FeedPage page = FeedPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[job('j1')],
        'next_cursor': cursor,
      });

      expect(page.nextCursor, cursor);
    });

    test('an EMPTY page can still carry a cursor (and vice versa)', () {
      // ADR-0052 §2.2: a deck of exactly `limit × n` cards ends with one empty
      // page. "Short page" is therefore NOT an end signal — only a null cursor.
      final FeedPage empty = FeedPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[],
        'next_cursor': 'c1',
      });

      expect(empty.jobs, isEmpty);
      expect(empty.nextCursor, 'c1');
    });

    test('an EMPTY-STRING cursor reads as null, not as a cursor', () {
      // `?cursor=` is "no cursor" server-side, so sending one back would
      // refetch page 1 for ever.
      final FeedPage page = FeedPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[job('j1')],
        'next_cursor': '',
      });

      expect(page.nextCursor, isNull);
    });

    test('a non-string cursor is dropped, never stringified', () {
      final FeedPage page = FeedPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[job('j1')],
        'next_cursor': 42,
      });

      expect(page.nextCursor, isNull);
    });

    test('an absent jobs key reads as no cards — unchanged behaviour', () {
      final FeedPage page = FeedPage.fromJson(<String, dynamic>{});

      expect(page.jobs, isEmpty);
      expect(page.nextCursor, isNull);
    });
  });
}

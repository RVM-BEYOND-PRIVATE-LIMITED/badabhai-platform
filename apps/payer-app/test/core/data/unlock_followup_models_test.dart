import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/unlock_followup_models.dart';

void main() {
  group('UnlockFollowupPage.tryFromJson', () {
    test('parses every contracted outcome, including a null answer', () {
      final UnlockFollowupPage? page =
          UnlockFollowupPage.tryFromJson(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{
            'unlock_id': 'u-1',
            'worker_id': 'w-1',
            'granted_at': '2026-11-01T10:00:00Z',
            'outcome': null,
          },
          <String, dynamic>{
            'unlock_id': 'u-2',
            'worker_id': 'w-2',
            'granted_at': '2026-11-02T10:00:00Z',
            'outcome': 'still_talking',
          },
          <String, dynamic>{
            'unlock_id': 'u-3',
            'worker_id': 'w-3',
            'granted_at': '2026-11-03T10:00:00Z',
            'outcome': 'hired',
          },
          <String, dynamic>{
            'unlock_id': 'u-4',
            'worker_id': 'w-4',
            'granted_at': '2026-11-04T10:00:00Z',
            'outcome': 'not_hired',
          },
        ],
        'nextCursor': 'cursor-2',
      });

      expect(page, isNotNull);
      expect(page!.items, hasLength(4));
      expect(page.items[0].outcome, isNull);
      expect(page.items[1].outcome, UnlockFollowupOutcome.stillTalking);
      expect(page.items[2].outcome, UnlockFollowupOutcome.hired);
      expect(page.items[3].outcome, UnlockFollowupOutcome.notHired);
      expect(page.nextCursor, 'cursor-2');
      expect(page.hasMore, isTrue);
    });

    test('null cursor means the last page', () {
      final UnlockFollowupPage? page =
          UnlockFollowupPage.tryFromJson(<String, dynamic>{
        'items': <dynamic>[],
        'nextCursor': null,
      });
      expect(page, isNotNull);
      expect(page!.items, isEmpty);
      expect(page.hasMore, isFalse);
    });

    test('a contract break is null, never an empty page', () {
      final List<Object?> broken = <Object?>[
        null,
        <String, dynamic>{},
        <String, dynamic>{'items': 'nope'},
        <String, dynamic>{'items': <dynamic>[], 'nextCursor': 12},
        <String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'unlock_id': 'u-1',
              'worker_id': 'w-1',
              'granted_at': '2026-11-01T10:00:00Z',
              'outcome': 'maybe',
            },
          ],
        },
        <String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'unlock_id': 'u-1',
              'worker_id': 'w-1',
              'granted_at': 'not-a-date',
              'outcome': null,
            },
          ],
        },
      ];
      for (final Object? json in broken) {
        expect(UnlockFollowupPage.tryFromJson(json), isNull);
      }
    });
  });

  group('UnlockFollowupResult.tryFromJson', () {
    test('parses the 200 body', () {
      final UnlockFollowupResult? result =
          UnlockFollowupResult.tryFromJson(<String, dynamic>{
        'unlock_id': 'u-1',
        'worker_id': 'w-1',
        'outcome': 'hired',
        'previous_outcome': 'still_talking',
        'answered_at': '2026-11-20T10:00:00Z',
        'changed': true,
      });

      expect(result, isNotNull);
      expect(result!.outcome, UnlockFollowupOutcome.hired);
      expect(result.previousOutcome, UnlockStoredOutcome.stillTalking);
      expect(result.changed, isTrue);
    });

    test('a desk not_reached is a valid previous answer', () {
      final UnlockFollowupResult? result =
          UnlockFollowupResult.tryFromJson(<String, dynamic>{
        'unlock_id': 'u-1',
        'worker_id': 'w-1',
        'outcome': 'hired',
        'previous_outcome': 'not_reached',
        'answered_at': '2026-11-20T10:00:00Z',
        'changed': true,
      });

      expect(result, isNotNull);
      expect(result!.previousOutcome, UnlockStoredOutcome.notReached);
    });

    test('a repeated answer is still a valid result with changed false', () {
      final UnlockFollowupResult? result =
          UnlockFollowupResult.tryFromJson(<String, dynamic>{
        'unlock_id': 'u-1',
        'worker_id': 'w-1',
        'outcome': 'not_hired',
        'previous_outcome': null,
        'answered_at': '2026-11-20T10:00:00Z',
        'changed': false,
      });

      expect(result, isNotNull);
      expect(result!.previousOutcome, isNull);
      expect(result.changed, isFalse);
    });

    test('a wrong-typed or unknown answer is null', () {
      final Map<String, dynamic> base = <String, dynamic>{
        'unlock_id': 'u-1',
        'worker_id': 'w-1',
        'outcome': 'hired',
        'previous_outcome': null,
        'answered_at': '2026-11-20T10:00:00Z',
        'changed': true,
      };
      expect(
        UnlockFollowupResult.tryFromJson(
          <String, dynamic>{...base, 'outcome': 'not_reached'},
        ),
        isNull,
      );
      expect(
        UnlockFollowupResult.tryFromJson(
          <String, dynamic>{...base, 'changed': 'yes'},
        ),
        isNull,
      );
    });
  });

  test('the wire values are the closed three the API accepts', () {
    expect(UnlockFollowupOutcome.hired.wire, 'hired');
    expect(UnlockFollowupOutcome.notHired.wire, 'not_hired');
    expect(UnlockFollowupOutcome.stillTalking.wire, 'still_talking');
  });
}

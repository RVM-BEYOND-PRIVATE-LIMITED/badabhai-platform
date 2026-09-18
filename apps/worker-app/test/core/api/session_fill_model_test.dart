import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// The settled-vs-missing `fill` block on `GET /profiling/session/:id`
/// (fill-gap Phase 3, issue #1575).
///
/// The block is ADDITIVE on an older shape (`{session_id, complete, rows}`),
/// so parsing reads `json['fill']` and degrades to an empty view — never a
/// throw. An empty view means "we cannot say", and the surface shows the full
/// list; it must never read as "answered".
void main() {
  group('SessionFillDto', () {
    test('parses entries and settled exactly as shipped', () {
      final SessionFillDto dto = SessionFillDto.fromJson(<String, dynamic>{
        'session_id': 's1',
        'complete': true,
        'rows': <dynamic>[],
        'fill': <String, dynamic>{
          'entries': <dynamic>[
            <String, dynamic>{
              'fact': 'languages',
              'question_key': 'languages',
              'status': 'answered',
              'source': 'chat',
              'dropped_by_projector': false,
              'is_core': true,
            },
            <String, dynamic>{
              'fact': 'shift',
              'question_key': 'shift',
              'status': 'declined',
              'source': 'chat',
              'dropped_by_projector': false,
              'is_core': true,
            },
          ],
          'settled': <dynamic>['languages', 'shift'],
        },
      });

      expect(dto.entries, hasLength(2));
      expect(dto.entries[0].fact, 'languages');
      expect(dto.entries[0].status, 'answered');
      expect(dto.entries[0].source, 'chat');
      expect(dto.entries[0].droppedByProjector, isFalse);
      expect(dto.entries[0].isCore, isTrue);
      expect(dto.entries[1].status, 'declined');
      expect(dto.settled, <String>['languages', 'shift']);
    });

    test('a missing fill block is an empty view, never a throw', () {
      final SessionFillDto dto =
          SessionFillDto.fromJson(<String, dynamic>{'session_id': 's1'});
      expect(dto.entries, isEmpty);
      expect(dto.settled, isEmpty);
    });

    test('a non-map fill block is an empty view, never a throw', () {
      final SessionFillDto dto = SessionFillDto.fromJson(<String, dynamic>{
        'fill': 'garbage',
      });
      expect(dto.entries, isEmpty);
      expect(dto.settled, isEmpty);
    });

    test('entries without a fact are dropped, the rest survive', () {
      final SessionFillDto dto = SessionFillDto.fromJson(<String, dynamic>{
        'fill': <String, dynamic>{
          'entries': <dynamic>[
            <String, dynamic>{'question_key': 'x'},
            'not-a-map',
            <String, dynamic>{
              'fact': 'work_types',
              'question_key': 'work_types',
              'status': 'missing',
              'source': 'chat',
              'dropped_by_projector': false,
              'is_core': false,
            },
          ],
          'settled': <dynamic>['work_types', 42],
        },
      });
      expect(dto.entries, hasLength(1));
      expect(dto.entries.single.fact, 'work_types');
      expect(dto.settled, <String>['work_types']);
    });

    test('absent status/source/flags take the documented defaults', () {
      final SessionFillEntryDto entry =
          SessionFillEntryDto.fromJson(<String, dynamic>{'fact': 'shift'});
      expect(entry.status, 'missing');
      expect(entry.source, 'chat');
      expect(entry.droppedByProjector, isFalse);
      expect(entry.isCore, isFalse);
    });
  });
}

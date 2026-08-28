import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('EmploymentEntry', () {
    test('toJson trims text and PRESERVES end_ym null as "current"', () {
      const EmploymentEntry e = EmploymentEntry(
        employerName: '  Sandhar Technologies  ',
        roleLabel: ' CNC Turner ',
        employerCity: ' Manesar ',
        employerState: 'Haryana',
        startYm: '2022-04',
        endYm: null, // still working here
        workDone: '  Twin-spindle lathes  ',
      );
      final Map<String, dynamic> json = e.toJson();
      expect(json['employer_name'], 'Sandhar Technologies');
      expect(json['role_label'], 'CNC Turner');
      expect(json['employer_city'], 'Manesar');
      expect(json['start_ym'], '2022-04');
      // The KEY must be present and null — the server reads null as "current",
      // never as "missing".
      expect(json.containsKey('end_ym'), isTrue);
      expect(json['end_ym'], isNull);
      expect(json['work_done'], 'Twin-spindle lathes');
    });

    test('blank optional strings become null, not empty strings', () {
      const EmploymentEntry e = EmploymentEntry(
        employerName: 'A',
        roleLabel: 'B',
        employerCity: '   ',
        workDone: '',
      );
      final Map<String, dynamic> json = e.toJson();
      expect(json['employer_city'], isNull);
      expect(json['work_done'], isNull);
      expect(json['start_ym'], isNull);
    });

    test('isBlank / isComplete gate the two required fields', () {
      expect(const EmploymentEntry(employerName: '', roleLabel: '').isBlank,
          isTrue);
      expect(
          const EmploymentEntry(employerName: 'A', roleLabel: '').isComplete,
          isFalse);
      expect(
          const EmploymentEntry(employerName: 'A', roleLabel: 'B').isComplete,
          isTrue);
      expect(
          const EmploymentEntry(employerName: 'A', roleLabel: 'B').isBlank,
          isFalse);
    });

    test('copyWith can CLEAR a nullable field via null', () {
      const EmploymentEntry e =
          EmploymentEntry(employerName: 'A', roleLabel: 'B', endYm: '2023-01');
      expect(e.copyWith(endYm: null).endYm, isNull);
      // omitting the arg keeps the value
      expect(e.copyWith(employerName: 'C').endYm, '2023-01');
    });
  });

  group('WorkPreferences.toUpdateBody (three-state)', () {
    test('lists are ALWAYS sent (empty = "none of these")', () {
      final Map<String, dynamic> body = const WorkPreferences().toUpdateBody();
      expect(body['languages'], <String>[]);
      expect(body['documents_ready'], <String>[]);
      expect(body['preferred_cities'], <String>[]);
    });

    test('scalars are OMITTED when unset (absent = leave alone) and sent when '
        'chosen', () {
      final Map<String, dynamic> none = const WorkPreferences().toUpdateBody();
      expect(none.containsKey('job_type'), isFalse);
      expect(none.containsKey('shift'), isFalse);

      final Map<String, dynamic> some = const WorkPreferences(
        jobType: 'permanent',
        shift: 'rotational',
      ).toUpdateBody();
      expect(some['job_type'], 'permanent');
      expect(some['shift'], 'rotational');
    });

    test('toggles are always a real bool', () {
      final Map<String, dynamic> body = const WorkPreferences(
        willingToRelocate: true,
        accommodationNeeded: false,
      ).toUpdateBody();
      expect(body['willing_to_relocate'], true);
      expect(body['accommodation_needed'], false);
    });
  });

  group('WorkPrefOptionsDto.fromJson', () {
    test('parses each slug→label map and coerces safely', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'languages': <String, dynamic>{'hindi': 'Hindi', 'bad': 7},
        'documents_ready': <String, dynamic>{'aadhaar': 'Aadhaar'},
        'job_type': <String, dynamic>{'permanent': 'Permanent'},
        'shift': <String, dynamic>{'day': 'Day'},
      });
      expect(dto.languages, <String, String>{'hindi': 'Hindi'}); // non-string dropped
      expect(dto.documentsReady['aadhaar'], 'Aadhaar');
      expect(dto.jobType['permanent'], 'Permanent');
      expect(dto.shift['day'], 'Day');
    });

    test('missing / malformed fields default to empty maps', () {
      final WorkPrefOptionsDto dto =
          WorkPrefOptionsDto.fromJson(<String, dynamic>{'languages': 'nope'});
      expect(dto.languages, isEmpty);
      expect(dto.documentsReady, isEmpty);
      expect(dto.jobType, isEmpty);
      expect(dto.shift, isEmpty);
    });
  });
}

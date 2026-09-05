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

    test('#1298 salary + education keys are OMITTED when unset', () {
      final Map<String, dynamic> body = const WorkPreferences().toUpdateBody();
      for (final String k in <String>[
        'salary_expected_max',
        'education_credential',
        'education_council',
        'education_year',
        'education_institute',
      ]) {
        expect(body.containsKey(k), isFalse, reason: k);
      }
    });

    test('#1298 salary + education keys are sent when set', () {
      final Map<String, dynamic> body = const WorkPreferences(
        salaryExpectedMax: 25000,
        educationCredential: 'iti',
        educationCouncil: 'ncvt',
        educationYear: 2018,
        educationInstitute: 'Govt. ITI, Faridabad',
      ).toUpdateBody();
      expect(body['salary_expected_max'], 25000);
      expect(body['education_credential'], 'iti');
      expect(body['education_council'], 'ncvt');
      expect(body['education_year'], 2018);
      expect(body['education_institute'], 'Govt. ITI, Faridabad');
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

    // #1429 — the state-then-city cascade: each city carries its state, and
    // the response's own top-level `states` list is the picker's vocabulary.
    test('parses state-tagged cities and the top-level states list', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'cities': <Map<String, dynamic>>[
          <String, dynamic>{
            'value': 'Gurugram',
            'aliases': <String>['gurgaon'],
            'state': 'Haryana',
          },
          <String, dynamic>{'value': 'Pune', 'aliases': <String>[], 'state': 'Maharashtra'},
        ],
        'states': <String>['Haryana', 'Maharashtra'],
      });
      expect(dto.states, <String>['Haryana', 'Maharashtra']);
      expect(dto.cities, hasLength(2));
      expect(dto.cities.first.value, 'Gurugram');
      expect(dto.cities.first.state, 'Haryana');
      expect(dto.cities.last.state, 'Maharashtra');
    });

    test('missing state/states default to empty — never a crash on an '
        'old-server response', () {
      final WorkPrefOptionsDto dto = WorkPrefOptionsDto.fromJson(<String, dynamic>{
        'cities': <Map<String, dynamic>>[
          <String, dynamic>{'value': 'Pune', 'aliases': <String>[]},
        ],
      });
      expect(dto.states, isEmpty);
      expect(dto.cities.single.state, '');
    });
  });
}

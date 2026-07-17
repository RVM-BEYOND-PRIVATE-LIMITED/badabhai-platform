import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';

/// [JobDetail.fromJson] parses the `GET /jobs/:jobId` body (ADR-0024 addendum,
/// 2026-07-16): defensive, NAMED keys only, honest nulls — and structurally
/// incapable of carrying anything employer-shaped.
void main() {
  group('JobDetail.fromJson', () {
    test('parses a full body', () {
      final JobDetail d = JobDetail.fromJson(<String, dynamic>{
        'job_id': 'j1',
        'trade_key': 'cnc_operator',
        'title': 'CNC Operator',
        'city': 'Pune',
        'area': 'Chakan',
        'pay_min': 16000,
        'pay_max': 26000,
        'min_experience_years': 0,
        'max_experience_years': 2,
        'needed_by': 'immediate',
        'shift': 'day',
        'description': 'CNC lathe par production ka kaam.',
        'benefits': <String>['PF + ESI', 'Canteen'],
        'requirements': <String>['Fanuc control', 'ITI / Diploma'],
      });

      expect(d.jobId, 'j1');
      expect(d.tradeKey, 'cnc_operator');
      expect(d.title, 'CNC Operator');
      expect(d.place, 'Chakan, Pune');
      expect(d.payMin, 16000);
      expect(d.payMax, 26000);
      expect(d.minExperienceYears, 0);
      expect(d.maxExperienceYears, 2);
      expect(d.neededBy, 'immediate');
      expect(d.shift, 'day');
      expect(d.description, 'CNC lathe par production ka kaam.');
      expect(d.benefits, <String>['PF + ESI', 'Canteen']);
      expect(d.requirements, <String>['Fanuc control', 'ITI / Diploma']);
    });

    test('a minimal body keeps every optional field honestly null', () {
      final JobDetail d = JobDetail.fromJson(<String, dynamic>{
        'job_id': 'j2',
        'trade_key': 'welder',
        'title': 'Welder',
        'city': 'Nashik',
      });

      expect(d.jobId, 'j2');
      expect(d.title, 'Welder');
      expect(d.place, 'Nashik');
      expect(d.area, isNull);
      expect(d.payMin, isNull);
      expect(d.payMax, isNull);
      expect(d.minExperienceYears, isNull);
      expect(d.maxExperienceYears, isNull);
      expect(d.neededBy, isNull);
      expect(d.shift, isNull);
      expect(d.description, isNull);
      expect(d.benefits, isNull);
      expect(d.requirements, isNull);
    });

    test('explicit nulls and one-sided pay bands are preserved, not coerced',
        () {
      final JobDetail d = JobDetail.fromJson(<String, dynamic>{
        'job_id': 'j3',
        'trade_key': 'welder',
        'title': 'Welder',
        'city': 'Nashik',
        'area': null,
        'pay_min': 18000,
        'pay_max': null,
        'min_experience_years': 5,
        'max_experience_years': null,
        'needed_by': null,
        'shift': null,
        'description': null,
        'benefits': null,
        'requirements': null,
      });

      expect(d.payMin, 18000);
      expect(d.payMax, isNull); // open-ended — never invented
      expect(d.minExperienceYears, 5);
      expect(d.maxExperienceYears, isNull);
      expect(d.benefits, isNull);
    });

    test('unknown keys are ignored, never a crash', () {
      final JobDetail d = JobDetail.fromJson(<String, dynamic>{
        'job_id': 'j4',
        'title': 'Fitter',
        'city': 'Pune',
        'some_future_key': 'whatever',
        'another': <String, dynamic>{'nested': true},
      });
      expect(d.jobId, 'j4');
      expect(d.title, 'Fitter');
    });

    test(
        'a contract-violating body with employer-shaped keys leaves NO trace '
        'anywhere on the model', () {
      // The backend contract says a payer field must NEVER appear; if one ever
      // did, the named-keys-only parser must drop it on the floor.
      final JobDetail d = JobDetail.fromJson(<String, dynamic>{
        'job_id': 'j5',
        'trade_key': 'cnc_operator',
        'title': 'CNC Operator',
        'city': 'Pune',
        'payer_id': 'payer-1234',
        'company': 'Acme Pvt Ltd',
        'employer_name': 'Sharma Works',
        'contact_phone': '+919999999999',
      });

      // Flatten EVERY prop (lists included) and assert none of the malicious
      // values survived — the class has no field that could hold them.
      final String dump = d.props
          .map((Object? p) => p is List ? p.join(' ') : '$p')
          .join(' ');
      expect(dump.contains('payer'), isFalse);
      expect(dump.contains('Acme'), isFalse);
      expect(dump.contains('Pvt'), isFalse);
      expect(dump.contains('Sharma'), isFalse);
      expect(dump.contains('9999'), isFalse);
    });

    test('empty or blank string lists normalise to null (row hides)', () {
      final JobDetail d = JobDetail.fromJson(<String, dynamic>{
        'job_id': 'j6',
        'title': 'Fitter',
        'city': 'Pune',
        'benefits': <String>[],
        'requirements': <dynamic>['  ', 42, null],
      });
      expect(d.benefits, isNull);
      expect(d.requirements, isNull);
    });
  });

  group('JobDetail.place', () {
    test('builds place honestly from what exists', () {
      expect(
          const JobDetail(
                  jobId: 'a', title: 'T', city: 'Pune', area: 'Pimpri')
              .place,
          'Pimpri, Pune');
      expect(const JobDetail(jobId: 'b', title: 'T', city: 'Pune').place,
          'Pune');
      // Nothing to show -> null, so the screen renders no location line at
      // all rather than inventing one.
      expect(const JobDetail(jobId: 'c', title: 'T').place, isNull);
    });
  });
}

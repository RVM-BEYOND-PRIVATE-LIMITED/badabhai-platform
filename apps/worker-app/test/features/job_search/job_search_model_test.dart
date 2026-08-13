import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/job_search/domain/job_search_item.dart';

/// [JobSearchItem] mirrors the PII-free feed item and ADDS `state` + `published_at`.
/// Parsing must be tolerant of missing/null keys (a slightly older or partial
/// server response can never crash the search flow) and keep nulls honest.
void main() {
  group('JobSearchItem.fromJson', () {
    test('parses a full row including state + published_at', () {
      final JobSearchItem item = JobSearchItem.fromJson(<String, dynamic>{
        'job_id': 'j1',
        'title': 'CNC Operator',
        'city': 'Kota',
        'state': 'Rajasthan',
        'area': 'Industrial Area',
        'pay_min': 20000,
        'pay_max': 35000,
        'shift': 'day',
        'min_experience_years': 1,
        'max_experience_years': 4,
        'matched_skill_label': 'CNC Operator',
        'published_at': '2026-08-01T00:00:00Z',
      });

      expect(item.jobId, 'j1');
      expect(item.title, 'CNC Operator');
      expect(item.city, 'Kota');
      expect(item.state, 'Rajasthan');
      expect(item.area, 'Industrial Area');
      expect(item.payMin, 20000);
      expect(item.payMax, 35000);
      expect(item.shift, 'day');
      expect(item.minExperienceYears, 1);
      expect(item.maxExperienceYears, 4);
      expect(item.matchedSkillLabel, 'CNC Operator');
      expect(item.publishedAt, DateTime.utc(2026, 8, 1));
      expect(item.place, 'Industrial Area, Kota, Rajasthan');
    });

    test('null optionals land on honest empties — state "" , the rest null', () {
      final JobSearchItem item = JobSearchItem.fromJson(<String, dynamic>{
        'job_id': 'j2',
        'title': 'Welder',
        'city': 'Nashik',
        'state': null,
        'area': null,
        'pay_min': null,
        'pay_max': null,
        'shift': null,
        'min_experience_years': null,
        'max_experience_years': null,
        'matched_skill_label': null,
        'published_at': null,
      });

      expect(item.state, ''); // null -> "" so the place line never sees a null
      expect(item.area, isNull);
      expect(item.payMin, isNull);
      expect(item.payMax, isNull);
      expect(item.shift, isNull);
      expect(item.minExperienceYears, isNull);
      expect(item.maxExperienceYears, isNull);
      expect(item.matchedSkillLabel, isNull);
      expect(item.publishedAt, isNull);
      expect(item.place, 'Nashik'); // only the city remains
    });

    test('absent keys behave exactly like nulls', () {
      final JobSearchItem item = JobSearchItem.fromJson(<String, dynamic>{
        'job_id': 'j3',
        'title': 'Fitter',
        'city': 'Pune',
      });

      expect(item.state, '');
      expect(item.area, isNull);
      expect(item.payMin, isNull);
      expect(item.shift, isNull);
      expect(item.publishedAt, isNull);
      expect(item.place, 'Pune');
    });

    test('a malformed published_at degrades to null (never throws)', () {
      final JobSearchItem item = JobSearchItem.fromJson(<String, dynamic>{
        'job_id': 'j4',
        'title': 'x',
        'city': 'y',
        'published_at': 'not-a-date',
      });

      expect(item.publishedAt, isNull);
    });

    test('a one-sided pay band stays one-sided', () {
      final JobSearchItem item = JobSearchItem.fromJson(<String, dynamic>{
        'job_id': 'j5',
        'title': 'Welder',
        'city': 'Kota',
        'state': 'Rajasthan',
        'pay_min': 16000,
      });

      expect(item.payMin, 16000);
      expect(item.payMax, isNull);
    });
  });

  group('JobSearchPage.fromJson', () {
    test('parses the { jobs, page, limit, has_more } envelope', () {
      final JobSearchPage page = JobSearchPage.fromJson(<String, dynamic>{
        'jobs': <Map<String, dynamic>>[
          <String, dynamic>{
            'job_id': 'j1',
            'title': 'CNC Operator',
            'city': 'Kota',
            'state': 'Rajasthan',
          },
        ],
        'page': 2,
        'limit': 20,
        'has_more': true,
      });

      expect(page.items, hasLength(1));
      expect(page.items.first.jobId, 'j1');
      expect(page.page, 2);
      expect(page.limit, 20);
      expect(page.hasMore, isTrue);
    });

    test('a missing jobs list + envelope defaults degrade gracefully', () {
      final JobSearchPage page = JobSearchPage.fromJson(<String, dynamic>{});

      expect(page.items, isEmpty);
      expect(page.page, 1);
      expect(page.limit, 20);
      expect(page.hasMore, isFalse);
    });

    test('non-object entries in jobs are skipped', () {
      final JobSearchPage page = JobSearchPage.fromJson(<String, dynamic>{
        'jobs': <dynamic>[
          'garbage',
          <String, dynamic>{'job_id': 'ok', 'title': 't', 'city': 'c'},
        ],
        'has_more': false,
      });

      expect(page.items, hasLength(1));
      expect(page.items.first.jobId, 'ok');
    });
  });
}

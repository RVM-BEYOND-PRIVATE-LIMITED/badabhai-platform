import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// The ADR-0024 addendum (2026-07-16) added three ADDITIVE nullable keys to
/// `GET /feed` items — `pay_min`, `pay_max`, `shift`. The OLD wire shape must
/// keep parsing (backward compatibility), and nulls must stay honest.
void main() {
  group('FeedItem.fromJson pay/shift (additive keys)', () {
    test('the OLD shape (no pay/shift keys) still parses — nulls, no crash',
        () {
      final FeedItem item = FeedItem.fromJson(<String, dynamic>{
        'job_id': 'j1',
        'trade_key': 'cnc_operator',
        'title': 'CNC Operator',
        'city': 'Pune',
        'area': 'Chakan',
        'rank': 1,
      });

      expect(item.jobId, 'j1');
      expect(item.payMin, isNull);
      expect(item.payMax, isNull);
      expect(item.shift, isNull);
    });

    test('the new keys parse when present', () {
      final FeedItem item = FeedItem.fromJson(<String, dynamic>{
        'job_id': 'j2',
        'trade_key': 'vmc_setter',
        'title': 'VMC Setter',
        'city': 'Pune',
        'area': null,
        'rank': 2,
        'pay_min': 22000,
        'pay_max': 32000,
        'shift': 'rotational',
      });

      expect(item.payMin, 22000);
      expect(item.payMax, 32000);
      expect(item.shift, 'rotational');
    });

    test('explicit nulls are preserved — never coerced to a number/shift', () {
      final FeedItem item = FeedItem.fromJson(<String, dynamic>{
        'job_id': 'j3',
        'trade_key': 'welder',
        'title': 'Welder',
        'city': 'Nashik',
        'area': null,
        'rank': 3,
        'pay_min': 18000,
        'pay_max': null,
        'shift': null,
      });

      expect(item.payMin, 18000);
      expect(item.payMax, isNull); // one-sided band stays one-sided
      expect(item.shift, isNull);
    });
  });
}

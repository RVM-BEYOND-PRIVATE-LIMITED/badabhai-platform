import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';

FeedItem _job(String id, String tradeKey, String title) => FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: title,
      city: 'Pune',
      area: null,
      rank: 1,
    );

// Mirrors the mock feed shape (cnc_operator / vmc_setter / welder / fitter) plus
// a QC row to exercise the spelled-out keyword mapping.
final List<FeedItem> _feed = <FeedItem>[
  _job('cnc1', 'cnc_operator', 'CNC Operator'),
  _job('vmc1', 'vmc_setter', 'VMC Setter'),
  _job('weld1', 'welder', 'Welder'),
  _job('fit1', 'fitter', 'Fitter'),
  _job('qc1', 'quality_inspector', 'Quality Inspector'),
];

List<String> _ids(List<FeedItem> jobs) =>
    jobs.map((FeedItem j) => j.jobId).toList();

void main() {
  group('jobMatchesTrades', () {
    test('empty selection matches every job (unfiltered feed)', () {
      for (final FeedItem job in _feed) {
        expect(jobMatchesTrades(job, const <String>{}), isTrue);
      }
    });

    test('CNC matches only the CNC trade', () {
      expect(jobMatchesTrades(_feed[0], const <String>{'CNC'}), isTrue);
      expect(jobMatchesTrades(_feed[1], const <String>{'CNC'}), isFalse);
      expect(jobMatchesTrades(_feed[2], const <String>{'CNC'}), isFalse);
    });

    test('QC maps to quality_inspector (spelled-out keywords)', () {
      expect(jobMatchesTrades(_feed[4], const <String>{'QC'}), isTrue);
      expect(jobMatchesTrades(_feed[0], const <String>{'QC'}), isFalse);
    });

    test('matching is case-insensitive against tradeKey and title', () {
      final FeedItem upper = _job('x', 'CNC_OPERATOR', 'CNC OPERATOR');
      expect(jobMatchesTrades(upper, const <String>{'CNC'}), isTrue);
    });
  });

  group('applyTradeFilter', () {
    test('empty selection returns the list unchanged (identity)', () {
      expect(applyTradeFilter(_feed, const <String>{}), same(_feed));
    });

    test('single trade narrows to matching jobs', () {
      expect(_ids(applyTradeFilter(_feed, const <String>{'VMC'})),
          <String>['vmc1']);
    });

    test('multi-select is a union (CNC + VMC)', () {
      expect(_ids(applyTradeFilter(_feed, const <String>{'CNC', 'VMC'})),
          <String>['cnc1', 'vmc1']);
    });

    test('order is preserved', () {
      expect(
        _ids(applyTradeFilter(_feed, const <String>{'Fitter', 'CNC'})),
        <String>['cnc1', 'fit1'],
      );
    });

    test('a selection that matches nothing yields an empty list', () {
      final List<FeedItem> onlyWelder = <FeedItem>[_feed[2]];
      expect(applyTradeFilter(onlyWelder, const <String>{'CNC'}), isEmpty);
    });
  });
}

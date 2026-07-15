import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';

FeedItem _job(
  String id,
  String tradeKey,
  String title, {
  String city = 'Pune',
  int? minExp,
  int? maxExp,
}) =>
    FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: null,
      minExperienceYears: minExp,
      maxExperienceYears: maxExp,
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

FilterSelection _sel({
  Set<String> trades = const <String>{},
  Set<String> cities = const <String>{},
  Set<String> bands = const <String>{},
}) =>
    FilterSelection(trades: trades, cities: cities, experienceBands: bands);

void main() {
  group('FeedItem.fromJson — experience window', () {
    test('parses the snake_case experience keys', () {
      final FeedItem job = FeedItem.fromJson(<String, dynamic>{
        'job_id': 'j1',
        'trade_key': 'cnc_operator',
        'title': 'CNC Operator',
        'city': 'Pune',
        'area': null,
        'min_experience_years': 2,
        'max_experience_years': 5,
        'rank': 1,
      });
      expect(job.minExperienceYears, 2);
      expect(job.maxExperienceYears, 5);
    });

    test('missing keys and explicit nulls both parse to null (no bound)', () {
      final FeedItem missing = FeedItem.fromJson(<String, dynamic>{
        'job_id': 'j2',
        'city': 'Pune',
      });
      expect(missing.minExperienceYears, isNull);
      expect(missing.maxExperienceYears, isNull);

      final FeedItem explicit = FeedItem.fromJson(<String, dynamic>{
        'job_id': 'j3',
        'city': 'Pune',
        'min_experience_years': null,
        'max_experience_years': null,
      });
      expect(explicit.minExperienceYears, isNull);
      expect(explicit.maxExperienceYears, isNull);
    });

    test('the window participates in value equality', () {
      expect(_job('a', 'cnc_operator', 'CNC', minExp: 0, maxExp: 2),
          isNot(equals(_job('a', 'cnc_operator', 'CNC', minExp: 2, maxExp: 5))));
      expect(_job('a', 'cnc_operator', 'CNC', minExp: 0, maxExp: 2),
          equals(_job('a', 'cnc_operator', 'CNC', minExp: 0, maxExp: 2)));
    });
  });

  group('FilterSelection', () {
    test('initial is empty on all three dimensions (show all)', () {
      expect(FilterSelection.initial.trades, isEmpty);
      expect(FilterSelection.initial.cities, isEmpty);
      expect(FilterSelection.initial.experienceBands, isEmpty);
      expect(FilterSelection.initial.isEmpty, isTrue);
    });

    test('isEmpty is false when ANY dimension is selected', () {
      expect(_sel(trades: <String>{'CNC'}).isEmpty, isFalse);
      expect(_sel(cities: <String>{'Pune'}).isEmpty, isFalse);
      expect(_sel(bands: <String>{'5+ yrs'}).isEmpty, isFalse);
    });

    test('copyWith replaces only the named dimension', () {
      final FilterSelection base = _sel(
        trades: <String>{'CNC'},
        cities: <String>{'Pune'},
        bands: <String>{'0-2 yrs'},
      );
      final FilterSelection next = base.copyWith(cities: <String>{'Delhi'});
      expect(next.trades, <String>{'CNC'});
      expect(next.cities, <String>{'Delhi'});
      expect(next.experienceBands, <String>{'0-2 yrs'});
    });

    test('value equality holds by CONTENT (bloc emit de-duplication)', () {
      expect(_sel(trades: <String>{'CNC'}), equals(_sel(trades: <String>{'CNC'})));
      expect(_sel(trades: <String>{'CNC'}),
          isNot(equals(_sel(trades: <String>{'VMC'}))));
      // Set order must not affect equality.
      expect(_sel(trades: <String>{'CNC', 'VMC'}),
          equals(_sel(trades: <String>{'VMC', 'CNC'})));
    });

    test('kExperienceBandLabels is the locked display order', () {
      expect(kExperienceBandLabels, <String>['0-2 yrs', '2-5 yrs', '5+ yrs']);
    });
  });

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

  group('jobMatchesCities', () {
    test('empty selection matches every job', () {
      for (final FeedItem job in _feed) {
        expect(jobMatchesCities(job, const <String>{}), isTrue);
      }
    });

    test('exact match, case-insensitive both ways', () {
      final FeedItem job = _job('a', 'welder', 'Welder', city: 'Pune');
      expect(jobMatchesCities(job, const <String>{'Pune'}), isTrue);
      expect(jobMatchesCities(job, const <String>{'pune'}), isTrue);
      expect(jobMatchesCities(job, const <String>{'PUNE'}), isTrue);

      final FeedItem lower = _job('b', 'welder', 'Welder', city: 'pune');
      expect(jobMatchesCities(lower, const <String>{'Pune'}), isTrue);
    });

    test('is EXACT, not substring — a prefix city does not match', () {
      final FeedItem job = _job('a', 'welder', 'Welder', city: 'Punegaon');
      expect(jobMatchesCities(job, const <String>{'Pune'}), isFalse);
    });

    test('multi-select is a union (OR within the dimension)', () {
      final FeedItem pune = _job('a', 'welder', 'Welder', city: 'Pune');
      final FeedItem delhi = _job('b', 'welder', 'Welder', city: 'Delhi');
      final FeedItem nashik = _job('c', 'welder', 'Welder', city: 'Nashik');
      const Set<String> sel = <String>{'Pune', 'Delhi'};
      expect(jobMatchesCities(pune, sel), isTrue);
      expect(jobMatchesCities(delhi, sel), isTrue);
      expect(jobMatchesCities(nashik, sel), isFalse);
    });
  });

  group('jobMatchesExperience', () {
    test('empty selection matches every job', () {
      final FeedItem job = _job('a', 'welder', 'W', minExp: 3, maxExp: 4);
      expect(jobMatchesExperience(job, const <String>{}), isTrue);
    });

    test('a job with NO experience data matches EVERY band', () {
      // Window is [0, infinity] — deliberately never dropped (liberal feed).
      final FeedItem blank = _job('a', 'welder', 'Welder');
      for (final String band in kExperienceBandLabels) {
        expect(jobMatchesExperience(blank, <String>{band}), isTrue,
            reason: 'blank window must match $band');
      }
    });

    test('a null MIN alone means "no floor" — window [0, max]', () {
      final FeedItem job = _job('a', 'welder', 'W', maxExp: 1);
      expect(jobMatchesExperience(job, const <String>{'0-2 yrs'}), isTrue);
      expect(jobMatchesExperience(job, const <String>{'2-5 yrs'}), isFalse);
      expect(jobMatchesExperience(job, const <String>{'5+ yrs'}), isFalse);
    });

    test('a null MAX alone means open-ended — window [min, infinity]', () {
      final FeedItem job = _job('a', 'welder', 'W', minExp: 8);
      expect(jobMatchesExperience(job, const <String>{'5+ yrs'}), isTrue);
      // 8+ years overlaps neither of the closed bands that end at 2 / 5.
      expect(jobMatchesExperience(job, const <String>{'0-2 yrs'}), isFalse);
      expect(jobMatchesExperience(job, const <String>{'2-5 yrs'}), isFalse);
    });

    test('the 5+ band is open-ended and catches a very senior job', () {
      final FeedItem senior = _job('a', 'welder', 'W', minExp: 20, maxExp: 30);
      expect(jobMatchesExperience(senior, const <String>{'5+ yrs'}), isTrue);
    });

    test('a fully-inside window matches its band only', () {
      final FeedItem mid = _job('a', 'welder', 'W', minExp: 3, maxExp: 4);
      expect(jobMatchesExperience(mid, const <String>{'2-5 yrs'}), isTrue);
      expect(jobMatchesExperience(mid, const <String>{'0-2 yrs'}), isFalse);
      expect(jobMatchesExperience(mid, const <String>{'5+ yrs'}), isFalse);
    });

    test('overlap is INCLUSIVE at the shared band endpoints', () {
      // A job wanting exactly 2 years is honestly both 0-2 and 2-5.
      final FeedItem two = _job('a', 'welder', 'W', minExp: 2, maxExp: 2);
      expect(jobMatchesExperience(two, const <String>{'0-2 yrs'}), isTrue);
      expect(jobMatchesExperience(two, const <String>{'2-5 yrs'}), isTrue);
      expect(jobMatchesExperience(two, const <String>{'5+ yrs'}), isFalse);

      final FeedItem five = _job('b', 'welder', 'W', minExp: 5, maxExp: 5);
      expect(jobMatchesExperience(five, const <String>{'2-5 yrs'}), isTrue);
      expect(jobMatchesExperience(five, const <String>{'5+ yrs'}), isTrue);
      expect(jobMatchesExperience(five, const <String>{'0-2 yrs'}), isFalse);
    });

    test('a wide window overlaps several bands', () {
      final FeedItem wide = _job('a', 'welder', 'W', minExp: 1, maxExp: 7);
      expect(jobMatchesExperience(wide, const <String>{'0-2 yrs'}), isTrue);
      expect(jobMatchesExperience(wide, const <String>{'2-5 yrs'}), isTrue);
      expect(jobMatchesExperience(wide, const <String>{'5+ yrs'}), isTrue);
    });

    test('multi-select is a union (OR within the dimension)', () {
      final FeedItem mid = _job('a', 'welder', 'W', minExp: 3, maxExp: 4);
      expect(
        jobMatchesExperience(mid, const <String>{'0-2 yrs', '2-5 yrs'}),
        isTrue,
      );
      expect(
        jobMatchesExperience(mid, const <String>{'0-2 yrs', '5+ yrs'}),
        isFalse,
      );
    });

    test('an unknown band label never matches and never throws', () {
      final FeedItem job = _job('a', 'welder', 'W', minExp: 3, maxExp: 4);
      expect(jobMatchesExperience(job, const <String>{'99 yrs'}), isFalse);
    });
  });

  group('jobMatchesFilters — AND across dimensions', () {
    final FeedItem job =
        _job('a', 'cnc_operator', 'CNC Operator', city: 'Pune', minExp: 1, maxExp: 3);

    test('initial selection matches everything', () {
      expect(jobMatchesFilters(job, FilterSelection.initial), isTrue);
    });

    test('all dimensions satisfied → match', () {
      expect(
        jobMatchesFilters(
          job,
          _sel(
            trades: <String>{'CNC'},
            cities: <String>{'pune'},
            bands: <String>{'2-5 yrs'},
          ),
        ),
        isTrue,
      );
    });

    test('ANY unsatisfied dimension → no match', () {
      // Wrong trade.
      expect(
        jobMatchesFilters(job, _sel(trades: <String>{'VMC'}, cities: <String>{'Pune'})),
        isFalse,
      );
      // Wrong city.
      expect(
        jobMatchesFilters(job, _sel(trades: <String>{'CNC'}, cities: <String>{'Delhi'})),
        isFalse,
      );
      // Wrong band.
      expect(
        jobMatchesFilters(job, _sel(trades: <String>{'CNC'}, bands: <String>{'5+ yrs'})),
        isFalse,
      );
    });
  });

  group('applyJobFilters', () {
    test('empty selection returns the list unchanged (identity, same instance)',
        () {
      expect(applyJobFilters(_feed, FilterSelection.initial), same(_feed));
    });

    test('single trade narrows to matching jobs', () {
      expect(_ids(applyJobFilters(_feed, _sel(trades: <String>{'VMC'}))),
          <String>['vmc1']);
    });

    test('multi-select trade is a union and preserves order', () {
      expect(_ids(applyJobFilters(_feed, _sel(trades: <String>{'Fitter', 'CNC'}))),
          <String>['cnc1', 'fit1']);
    });

    test('city + trade compose with AND', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('a', 'cnc_operator', 'CNC Operator', city: 'Pune'),
        _job('b', 'cnc_operator', 'CNC Operator', city: 'Delhi'),
        _job('c', 'welder', 'Welder', city: 'Pune'),
      ];
      expect(
        _ids(applyJobFilters(
            jobs, _sel(trades: <String>{'CNC'}, cities: <String>{'Pune'}))),
        <String>['a'],
      );
    });

    test('experience narrows but never drops a blank-window job', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('junior', 'welder', 'Welder', minExp: 0, maxExp: 1),
        _job('senior', 'welder', 'Welder', minExp: 6, maxExp: 9),
        _job('blank', 'welder', 'Welder'),
      ];
      expect(_ids(applyJobFilters(jobs, _sel(bands: <String>{'5+ yrs'}))),
          <String>['senior', 'blank']);
      expect(_ids(applyJobFilters(jobs, _sel(bands: <String>{'0-2 yrs'}))),
          <String>['junior', 'blank']);
    });

    test('a selection that matches nothing yields an empty list', () {
      final List<FeedItem> onlyWelder = <FeedItem>[_feed[2]];
      expect(applyJobFilters(onlyWelder, _sel(trades: <String>{'CNC'})), isEmpty);
    });
  });

  group('availableCities', () {
    test('is distinct and sorted', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('a', 'welder', 'W', city: 'Pune'),
        _job('b', 'welder', 'W', city: 'Delhi'),
        _job('c', 'welder', 'W', city: 'Pune'),
        _job('d', 'welder', 'W', city: 'Nashik'),
      ];
      expect(availableCities(jobs), <String>['Delhi', 'Nashik', 'Pune']);
    });

    test('empty queue yields no options (never a hardcoded list)', () {
      expect(availableCities(const <FeedItem>[]), isEmpty);
    });

    test('drops empty/blank city values', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('a', 'welder', 'W', city: ''),
        _job('b', 'welder', 'W', city: '   '),
        _job('c', 'welder', 'W', city: 'Pune'),
      ];
      expect(availableCities(jobs), <String>['Pune']);
    });

    test('de-dupes case-insensitively, keeping the first-seen spelling', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('a', 'welder', 'W', city: 'Pune'),
        _job('b', 'welder', 'W', city: 'pune'),
        _job('c', 'welder', 'W', city: 'PUNE'),
      ];
      // One chip, not three — all three spellings select the same jobs.
      expect(availableCities(jobs), <String>['Pune']);
    });

    test('every derived option matches at least one loaded job', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('a', 'welder', 'W', city: 'Pune'),
        _job('b', 'welder', 'W', city: 'delhi'),
        // Untrimmed + mixed-case spellings belong in THIS fixture: with clean
        // values the property holds even when the deriver and the matcher
        // normalise differently, so the asymmetry this test exists to catch
        // would slip straight through.
        _job('c', 'welder', 'W', city: ' Nashik '),
        _job('d', 'welder', 'W', city: '  MUMBAI'),
      ];
      for (final String city in availableCities(jobs)) {
        expect(
          applyJobFilters(jobs, _sel(cities: <String>{city})),
          isNotEmpty,
          reason: '$city must not be a dead-end option',
        );
      }
    });

    test('an ACTIVE city keeps a chip after its jobs drain from the queue', () {
      // A selected city whose jobs are all applied/skipped (or narrowed away by
      // another dimension) disappears from the derived list — but it is STILL
      // filtering the deck. Without unioning the selection back in, the worker
      // sees "no jobs match", opens the sheet, and finds no chip to switch off.
      final List<FeedItem> queueWithoutPune = <FeedItem>[
        _job('a', 'welder', 'W', city: 'Nashik'),
      ];
      expect(availableCities(queueWithoutPune), <String>['Nashik']);
      expect(
        availableCities(queueWithoutPune, selected: <String>{'Pune'}),
        <String>['Nashik', 'Pune'],
      );
    });

    test('unioned selection does not duplicate a city already in the queue', () {
      final List<FeedItem> jobs = <FeedItem>[
        _job('a', 'welder', 'W', city: 'Pune'),
      ];
      expect(
        availableCities(jobs, selected: <String>{'pune'}),
        <String>['Pune'],
      );
    });
  });

  group('city normalisation (regression)', () {
    test('a city with stray whitespace matches the chip it generated', () {
      // Reachable in production, not synthetic: the agency portal's city field
      // is `z.string().min(1).max(CITY_MAX)` with no .trim(), and the repository
      // inserts it verbatim into jobs.city — so ' Pune ' is a storable value.
      // availableCities offers the TRIMMED spelling, so jobMatchesCities must
      // normalise identically or the only offered chip matches zero jobs.
      final FeedItem job = _job('j1', 'cnc_operator', 'CNC Operator', city: ' Pune ');
      final List<String> options = availableCities(<FeedItem>[job]);

      expect(options, <String>['Pune']);
      expect(jobMatchesCities(job, options.toSet()), isTrue);
      expect(
        _ids(applyJobFilters(<FeedItem>[job], _sel(cities: options.toSet()))),
        <String>['j1'],
      );
    });

    test('mixed trimmed/untrimmed spellings are not partially dropped', () {
      // The nastier half of the same bug: both spellings dedupe to ONE chip, so
      // selecting it must keep BOTH jobs. Dropping only the untrimmed one is a
      // silent partial drop — worse than a visible empty state.
      final List<FeedItem> jobs = <FeedItem>[
        _job('clean', 'welder', 'Welder', city: 'Pune'),
        _job('padded', 'welder', 'Welder', city: ' Pune '),
      ];
      expect(availableCities(jobs), <String>['Pune']);
      expect(
        _ids(applyJobFilters(jobs, _sel(cities: <String>{'Pune'}))),
        <String>['clean', 'padded'],
      );
    });
  });
}

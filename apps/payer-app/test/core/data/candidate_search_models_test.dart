import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/models.dart';

/// The all-candidates models beyond the fixture: the rung a card prints (the
/// same rule as payer-web's `shownTradeLevel`), the query's paging helpers,
/// defensive parsing, and when an unlock-history row counts as live.
CandidateTradeLevel _level(String skillId, String label, {String? skillLabel}) =>
    CandidateTradeLevel(
      skillId: skillId,
      skillLabel: skillLabel,
      tradeLevel: label.toLowerCase(),
      tradeLevelLabel: label,
      levelConfirmed: true,
    );

CandidateSearchRow _row(List<CandidateTradeLevel> levels) => CandidateSearchRow(
      workerId: 'w-1',
      matchesFilters: true,
      matchTier: null,
      role: const LabelledId(id: 'mskill_cnc_turner', label: 'CNC Turner'),
      otherRoles: const <LabelledId>[],
      skillMonths: 12,
      industry: null,
      industryMonths: null,
      city: null,
      tradeLevels: levels,
    );

void main() {
  group('leadTradeLevel — the one rung a card prints', () {
    test('none stated → no badge, never a placeholder', () {
      expect(_row(const <CandidateTradeLevel>[]).leadTradeLevel, isNull);
    });

    test('one stated rung is that rung', () {
      final CandidateTradeLevel only = _level('mskill_vmc_operator', 'Setter');
      expect(_row(<CandidateTradeLevel>[only]).leadTradeLevel, only);
    });

    test('several: the one on the lead role, by id first, then by label', () {
      final CandidateTradeLevel other = _level('mskill_vmc_operator', 'Operator');
      final CandidateTradeLevel byId = _level('mskill_cnc_turner', 'Setter');
      final CandidateTradeLevel byLabel =
          _level('mskill_turner_alias', 'Programmer', skillLabel: 'CNC Turner');
      expect(_row(<CandidateTradeLevel>[other, byLabel, byId]).leadTradeLevel,
          byId);
      expect(_row(<CandidateTradeLevel>[other, byLabel]).leadTradeLevel, byLabel);
    });

    test('several and none on the lead role → none (it would misstate him)', () {
      expect(
        _row(<CandidateTradeLevel>[
          _level('mskill_vmc_operator', 'Operator'),
          _level('mskill_fitter', 'Helper'),
        ]).leadTradeLevel,
        isNull,
      );
    });
  });

  group('CandidateSearchQuery', () {
    const CandidateSearchQuery q = CandidateSearchQuery(
      skillIds: <String>['mskill_cnc_turner'],
      city: 'Pune',
      strict: true,
    );

    test('after(cursor) keeps every filter; firstPage drops the cursor', () {
      final CandidateSearchQuery next = q.after('c-2');
      expect(next.cursor, 'c-2');
      expect(next.skillIds, q.skillIds);
      expect(next.city, 'Pune');
      expect(next.strict, isTrue);
      expect(next.firstPage(), q);
      expect(next.firstPage(strict: false).strict, isFalse);
    });

    test('counts the filter controls set; strict is a mode, not a filter', () {
      expect(q.filterCount, 2);
      expect(q.hasFilters, isTrue);
      expect(const CandidateSearchQuery(strict: true).hasFilters, isFalse);
    });
  });

  group('defensive parsing', () {
    test('a wrong-typed value reads as absent, never a crash', () {
      final CandidateSearchRow? row = CandidateSearchRow.tryFromJson(
        <String, dynamic>{
          'workerId': 'w-9',
          'matchesFilters': 'yes',
          'matchTier': 7,
          'role': <String, dynamic>{'id': 'mskill_fitter', 'label': 'Fitter'},
          'otherRoles': 'none',
          'skillMonths': '48',
          'industry': 42,
          'industryMonths': <int>[54],
          'city': 12,
          'tradeLevels': <dynamic>[
            <String, dynamic>{'tradeLevel': 'setter'},
          ],
          'isSample': 'true',
        },
      );

      expect(row, isNotNull);
      expect(row!.matchTier, isNull, reason: 'only 1 | 2 are tiers');
      expect(row.otherRoles, isEmpty);
      expect(row.skillMonths, 0);
      expect(row.industry, isNull);
      expect(row.industryMonths, isNull);
      expect(row.city, isNull);
      expect(row.tradeLevels, isEmpty, reason: 'a rung with no trade is dropped');
      expect(row.isSample, isFalse, reason: 'only a literal true marks a sample');
    });

    test('isSample (R74): true is a sample; absent reads as a real worker', () {
      CandidateSearchRow? parse(Map<String, dynamic> extra) =>
          CandidateSearchRow.tryFromJson(<String, dynamic>{
            'workerId': 'w-1',
            'role': <String, dynamic>{'id': 'r', 'label': 'R'},
            ...extra,
          });

      expect(parse(<String, dynamic>{'isSample': true})!.isSample, isTrue);
      expect(parse(<String, dynamic>{'isSample': false})!.isSample, isFalse);
      expect(parse(const <String, dynamic>{})!.isSample, isFalse);
    });

    test('a row with no worker id or no role is dropped', () {
      expect(
          CandidateSearchRow.tryFromJson(<String, dynamic>{
            'role': <String, dynamic>{'id': 'r', 'label': 'R'},
          }),
          isNull);
      expect(
          CandidateSearchRow.tryFromJson(<String, dynamic>{'workerId': 'w'}),
          isNull);
    });
  });

  group('PayerUnlock.isLiveAt', () {
    final DateTime now = DateTime.utc(2026, 11, 3, 12);

    test('granted/revealed inside the window; the boundary is not live', () {
      bool live(String status, String? until) => PayerUnlock(
            unlockId: 'u',
            workerId: 'w',
            status: status,
            expiresAt: until,
          ).isLiveAt(now);

      expect(live('granted', '2026-11-03T12:00:01Z'), isTrue);
      expect(live('revealed', '2026-11-10T00:00:00Z'), isTrue);
      expect(live('granted', null), isTrue, reason: 'no window recorded');
      expect(live('granted', '2026-11-03T12:00:00Z'), isFalse,
          reason: 'a grant is live only while expires_at > now');
      expect(live('expired', '2026-11-10T00:00:00Z'), isFalse);
      expect(live('revoked', null), isFalse);
    });
  });
}

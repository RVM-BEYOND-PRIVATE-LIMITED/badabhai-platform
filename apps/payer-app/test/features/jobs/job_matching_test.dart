import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/domain/job_matching.dart';

PostingTradeForm _trade({
  String roleKind = 'cnc_turner',
  String matchSkillId = 'mskill_cnc_turner',
}) =>
    PostingTradeForm(
      roleKind: roleKind,
      roleLabel: 'CNC Turner',
      packId: 'qp_$roleKind',
      matchSkillId: matchSkillId,
    );

JobPosting _job({
  String wire = 'open',
  String? roleKind = 'cnc_turner',
  String? city = 'Pune',
}) =>
    JobPosting(
      title: 'CNC Turner',
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: false,
      boosted: false,
      id: 'job-1',
      wireStatus: wire,
      roleKind: roleKind,
      city: city,
    );

const CandidateFilters _filters = CandidateFilters(
  roles: <CandidateRoleOption>[],
  industries: <LabelledId>[],
  experienceBuckets: <LabelledId>[],
  cities: <String>['Pune', 'Nashik'],
  maxRoles: 5,
);

void main() {
  group('matchingWorkersQuery', () {
    test('open job: the trade base skill, the listed city, strict on', () {
      final CandidateSearchQuery? query =
          matchingWorkersQuery(_job(), <PostingTradeForm>[_trade()], _filters);
      expect(query, isNotNull);
      expect(query!.skillIds, <String>['mskill_cnc_turner']);
      expect(query.city, 'Pune');
      expect(query.strict, isTrue);
    });

    test('the city is sent in the filters spelling, and dropped when unlisted',
        () {
      expect(
        matchingWorkersQuery(
          _job(city: 'pune'),
          <PostingTradeForm>[_trade()],
          _filters,
        )!
            .city,
        'Pune',
      );
      expect(
        matchingWorkersQuery(
          _job(city: 'Mumbai'),
          <PostingTradeForm>[_trade()],
          _filters,
        )!
            .city,
        isNull,
      );
    });

    test('a failed filters read leaves the city out, never the role', () {
      final CandidateSearchQuery? query =
          matchingWorkersQuery(_job(), <PostingTradeForm>[_trade()], null);
      expect(query!.city, isNull);
      expect(query.skillIds, <String>['mskill_cnc_turner']);
    });

    test('paused is offered; draft and closed are not', () {
      expect(
        matchingWorkersQuery(
            _job(wire: 'paused'), <PostingTradeForm>[_trade()], _filters),
        isNotNull,
      );
      for (final String wire in <String>['draft', 'closed']) {
        expect(
          matchingWorkersQuery(
              _job(wire: wire), <PostingTradeForm>[_trade()], _filters),
          isNull,
          reason: wire,
        );
      }
    });

    test('a role outside the 16 trades, or none, offers nothing', () {
      expect(
        matchingWorkersQuery(_job(roleKind: 'not_a_trade'),
            <PostingTradeForm>[_trade()], _filters),
        isNull,
      );
      expect(
        matchingWorkersQuery(
            _job(roleKind: null), <PostingTradeForm>[_trade()], _filters),
        isNull,
      );
    });
  });
}

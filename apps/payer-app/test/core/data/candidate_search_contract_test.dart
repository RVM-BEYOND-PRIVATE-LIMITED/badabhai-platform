import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/candidate_search_models.dart';

/// THE ALL-CANDIDATES CONTRACT (ADR-0040 E2) — the payer app's half of
/// `packages/types/fixtures/candidate-search-contract.json`, which the API
/// (`candidate-search.contract.test.ts`) and payer-web
/// (`candidate-search.contract.test.ts`) parse with their OWN parsers. All
/// three must agree on one wire example per route.
///
/// Read through the same `'../../packages/…'` relative path the worker app's
/// `job_card_contract_test.dart` uses (flutter test runs from the package root).
///
/// Two directions are pinned:
///  - RESPONSES: `tryFromJson` parses `response`, `emptyStrictResponse` and
///    `filters` field for field, and every key on the wire is one this parser
///    reads — "if a key is added here, all three parsers must learn it in the
///    same change", so a new fixture key fails here until it does.
///  - REQUESTS: `CandidateSearchQuery.toJson` reproduces each request example
///    byte for byte (snake_case; an unset filter omitted, so the unfiltered
///    first page is `{}`).
void main() {
  final Map<String, dynamic> fixture = jsonDecode(
    File('../../packages/types/fixtures/candidate-search-contract.json')
        .readAsStringSync(),
  ) as Map<String, dynamic>;

  test('the fixture is the version this suite reads, and names this file', () {
    expect(fixture['version'], 1);
    expect(
      fixture[r'$comment'] as String,
      contains(
          'apps/payer-app/test/core/data/candidate_search_contract_test.dart'),
    );
    expect(fixture['routes'], <String, dynamic>{
      'search': <String, dynamic>{
        'method': 'POST',
        'path': '/payer/candidates/search',
      },
      'filters': <String, dynamic>{
        'method': 'GET',
        'path': '/payer/candidates/filters',
      },
    });
  });

  group('response — CandidateSearchPage.tryFromJson', () {
    for (final String example in <String>['response', 'emptyStrictResponse']) {
      final Map<String, dynamic> wire = fixture[example] as Map<String, dynamic>;

      test('$example parses field for field', () {
        final CandidateSearchPage? page = CandidateSearchPage.tryFromJson(wire);

        expect(page, isNotNull, reason: 'the fixture IS the contract');
        expect(page!.total, wire['total']);
        expect(page.matched, wire['matched']);
        expect(page.unrecorded, wire['unrecorded']);
        expect(page.filtered, wire['filtered']);
        expect(page.strict, wire['strict']);
        expect(page.nextCursor, wire['nextCursor']);
        final List<Map<String, dynamic>> rows =
            (wire['candidates'] as List<dynamic>).cast<Map<String, dynamic>>();
        expect(page.candidates, hasLength(rows.length),
            reason: 'no fixture row may be dropped as unparseable');
        for (int i = 0; i < rows.length; i++) {
          _expectRow(page.candidates[i], rows[i]);
        }
      });

      test('$example carries no key this parser does not read', () {
        expect(wire.keys.toSet(), _pageKeys);
        for (final Map<String, dynamic> row
            in (wire['candidates'] as List<dynamic>)
                .cast<Map<String, dynamic>>()) {
          expect(row.keys.toSet(), _rowKeys);
          expect((row['role'] as Map<String, dynamic>).keys.toSet(),
              _labelledKeys);
          expect((row['industry'] as Map<String, dynamic>).keys.toSet(),
              _labelledKeys);
          for (final Object? other in row['otherRoles'] as List<dynamic>) {
            expect((other! as Map<String, dynamic>).keys.toSet(),
                _labelledKeys);
          }
          for (final Object? level in row['tradeLevels'] as List<dynamic>) {
            expect((level! as Map<String, dynamic>).keys.toSet(), _levelKeys);
          }
        }
      });
    }

    test('the response example exercises both nullable facts', () {
      // A fixture that never carried a null would let a parser that cannot
      // read one pass — check the example contains the thing it pins.
      final List<CandidateSearchRow> rows =
          CandidateSearchPage.tryFromJson(
                  fixture['response'] as Map<String, dynamic>)!
              .candidates;
      expect(rows.any((CandidateSearchRow r) => r.city == null), isTrue);
      expect(rows.any((CandidateSearchRow r) => r.industryMonths == null),
          isTrue);
      expect(rows.any((CandidateSearchRow r) => !r.matchesFilters), isTrue);
      expect(rows.any((CandidateSearchRow r) => r.matchTier == 2), isTrue);
      // R74: one real-shaped row and one sample, so a parser that ignores
      // the flag (always false) fails the field-for-field check above.
      expect(rows.any((CandidateSearchRow r) => r.isSample), isTrue);
      expect(rows.any((CandidateSearchRow r) => !r.isSample), isTrue);
    });
  });

  group('filters — CandidateFilters.tryFromJson', () {
    final Map<String, dynamic> wire = fixture['filters'] as Map<String, dynamic>;

    test('parses field for field', () {
      final CandidateFilters? f = CandidateFilters.tryFromJson(wire);

      expect(f, isNotNull);
      final List<Map<String, dynamic>> roles =
          (wire['roles'] as List<dynamic>).cast<Map<String, dynamic>>();
      expect(f!.roles, <CandidateRoleOption>[
        for (final Map<String, dynamic> r in roles)
          CandidateRoleOption(
            id: r['id'] as String,
            label: r['label'] as String,
            industryId: r['industryId'] as String,
          ),
      ]);
      expect(f.industries,
          (wire['industries'] as List<dynamic>).map(_labelled).toList());
      expect(f.experienceBuckets,
          (wire['experienceBuckets'] as List<dynamic>).map(_labelled).toList());
      expect(f.cities, (wire['cities'] as List<dynamic>).cast<String>());
      expect(f.maxRoles, wire['maxRoles']);
    });

    test('carries no key this parser does not read', () {
      expect(wire.keys.toSet(), _filtersKeys);
      for (final Object? r in wire['roles'] as List<dynamic>) {
        expect((r! as Map<String, dynamic>).keys.toSet(), _roleOptionKeys);
      }
      for (final String list in <String>['industries', 'experienceBuckets']) {
        for (final Object? o in wire[list] as List<dynamic>) {
          expect((o! as Map<String, dynamic>).keys.toSet(), _labelledKeys);
        }
      }
    });
  });

  group('requests — CandidateSearchQuery.toJson', () {
    final List<Map<String, dynamic>> requests =
        (fixture['requests'] as List<dynamic>).cast<Map<String, dynamic>>();

    test('the fixture still holds the unfiltered and the every-filter body', () {
      expect(requests, hasLength(greaterThanOrEqualTo(2)));
      expect(requests.first['body'], isEmpty);
      expect((requests.last['body'] as Map<String, dynamic>).keys.toSet(),
          _requestKeys,
          reason: 'one example sends every key the app can send');
    });

    for (final Map<String, dynamic> request in requests) {
      final Map<String, dynamic> body = request['body'] as Map<String, dynamic>;

      test('reproduces "${request['name']}" byte for byte', () {
        final CandidateSearchQuery query = _queryFrom(body);

        expect(query.toJson(), body);
        // …and survives the JSON encode the transport applies.
        expect(jsonDecode(jsonEncode(query.toJson())), body);
      });
    }

    test('the default query is the unfiltered first page: {}', () {
      expect(const CandidateSearchQuery().toJson(), <String, dynamic>{});
    });
  });
}

const Set<String> _pageKeys = <String>{
  'total',
  'matched',
  'unrecorded',
  'filtered',
  'strict',
  'candidates',
  'nextCursor',
};

const Set<String> _rowKeys = <String>{
  'workerId',
  'matchesFilters',
  'matchTier',
  'role',
  'otherRoles',
  'skillMonths',
  'industry',
  'industryMonths',
  'city',
  'tradeLevels',
  'isSample',
};

const Set<String> _levelKeys = <String>{
  'skillId',
  'skillLabel',
  'tradeLevel',
  'tradeLevelLabel',
  'levelConfirmed',
};

const Set<String> _labelledKeys = <String>{'id', 'label'};

const Set<String> _roleOptionKeys = <String>{'id', 'label', 'industryId'};

const Set<String> _filtersKeys = <String>{
  'roles',
  'industries',
  'experienceBuckets',
  'cities',
  'maxRoles',
};

/// Every body key [CandidateSearchQuery] can send.
const Set<String> _requestKeys = <String>{
  'skill_ids',
  'experience',
  'industry_id',
  'industry_experience',
  'city',
  'strict',
  'limit',
  'cursor',
};

LabelledId _labelled(Object? json) {
  final Map<String, dynamic> m = json! as Map<String, dynamic>;
  return LabelledId(id: m['id'] as String, label: m['label'] as String);
}

void _expectRow(CandidateSearchRow r, Map<String, dynamic> w) {
  expect(r.workerId, w['workerId']);
  expect(r.matchesFilters, w['matchesFilters']);
  expect(r.matchTier, w['matchTier']);
  expect(r.role, _labelled(w['role']));
  expect(r.otherRoles, (w['otherRoles'] as List<dynamic>).map(_labelled).toList());
  expect(r.skillMonths, w['skillMonths']);
  expect(r.industry, _labelled(w['industry']));
  expect(r.industryMonths, w['industryMonths']);
  expect(r.city, w['city']);
  expect(w['isSample'], isA<bool>(), reason: 'always present on the wire');
  expect(r.isSample, w['isSample']);
  final List<Map<String, dynamic>> levels =
      (w['tradeLevels'] as List<dynamic>).cast<Map<String, dynamic>>();
  expect(r.tradeLevels, hasLength(levels.length));
  for (int i = 0; i < levels.length; i++) {
    final CandidateTradeLevel l = r.tradeLevels[i];
    expect(l.skillId, levels[i]['skillId']);
    expect(l.skillLabel, levels[i]['skillLabel']);
    expect(l.tradeLevel, levels[i]['tradeLevel']);
    expect(l.tradeLevelLabel, levels[i]['tradeLevelLabel']);
    expect(l.levelConfirmed, levels[i]['levelConfirmed']);
  }
}

/// A fixture request body → the query the app would build. Throws on a key the
/// app cannot send, so a request field added to the contract fails here.
CandidateSearchQuery _queryFrom(Map<String, dynamic> body) {
  final Set<String> unknown = body.keys.toSet().difference(_requestKeys);
  if (unknown.isNotEmpty) {
    fail('request keys the payer app cannot send: $unknown');
  }
  return CandidateSearchQuery(
    skillIds: (body['skill_ids'] as List<dynamic>?)?.cast<String>() ??
        const <String>[],
    experience: body['experience'] as String?,
    industryId: body['industry_id'] as String?,
    industryExperience: body['industry_experience'] as String?,
    city: body['city'] as String?,
    strict: body['strict'] as bool? ?? false,
    limit: body['limit'] as int?,
    cursor: body['cursor'] as String?,
  );
}

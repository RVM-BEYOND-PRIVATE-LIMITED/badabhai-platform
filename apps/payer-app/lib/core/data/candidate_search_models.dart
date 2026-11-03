import 'package:equatable/equatable.dart';

import '../util/name_mask.dart';

/// Wire models for the payer's ALL-CANDIDATES search (ADR-0040, phase E2; owner
/// rulings 2026-11-03): `POST /payer/candidates/search` and
/// `GET /payer/candidates/filters`.
///
/// WIRE CONVENTION, matching the routes beside it: the request BODY is
/// snake_case ([CandidateSearchQuery.toJson]), the RESPONSE camelCase (the
/// `tryFromJson` parsers). `packages/types/fixtures/candidate-search-contract.json`
/// pins both halves for the API, payer-web and this app;
/// `test/core/data/candidate_search_contract_test.dart` parses it with these
/// parsers, so a key added there fails here until this file learns it.
///
/// MASKED BY CONSTRUCTION: a row holds closed-vocabulary ids/labels, bucketed
/// months, a gazetteer city and the stated trade rungs — never a name, phone,
/// photo, employer, salary, address or free text. There is no field to put one
/// in. Identity stays behind `POST /payer/unlocks` (1 credit).
///
/// PARSING IS DEFENSIVE, the house style: a wrong-typed value reads as absent,
/// never a crash. Only what the screen cannot do without fails — a page with no
/// counts or no row list is a contract error (the caller shows an error, never
/// an empty pool), and a row with no worker id or no role is dropped (nothing
/// could unlock or describe it).

String? _string(Object? v) => v is String && v.isNotEmpty ? v : null;

int? _int(Object? v) => v is num && v.isFinite ? v.toInt() : null;

List<Object?> _list(Object? v) => v is List<dynamic> ? v : const <Object?>[];

/// A closed-vocabulary id with its display label (a role, an industry, an
/// experience bucket).
class LabelledId extends Equatable {
  const LabelledId({required this.id, required this.label});

  final String id;
  final String label;

  /// Null when the object lacks an id or a label — a nameless option can be
  /// neither shown nor sent.
  static LabelledId? tryFromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final String? id = _string(json['id']);
    final String? label = _string(json['label']);
    if (id == null || label == null) return null;
    return LabelledId(id: id, label: label);
  }

  @override
  List<Object?> get props => <Object?>[id, label];
}

/// A role the filter offers, with the industry it belongs to.
class CandidateRoleOption extends Equatable {
  const CandidateRoleOption({
    required this.id,
    required this.label,
    required this.industryId,
  });

  final String id;
  final String label;
  final String industryId;

  static CandidateRoleOption? tryFromJson(Object? json) {
    final LabelledId? base = LabelledId.tryFromJson(json);
    if (base == null) return null;
    return CandidateRoleOption(
      id: base.id,
      label: base.label,
      industryId: _string((json as Map<String, dynamic>)['industryId']) ?? '',
    );
  }

  @override
  List<Object?> get props => <Object?>[id, label, industryId];
}

/// One rung a worker stated on a trade — the applicant card's own badge source
/// (`TradeLevelBadge`). Display only: it never ranks, filters or prices.
class CandidateTradeLevel extends Equatable {
  const CandidateTradeLevel({
    required this.skillId,
    required this.skillLabel,
    required this.tradeLevel,
    required this.tradeLevelLabel,
    required this.levelConfirmed,
  });

  /// The trade the rung sits on (an `mskill_*` id).
  final String skillId;

  /// The trade's label, null when the taxonomy does not know it.
  final String? skillLabel;

  /// The stored rung key.
  final String tradeLevel;

  /// The printed rung ("Setter"); the server falls back to the raw key.
  final String tradeLevelLabel;

  /// True once the separating question was answered (Setter and above only).
  final bool levelConfirmed;

  static CandidateTradeLevel? tryFromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final String? skillId = _string(json['skillId']);
    final String? level = _string(json['tradeLevel']);
    if (skillId == null || level == null) return null;
    return CandidateTradeLevel(
      skillId: skillId,
      skillLabel: _string(json['skillLabel']),
      tradeLevel: level,
      tradeLevelLabel: _string(json['tradeLevelLabel']) ?? level,
      levelConfirmed: json['levelConfirmed'] == true,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[skillId, skillLabel, tradeLevel, tradeLevelLabel, levelConfirmed];
}

/// One MASKED candidate from `POST /payer/candidates/search`.
class CandidateSearchRow extends Equatable {
  const CandidateSearchRow({
    required this.workerId,
    required this.matchesFilters,
    required this.matchTier,
    required this.role,
    required this.otherRoles,
    required this.skillMonths,
    required this.industry,
    required this.industryMonths,
    required this.city,
    required this.tradeLevels,
  });

  /// The opaque worker id — the SAME id `POST /payer/unlocks` takes.
  final String workerId;

  /// ADR-0040 `filter_match`: every supplied filter matched (or was not
  /// recorded). Always true unfiltered. The list leads with these.
  final bool matchesFilters;

  /// Only with a role filter: 1 = holds a picked role, 2 = holds one RELATED to
  /// it ([role] names which), null = neither, or no role filter.
  final int? matchTier;

  /// The role the card leads with.
  final LabelledId role;

  /// His other wanted roles, most experienced first (the server sends ≤4).
  final List<LabelledId> otherRoles;

  /// Months on [role], bucketed to 6 (never exact).
  final int skillMonths;

  /// The industry of [role] (or the filtered one). Null only on a broken row.
  final LabelledId? industry;

  /// Calendar months in [industry], floored to 6; null = not recorded.
  final int? industryMonths;

  /// The worker's own city; null = not recorded.
  final String? city;

  final List<CandidateTradeLevel> tradeLevels;

  /// "Worker ••3f9a" — the same masked handle the applicant card shows.
  String get maskedLabel => NameMask.workerLabel(workerId);

  /// The ONE rung the card prints — display only, never a rank input. The same
  /// rule as payer-web's `shownTradeLevel` (`apps/payer-web/src/lib/
  /// trade-level.ts`), shared there by the applicant card and this card: one
  /// stated rung is that rung; with several, the one on [role] (by id, else by
  /// label — two vocabulary ids can share one); with several and none on
  /// [role], none (a rung for a different trade would misstate him).
  CandidateTradeLevel? get leadTradeLevel {
    if (tradeLevels.isEmpty) return null;
    if (tradeLevels.length == 1) return tradeLevels.single;
    for (final CandidateTradeLevel level in tradeLevels) {
      if (level.skillId == role.id) return level;
    }
    for (final CandidateTradeLevel level in tradeLevels) {
      if (level.skillLabel == role.label) return level;
    }
    return null;
  }

  /// Null for a row this screen could neither describe nor unlock (no worker
  /// id, or no lead role).
  static CandidateSearchRow? tryFromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final String? workerId = _string(json['workerId']);
    final LabelledId? role = LabelledId.tryFromJson(json['role']);
    if (workerId == null || role == null) return null;
    final int? tier = _int(json['matchTier']);
    return CandidateSearchRow(
      workerId: workerId,
      // Absent reads as a match: an unknown never draws the "Other candidates"
      // line above a row the server did not mark as one.
      matchesFilters: json['matchesFilters'] != false,
      matchTier: tier == 1 || tier == 2 ? tier : null,
      role: role,
      otherRoles: List<LabelledId>.unmodifiable(
        _list(json['otherRoles'])
            .map(LabelledId.tryFromJson)
            .whereType<LabelledId>(),
      ),
      skillMonths: _int(json['skillMonths']) ?? 0,
      industry: LabelledId.tryFromJson(json['industry']),
      industryMonths: _int(json['industryMonths']),
      city: _string(json['city']),
      tradeLevels: List<CandidateTradeLevel>.unmodifiable(
        _list(json['tradeLevels'])
            .map(CandidateTradeLevel.tryFromJson)
            .whereType<CandidateTradeLevel>(),
      ),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        workerId,
        matchesFilters,
        matchTier,
        role,
        otherRoles,
        skillMonths,
        industry,
        industryMonths,
        city,
        tradeLevels,
      ];
}

/// One page of the search: the rows plus the THREE counts the badge reads
/// (ADR-0040 Decision 3 — rendered from this same response, never folded).
class CandidateSearchPage extends Equatable {
  const CandidateSearchPage({
    required this.total,
    required this.matched,
    required this.unrecorded,
    required this.filtered,
    required this.strict,
    required this.candidates,
    required this.nextCursor,
  });

  /// The eligible pool — never the whole worker table.
  final int total;

  /// Candidates whose RECORDED values match every supplied filter.
  final int matched;

  /// Kept only because a filtered field is unrecorded — never in [matched].
  final int unrecorded;

  /// True when any filter was supplied.
  final bool filtered;

  /// Echo of the request's mode.
  final bool strict;

  final List<CandidateSearchRow> candidates;

  /// Pass back as the next request's cursor; null on the last page.
  final String? nextCursor;

  /// Null when the body is not the contract: a missing count, flag or row
  /// list. `PayerHttp` decodes a 2xx captive-portal page to `{}`, and that must
  /// surface as an error — never as "nobody on the portal" (#370).
  static CandidateSearchPage? tryFromJson(Map<String, dynamic> json) {
    final int? total = _int(json['total']);
    final int? matched = _int(json['matched']);
    final int? unrecorded = _int(json['unrecorded']);
    final Object? filtered = json['filtered'];
    final Object? strict = json['strict'];
    final Object? rows = json['candidates'];
    if (total == null ||
        matched == null ||
        unrecorded == null ||
        filtered is! bool ||
        strict is! bool ||
        rows is! List<dynamic>) {
      return null;
    }
    return CandidateSearchPage(
      total: total,
      matched: matched,
      unrecorded: unrecorded,
      filtered: filtered,
      strict: strict,
      candidates: List<CandidateSearchRow>.unmodifiable(
        rows.map(CandidateSearchRow.tryFromJson).whereType<CandidateSearchRow>(),
      ),
      nextCursor: _string(json['nextCursor']),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        total,
        matched,
        unrecorded,
        filtered,
        strict,
        candidates,
        nextCursor,
      ];
}

/// `GET /payer/candidates/filters` — the options the filter controls offer.
/// Served by the API so the app keeps no copy of the vocabulary.
class CandidateFilters extends Equatable {
  const CandidateFilters({
    required this.roles,
    required this.industries,
    required this.experienceBuckets,
    required this.cities,
    required this.maxRoles,
  });

  final List<CandidateRoleOption> roles;
  final List<LabelledId> industries;

  /// One closed list for BOTH experience filters (role and industry).
  final List<LabelledId> experienceBuckets;

  /// The cities the eligible pool actually records, A→Z.
  final List<String> cities;

  /// The most roles one search may name. This app sends at most one (a single
  /// Role select), which every value here admits.
  final int maxRoles;

  String? roleLabel(String id) {
    for (final CandidateRoleOption r in roles) {
      if (r.id == id) return r.label;
    }
    return null;
  }

  String? industryLabel(String id) => _labelIn(industries, id);

  String? bucketLabel(String id) => _labelIn(experienceBuckets, id);

  static String? _labelIn(List<LabelledId> options, String id) {
    for (final LabelledId o in options) {
      if (o.id == id) return o.label;
    }
    return null;
  }

  /// Null when an option list is missing — the same captive-portal `{}` rule as
  /// [CandidateSearchPage.tryFromJson].
  static CandidateFilters? tryFromJson(Map<String, dynamic> json) {
    final Object? roles = json['roles'];
    final Object? industries = json['industries'];
    final Object? buckets = json['experienceBuckets'];
    final Object? cities = json['cities'];
    if (roles is! List<dynamic> ||
        industries is! List<dynamic> ||
        buckets is! List<dynamic> ||
        cities is! List<dynamic>) {
      return null;
    }
    return CandidateFilters(
      roles: List<CandidateRoleOption>.unmodifiable(
        roles.map(CandidateRoleOption.tryFromJson).whereType<CandidateRoleOption>(),
      ),
      industries: List<LabelledId>.unmodifiable(
        industries.map(LabelledId.tryFromJson).whereType<LabelledId>(),
      ),
      experienceBuckets: List<LabelledId>.unmodifiable(
        buckets.map(LabelledId.tryFromJson).whereType<LabelledId>(),
      ),
      cities: List<String>.unmodifiable(
        cities.whereType<String>().where((String c) => c.isNotEmpty),
      ),
      maxRoles: _int(json['maxRoles']) ?? 1,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[roles, industries, experienceBuckets, cities, maxRoles];
}

/// The search body — the payer's filters plus the paging position.
///
/// FILTERS REORDER BY DEFAULT (ADR-0040 Decision 1): matches lead, nobody is
/// removed. [strict] (Decision 2) is the explicit opt-in that drops the
/// non-matching rows instead; it is never remembered between visits.
///
/// NO `payer_id`, anywhere (XB-A) — the payer is the verified session.
class CandidateSearchQuery extends Equatable {
  const CandidateSearchQuery({
    this.skillIds = const <String>[],
    this.experience,
    this.industryId,
    this.industryExperience,
    this.city,
    this.strict = false,
    this.limit,
    this.cursor,
  });

  /// The picked roles. The app offers a single Role select, so at most one.
  final List<String> skillIds;

  /// An experience-bucket id for the years on the lead role.
  final String? experience;
  final String? industryId;

  /// An experience-bucket id for the years in the industry.
  final String? industryExperience;
  final String? city;
  final bool strict;

  /// Page size; null leaves it to the server (20).
  final int? limit;

  /// The previous page's `nextCursor`, untouched. A position in the order of
  /// the filters that minted it — any filter change starts from the top.
  final String? cursor;

  /// True when any filter is set ([strict] is a mode, not a filter).
  bool get hasFilters =>
      skillIds.isNotEmpty ||
      experience != null ||
      industryId != null ||
      industryExperience != null ||
      city != null;

  /// How many filter controls are set — the count on the Filters button.
  int get filterCount => <bool>[
        skillIds.isNotEmpty,
        experience != null,
        industryId != null,
        industryExperience != null,
        city != null,
      ].where((bool set) => set).length;

  /// The same search, read from [nextCursor] on.
  CandidateSearchQuery after(String nextCursor) => CandidateSearchQuery(
        skillIds: skillIds,
        experience: experience,
        industryId: industryId,
        industryExperience: industryExperience,
        city: city,
        strict: strict,
        limit: limit,
        cursor: nextCursor,
      );

  /// The same filters from the first page, in [strict] mode or not.
  CandidateSearchQuery firstPage({bool? strict}) => CandidateSearchQuery(
        skillIds: skillIds,
        experience: experience,
        industryId: industryId,
        industryExperience: industryExperience,
        city: city,
        strict: strict ?? this.strict,
        limit: limit,
      );

  /// The snake_case POST body. An unset filter is OMITTED, never sent as null
  /// or `[]`, so the unfiltered first page is `{}` — the contract's first
  /// request example, byte for byte.
  Map<String, dynamic> toJson() => <String, dynamic>{
        if (skillIds.isNotEmpty) 'skill_ids': List<String>.of(skillIds),
        if (experience != null) 'experience': experience,
        if (industryId != null) 'industry_id': industryId,
        if (industryExperience != null) 'industry_experience': industryExperience,
        if (city != null) 'city': city,
        if (strict) 'strict': true,
        if (limit != null) 'limit': limit,
        if (cursor != null) 'cursor': cursor,
      };

  @override
  List<Object?> get props => <Object?>[
        skillIds,
        experience,
        industryId,
        industryExperience,
        city,
        strict,
        limit,
        cursor,
      ];
}

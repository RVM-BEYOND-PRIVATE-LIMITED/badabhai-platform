import 'package:equatable/equatable.dart';

/// One OPEN job returned by `GET /jobs/search` — the Indeed-style title + city +
/// state search (a worker types "CNC operator" + "Kota, Rajasthan").
///
/// A strict PII-FREE mirror of [FeedItem] (core/api/api_models.dart): coarse
/// title / place, the year-count experience window, the nullable pay band and
/// coarse shift enum — and NEVER anything employer-shaped (employer names are
/// PII, CLAUDE.md §2; the search response carries no company, exactly like the
/// feed). It ADDS two fields the search surface needs that the feed did not
/// carry: [state] (search is location-first, so the matched state is shown to
/// confirm the location) and [publishedAt] (freshness of the posting).
///
/// Parsing is defensive: an absent key and an explicit null both land on the
/// honest empty value, so a contract that grows a key — or a slightly older
/// server that omits one — can never crash the search flow.
class JobSearchItem extends Equatable {
  const JobSearchItem({
    required this.jobId,
    required this.title,
    required this.city,
    this.state = '',
    this.area,
    this.payMin,
    this.payMax,
    this.shift,
    this.minExperienceYears,
    this.maxExperienceYears,
    this.matchedSkillLabel,
    this.publishedAt,
  });

  final String jobId;
  final String title;
  final String city;

  /// The job's state (e.g. "Rajasthan"). Search matches on state, so it is
  /// surfaced on the card to confirm the location the worker asked for. "" when
  /// the server omitted it (never null — the place line treats "" as absent).
  final String state;

  /// Coarse area/locality bucket. Nullable — not every job has one.
  final String? area;

  /// Monthly pay band in ₹, PII-free by the schema's own rule. Either bound may
  /// be null (a one-sided band); both null = the employer stated no pay, and the
  /// card then hides the salary rather than inventing one.
  final int? payMin;
  final int? payMax;

  /// Coarse shift enum as the RAW wire string ('day' | 'night' | 'rotational'),
  /// or null when unstated. Display mapping lives in core/util/job_display.dart.
  final String? shift;

  /// Experience window the job targets, in YEAR COUNTS — passed through honestly,
  /// nulls included: a null [minExperienceYears] means "no floor" and a null
  /// [maxExperienceYears] means "open-ended". Never coerce a null to 0.
  final int? minExperienceYears;
  final int? maxExperienceYears;

  /// The closed-set skill/title label the backend matched the query against
  /// (e.g. "CNC Operator"). A server-owned label, never free text; null when the
  /// server did not name it.
  final String? matchedSkillLabel;

  /// When the posting was published (`published_at`), or null when the server
  /// omitted it or the value did not parse. Kept as a real [DateTime] so the UI
  /// can format freshness; a bad/absent value degrades to null, never a crash.
  final DateTime? publishedAt;

  factory JobSearchItem.fromJson(Map<String, dynamic> json) => JobSearchItem(
        jobId: json['job_id'] as String? ?? '',
        title: json['title'] as String? ?? '',
        city: json['city'] as String? ?? '',
        // The server may send null or omit the key — both read as "" (absent),
        // so the place line and the equality never see a null state.
        state: json['state'] as String? ?? '',
        area: json['area'] as String?,
        payMin: (json['pay_min'] as num?)?.toInt(),
        payMax: (json['pay_max'] as num?)?.toInt(),
        shift: json['shift'] as String?,
        minExperienceYears: (json['min_experience_years'] as num?)?.toInt(),
        maxExperienceYears: (json['max_experience_years'] as num?)?.toInt(),
        matchedSkillLabel: json['matched_skill_label'] as String?,
        publishedAt: _parseDate(json['published_at']),
      );

  /// "Area, City, State" with the empty parts dropped — never a trailing comma
  /// and never an invented placeholder. Search spans states, so the state is
  /// worth showing when present.
  String get place => <String>[
        if (area != null && area!.isNotEmpty) area!,
        if (city.isNotEmpty) city,
        if (state.isNotEmpty) state,
      ].join(', ');

  /// Tolerant ISO-8601 parse: a non-string, empty, or malformed value → null
  /// (the card simply omits the freshness line) rather than throwing.
  static DateTime? _parseDate(Object? raw) {
    if (raw is! String || raw.isEmpty) return null;
    return DateTime.tryParse(raw);
  }

  @override
  List<Object?> get props => <Object?>[
        jobId,
        title,
        city,
        state,
        area,
        payMin,
        payMax,
        shift,
        minExperienceYears,
        maxExperienceYears,
        matchedSkillLabel,
        publishedAt,
      ];
}

/// One page of `GET /jobs/search` results, mirroring the response envelope
/// `{ jobs: [...], page, limit, has_more }`. [hasMore] drives the client's
/// load-more: the cubit stops paging when it is false. Defensive over every
/// envelope field so a partial/older response degrades instead of crashing.
class JobSearchPage extends Equatable {
  const JobSearchPage({
    required this.items,
    required this.page,
    required this.limit,
    required this.hasMore,
  });

  final List<JobSearchItem> items;
  final int page;
  final int limit;
  final bool hasMore;

  factory JobSearchPage.fromJson(Map<String, dynamic> json) {
    final List<dynamic> raw = json['jobs'] as List<dynamic>? ?? <dynamic>[];
    return JobSearchPage(
      items: raw
          .whereType<Map<String, dynamic>>()
          .map(JobSearchItem.fromJson)
          .toList(),
      page: (json['page'] as num?)?.toInt() ?? 1,
      limit: (json['limit'] as num?)?.toInt() ?? 20,
      hasMore: json['has_more'] as bool? ?? false,
    );
  }

  @override
  List<Object?> get props => <Object?>[items, page, limit, hasMore];
}

import 'package:equatable/equatable.dart';

/// The REAL facts about a job, exactly as the worker-facing routes serve them —
/// nothing is synthesised client-side.
///
/// Two shapes share this class:
///   * the LIGHT detail (jobId/title/city/area, plus the opening surface's own
///     [applicationAction] when it knows one) built from a `GET /feed` /
///     applications row, handed to the detail screen for an instant header;
///   * the FULL detail parsed from `GET /jobs/:jobId` (the ADR-0024 addendum,
///     2026-07-16), which adds pay band, experience window, needed-by, shift,
///     description, requirements and benefits — all nullable, all passed
///     through honestly. A null field means the employer never stated it and
///     the screen HIDES that row rather than inventing a value.
///
/// EMPLOYER IDENTITY IS DELIBERATELY ABSENT — per the ADR-0024 addendum
/// (2026-07-16) ruling, the worker surface hides the employer entirely: no
/// company name, no masked descriptor, nothing employer-shaped. Employer names
/// are PII (CLAUDE.md §2) and the backend never sends one; [JobDetail.fromJson]
/// parses NAMED KEYS ONLY, so even a contract-violating `payer_id`/`company`
/// key in the body can never land in app state. An earlier build invented an
/// employer and pay band from `jobId.hashCode` and rendered them as fact (with
/// a "verified" badge) — do NOT reintroduce any employer-shaped field here.
class JobDetail extends Equatable {
  const JobDetail({
    required this.jobId,
    required this.title,
    this.city,
    this.area,
    this.applicationAction,
    this.sourceSurface = 'feed',
    this.tradeKey,
    this.roleKind,
    this.payMin,
    this.payMax,
    this.payType,
    this.minExperienceYears,
    this.maxExperienceYears,
    this.neededBy,
    this.shift,
    this.description,
    this.benefits,
    this.requirements,
  });

  /// Parses the `GET /jobs/:jobId` body. Defensive: reads NAMED keys only
  /// (unknown keys — including anything employer-shaped — are ignored), keeps
  /// nulls honest (absent key and explicit null both land on null), and
  /// normalises an empty/blank string list to null so the screen's
  /// "null hides the row" rule needs no second empty-check.
  ///
  /// Deliberately WIRE-ONLY: [applicationAction] is never parsed here — the
  /// jobs route doesn't carry the worker's decision. The opening surface owns
  /// it; the fetch-swap reattaches it via [withApplicationAction].
  factory JobDetail.fromJson(Map<String, dynamic> json) {
    return JobDetail(
      jobId: json['job_id'] as String,
      title: json['title'] as String? ?? '',
      city: json['city'] as String?,
      area: json['area'] as String?,
      tradeKey: json['trade_key'] as String?,
      // #2009 — `role_kind` keys the detail's ROLE ILLUSTRATION. Read as a
      // String and nothing else: the server sends one of the 21 declared kinds
      // or null, but a number or an object must land on null rather than reach
      // a widget, and an unknown slug is the art resolver's problem, not the
      // parser's (it draws `generic`).
      roleKind: json['role_kind'] is String
          ? json['role_kind'] as String
          : null,
      payMin: (json['pay_min'] as num?)?.toInt(),
      payMax: (json['pay_max'] as num?)?.toInt(),
      payType: json['pay_type'] as String?,
      minExperienceYears: (json['min_experience_years'] as num?)?.toInt(),
      maxExperienceYears: (json['max_experience_years'] as num?)?.toInt(),
      neededBy: json['needed_by'] as String?,
      shift: json['shift'] as String?,
      description: json['description'] as String?,
      benefits: _stringList(json['benefits']),
      requirements: _stringList(json['requirements']),
    );
  }

  final String jobId;

  /// Real posting title.
  final String title;

  /// Real city; null when the source omits it.
  final String? city;

  /// Coarse area/locality bucket. Nullable — not every job has one.
  final String? area;

  /// The worker's OWN recorded decision on this job, when the opening surface
  /// knows it — the real `action` value from GET /workers/me/applications
  /// ('applied' | 'skipped'). Null when the job arrived from the feed (which,
  /// post-WA-1, only serves undecided jobs). The detail screen gates its CTA on
  /// this: an already-applied job shows its status, never an apply action.
  final String? applicationAction;

  /// True when the worker has already applied — the detail screen must render
  /// the applied status instead of the "Apply karein" CTA (WA-2).
  bool get alreadyApplied => applicationAction == 'applied';

  /// WHERE the worker opened this job from — the API's `source_surface` enum
  /// ('feed' | 'search' | 'share' | 'other'), client-attached by the opening
  /// surface. The detail apply records it so an apply started from SEARCH is not
  /// miscredited to the feed (#1906). Defaults to 'feed' (the deck path); never
  /// parsed from the wire.
  final String sourceSurface;

  /// One of the 15 alpha trades — kept as a plain String (no enum). Null on
  /// the light detail.
  final String? tradeKey;

  /// #2009 — the posting's role kind, one of `TRADE_FORM_KINDS_ALL` or null.
  /// ART, NEVER TEXT: it keys the role illustration and is never drawn as a
  /// word, so a slug can't leak onto a worker-facing screen. Null, unknown or
  /// wrong-cased draws the generic scene.
  final String? roleKind;

  /// Monthly pay band in ₹, PII-free by the schema's own rule ("pay bands /
  /// year counts / a coarse timing enum — never an employer"). Either bound
  /// may be null (one-sided band); both null = employer stated no pay.
  final int? payMin;
  final int? payMax;

  /// What the band MEANS as the poster stated it — the raw wire enum
  /// ('in_hand' | 'gross' | 'ctc'), or null when unstated (#1648). Display
  /// mapping is `payTypeLabel`; the screen shows nothing when it is null.
  final String? payType;

  /// Experience window in YEAR COUNTS, passed through honestly, nulls
  /// included: null min = "no floor", null max = "open-ended". Never coerce a
  /// null to 0 (that would invent a floor the employer never set).
  final int? minExperienceYears;
  final int? maxExperienceYears;

  /// Coarse timing enum: 'immediate' | 'soon' | 'flexible' | null.
  final String? neededBy;

  /// Coarse shift enum: 'day' | 'night' | 'rotational' | null. Kept as the raw
  /// wire string; display mapping lives in core/util/job_display.dart.
  final String? shift;

  /// Free-text posting description (already PII-screened server-side). Null
  /// when the employer wrote none.
  final String? description;

  /// Benefit lines (e.g. "PF + ESI"). Null = none stated (an empty wire list
  /// is normalised to null in [JobDetail.fromJson]).
  final List<String>? benefits;

  /// Requirement tags (e.g. "Fanuc control"). Null = none stated.
  final List<String>? requirements;

  /// A full copy with [applicationAction] set to [action] and EVERY other
  /// field preserved. The `GET /jobs/:jobId` body never carries the worker's
  /// decision, so when the fetched full detail replaces the light one the
  /// cubit reattaches the opening surface's decision with this — otherwise
  /// the WA-2 applied-CTA gate would be silently wiped by the fetch.
  JobDetail withApplicationAction(String? action) {
    return JobDetail(
      jobId: jobId,
      title: title,
      city: city,
      area: area,
      applicationAction: action,
      sourceSurface: sourceSurface,
      tradeKey: tradeKey,
      roleKind: roleKind,
      payMin: payMin,
      payMax: payMax,
      // `payType` was absent here, so every fetch-swap silently reset it to
      // null and the detail's pay line lost its unit. Carried now — the swap
      // only replaces the worker's decision, never wire facts.
      payType: payType,
      minExperienceYears: minExperienceYears,
      maxExperienceYears: maxExperienceYears,
      neededBy: neededBy,
      shift: shift,
      description: description,
      benefits: benefits,
      requirements: requirements,
    );
  }

  /// "Area, City" when both are present; otherwise whichever exists; null when
  /// neither does — the screen then renders no location line at all rather than
  /// inventing a placeholder.
  String? get place {
    final String? c = (city?.isNotEmpty ?? false) ? city : null;
    final String? a = (area?.isNotEmpty ?? false) ? area : null;
    if (a != null && c != null) return '$a, $c';
    return c ?? a;
  }

  static List<String>? _stringList(Object? raw) {
    if (raw is! List) return null;
    final List<String> items = raw
        .whereType<String>()
        .map((String s) => s.trim())
        .where((String s) => s.isNotEmpty)
        .toList();
    return items.isEmpty ? null : items;
  }

  @override
  List<Object?> get props => <Object?>[
        jobId,
        title,
        city,
        area,
        applicationAction,
        sourceSurface,
        tradeKey,
        roleKind,
        payMin,
        payMax,
        payType,
        minExperienceYears,
        maxExperienceYears,
        neededBy,
        shift,
        description,
        benefits,
        requirements,
      ];
}

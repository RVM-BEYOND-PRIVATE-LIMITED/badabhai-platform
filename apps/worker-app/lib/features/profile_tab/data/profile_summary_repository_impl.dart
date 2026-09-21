import '../../../core/api/api_client.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/profile_summary.dart';
import '../domain/profile_summary_repository.dart';

/// Live profile-summary source: GET /workers/me/profile-summary via [ApiClient]
/// (worker-scoped; the token is taken from the session).
///
/// PII posture (CLAUDE.md §2): the payload carries `city` (PII) and NO name (the
/// name is an open §2 escalation, deliberately omitted server-side). The city is
/// NEVER logged here, and a missing name is NEVER fabricated — it maps to a null
/// [ProfileSummary.displayName] and the header renders name-free. Failures are
/// mapped to a typed [Failure] so the tab shows the real reason, not a spinner.
class ProfileSummaryRepositoryImpl implements ProfileSummaryRepository {
  const ProfileSummaryRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<ProfileSummary> summary({bool includeDisplayExtras = false}) async {
    try {
      // ONE wave, not two: the extras never read the core DTO, so they start
      // in the SAME tick. Awaiting the core first and the extras second
      // doubles the settle latency — in production a slower first paint, in
      // widget tests a read still in flight at teardown (a pending-timer
      // failure). Reads started together settle together, before `ready`
      // emits. Each extra is fail-null on its own (see [_optional]), so one
      // dead endpoint degrades its own section, never the profile.
      final String token = _session.sessionToken ?? '';
      final Future<ProfileSummaryDto> dtoFuture =
          _api.getProfileSummary(authToken: token);
      final Future<List<Object?>> extrasFuture = includeDisplayExtras
          ? Future.wait<Object?>([
              _optional(() => _api.getWorkPreferences(authToken: token)),
              _optional(
                  () => _api.getWorkPreferenceOptions(authToken: token)),
              _optional(() => _api.getMyQualifications(authToken: token)),
              _optional(() => _api.getMyOccupations(authToken: token)),
              _loadAttested(),
            ])
          : Future<List<Object?>>.value(const <Object?>[]);
      final ProfileSummaryDto dto = await dtoFuture;
      // Display-only sections (languages, work types, v4 facts, trainings,
      // occupations, attested badge) are fetched ONLY when the caller renders
      // them — the Profile tab. Every other caller gets the lean core
      // summary: the extras cost their own round trips, and a background read
      // (the resume draft-pill, the profiling preview) must never pay for
      // pixels it never paints.
      List<String> languages = const <String>[];
      List<String> workTypes = const <String>[];
      ({
        int? commuteKm,
        bool willingToTravel,
        String? salaryPeriod,
        String? availabilityStatus,
        String? availableFrom,
        int? noticeDays,
      }) v4 = (
        commuteKm: null,
        willingToTravel: false,
        salaryPeriod: null,
        availabilityStatus: null,
        availableFrom: null,
        noticeDays: null,
      );
      List<String> trainings = const <String>[];
      List<SecondaryOccupation> occupations = const <SecondaryOccupation>[];
      bool attested = false;
      if (includeDisplayExtras) {
        final List<Object?> reads = await extrasFuture;
        final WorkPreferencesDto? prefs = reads[0] as WorkPreferencesDto?;
        final WorkPrefOptionsDto? options = reads[1] as WorkPrefOptionsDto?;
        final (List<String> fetchedLanguages, List<String> fetchedWorkTypes) =
            _mapLanguagesAndWorkTypes(prefs, options);
        languages = fetchedLanguages;
        workTypes = fetchedWorkTypes;
        v4 = _mapV4Facts(prefs);
        final (List<String> fetchedTrainings,
            List<SecondaryOccupation> fetchedOccupations) =
            _mapTrainingsAndOccupations(reads[2] as MyQualificationsDto?,
                reads[3] as MyOccupationsDto?);
        trainings = fetchedTrainings;
        occupations = fetchedOccupations;
        attested = reads[4]! as bool;
      }
      final bool confirmed =
          dto.confirmedAt != null || dto.profileStatus == 'confirmed';
      return ProfileSummary(
        // No name on the wire (open §2 escalation) — never fabricate one; the
        // header falls back to the trade label.
        displayName: null,
        initials: null,
        tradeLabel: dto.tradeDisplayName,
        city: dto.city,
        verified: confirmed,
        // Attestation is one of the extras above: correct on FIRST paint, so
        // the badge can neither pop in late nor flicker. Fail-open (a miss
        // reads as unattested), and lean callers never pay for it.
        attested: attested,
        // WA-4: pass the backend signal COUNT through untouched. It used to be
        // divided by a client-side magic target (10) and rendered as a percent
        // — a fabricated number the backend never computed. The denominator
        // slots in here the day the API ships `strength_max`; until then the
        // UI shows an honest count, not a fake fraction.
        strengthSignals: dto.strength,
        strengthMax: dto.strengthMax,
        // The still-missing slots, order preserved (largest-missing-weight first)
        // — the Profile-strength nudge reads `.first` and humanizes it. PII-free.
        missingFields: dto.missingFields,
        // Structured skills/experience for the "Skills aur anubhav" section —
        // PII-free canonical labels + a years number (never the summary text).
        skills: dto.skills,
        machines: dto.machines,
        experienceYears: dto.experienceYears,
        // Highest education level + stream (PII-free labels, same class as the
        // trade/skill strings). Null when the backend omits them — never faked.
        educationLevel: dto.educationLevel,
        educationField: dto.educationField,
        languages: languages,
        workTypes: workTypes,
        commuteKm: v4.commuteKm,
        willingToTravel: v4.willingToTravel,
        salaryPeriod: v4.salaryPeriod,
        availabilityStatus: v4.availabilityStatus,
        availableFrom: v4.availableFrom,
        noticeDays: v4.noticeDays,
        trainings: trainings,
        occupations: occupations,
        // TD81/#503: carry the raw status so the profiling preview can tell a
        // real extraction ('extracted') from a content-poor one ('draft') and
        // refuse to confirm the latter into an empty resume.
        profileStatus: dto.profileStatus,
        // #1524: carry the road that produced the profile ('form' | 'chat' |
        // null). The DTO already restricts the value to those literals, so an
        // unknown/absent value arrives here as null — today's rendering.
        source: dto.source,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  /// Runs [read] fail-null: a dead endpoint (offline, old server, 401
  /// mid-session, or an unstubbed test double) resolves to null and the
  /// section maps to absent — never the profile. The CORE read does not use
  /// this: its failure is the tab's failure state.
  Future<T?> _optional<T>(Future<T> Function() read) async {
    try {
      return await read();
    } catch (_) {
      return null;
    }
  }

  /// The worker's languages and work types as PRINTABLE labels (#1576).
  ///
  /// Reads the STORED values and the SAME dictionary the finishing form writes
  /// (`GET work-preferences/options`), so a slug can never print raw and there
  /// is no second copy of the mapping. PURE mapping over already-fetched
  /// DTOs: a null leg (see [_optional]) reads as two empty lists and the
  /// profile renders exactly as it did before this section existed.
  ///
  /// WORK TYPES PRECEDENCE is the server's (`worker-field-precedence.ts`): a
  /// non-empty stored `work_types` wins, and the legacy single `job_type` is
  /// the fallback for rows that predate it — never both.
  (List<String>, List<String>) _mapLanguagesAndWorkTypes(
    WorkPreferencesDto? prefs,
    WorkPrefOptionsDto? options,
  ) {
    if (prefs == null || options == null) {
      return (const <String>[], const <String>[]);
    }

    final List<String> languages = <String>[
      for (final String slug in prefs.languages ?? const <String>[])
        options.languages[slug] ?? _humanizeSlug(slug),
    ];

    final List<String> rawWorkTypes = prefs.workTypes ?? const <String>[];
    final List<String> workTypeSlugs = rawWorkTypes.isNotEmpty
        ? rawWorkTypes
        : <String>[if (prefs.jobType != null) prefs.jobType!];
    final List<String> workTypes = <String>[
      for (final String slug in workTypeSlugs)
        options.jobType[slug] ?? _humanizeSlug(slug),
    ];

    return (languages, workTypes);
  }

  /// The stored v4 elicited facts as PRINTABLE values (#1587): commute
  /// distance, travel willingness, salary period, and the availability object.
  /// Period/status slugs resolve against the tiny closed mirrors in
  /// `api_models.dart` (`kSalaryPeriodLabels` / `kAvailabilityStatusLabels`);
  /// unknown slugs humanise, never print raw. PURE mapping like the languages
  /// above: a null [prefs] (see [_optional]) reads as absent, never the
  /// profile. Shares the single `getWorkPreferences` fetch — no second round
  /// trip for the same row.
  ({
    int? commuteKm,
    bool willingToTravel,
    String? salaryPeriod,
    String? availabilityStatus,
    String? availableFrom,
    int? noticeDays,
  }) _mapV4Facts(WorkPreferencesDto? prefs) {
    const empty = (
      commuteKm: null,
      willingToTravel: false,
      salaryPeriod: null,
      availabilityStatus: null,
      availableFrom: null,
      noticeDays: null,
    );
    if (prefs == null) return empty;
    final String? period = prefs.salaryPeriod;
    final String? status = prefs.availability?.status;
    final String? from = prefs.availability?.availableFrom?.trim();
    return (
      commuteKm: prefs.commuteKm,
      willingToTravel: prefs.willingToTravel ?? false,
      salaryPeriod: period == null || period.isEmpty
          ? null
          : (kSalaryPeriodLabels[period] ?? _humanizeSlug(period)),
      availabilityStatus: status == null || status.isEmpty
          ? null
          : (kAvailabilityStatusLabels[status] ?? _humanizeSlug(status)),
      availableFrom: (from == null || from.isEmpty) ? null : from,
      noticeDays: prefs.availability?.noticeDays,
    );
  }

  /// Trainings + secondary occupations as display values (#1587). Training
  /// rows compose `name · provider · year`, dropping absent parts; occupation
  /// rows keep the SERVER's label verbatim and drop label-less rows. `[]` when
  /// nothing is stored. PURE mapping like the sections above: a null leg
  /// (see [_optional]) reads as absent for its own list, never the profile.
  (List<String>, List<SecondaryOccupation>) _mapTrainingsAndOccupations(
    MyQualificationsDto? qualifications,
    MyOccupationsDto? mine,
  ) {
    List<String> trainings = const <String>[];
    List<SecondaryOccupation> occupations = const <SecondaryOccupation>[];
    if (qualifications != null) {
      trainings = <String>[
        for (final TrainingEntryDto t in qualifications.trainings)
          if (t.name.trim().isNotEmpty)
            <String>[
              t.name.trim(),
              if (t.provider?.trim().isNotEmpty ?? false) t.provider!.trim(),
              if (t.year != null) '${t.year}',
            ].join(' · '),
      ];
    }
    if (mine != null) {
      occupations = <SecondaryOccupation>[
        for (final MyOccupationDto o in mine.occupations)
          if (o.label.trim().isNotEmpty)
            SecondaryOccupation(roleId: o.roleId, label: o.label.trim()),
      ];
    }
    return (trainings, occupations);
  }

  /// Whether the SERVER attests this worker (#1586): `GET /resume/document`
  /// `header.trustBadge` non-empty. Any non-empty server label counts — the
  /// server owns the vocabulary (`verification-tier.ts`), so the client must
  /// not pin the literal. BEST-EFFORT: no document (pre-render), an old
  /// server, or any failure reads as unattested — no badge, never a claim.
  Future<bool> _loadAttested() async {
    try {
      final response =
          await _api.getResumeDocument(authToken: _session.sessionToken ?? '');
      final String? badge = response.document?.header.trustBadge;
      return badge != null && badge.trim().isNotEmpty;
    } catch (_) {
      return false;
    }
  }
}

/// A slug with no dictionary label: title-case it so an option the client's
/// dictionary is behind on still reads as words, never a raw `snake_case` id.
String _humanizeSlug(String slug) {
  final List<String> words = slug
      .split(RegExp('[ _]+'))
      .where((String w) => w.isNotEmpty)
      .map((String w) =>
          '${w[0].toUpperCase()}${w.substring(1).toLowerCase()}')
      .toList();
  return words.join(' ');
}

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
  Future<ProfileSummary> summary() async {
    try {
      final ProfileSummaryDto dto =
          await _api.getProfileSummary(authToken: _session.sessionToken ?? '');
      // #1576 — the chat now captures `languages` and `work_types`; show them
      // wherever the profile shows the worker's own facts. Resolved from the
      // server's stored values + the same dictionary the form writes, so there
      // is no second copy of the slug→label mapping. BEST-EFFORT: a miss here
      // costs a display line, never the profile.
      final (List<String> languages, List<String> workTypes) =
          await _loadLanguagesAndWorkTypes();
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

  /// The worker's languages and work types as PRINTABLE labels (#1576).
  ///
  /// Reads the STORED values and the SAME dictionary the finishing form writes
  /// (`GET work-preferences/options`), so a slug can never print raw and there
  /// is no second copy of the mapping. BEST-EFFORT by design: any failure —
  /// offline, an old server, a 401 mid-session — returns two empty lists and
  /// the profile renders exactly as it did before this section existed.
  ///
  /// WORK TYPES PRECEDENCE is the server's (`worker-field-precedence.ts`): a
  /// non-empty stored `work_types` wins, and the legacy single `job_type` is
  /// the fallback for rows that predate it — never both.
  Future<(List<String>, List<String>)> _loadLanguagesAndWorkTypes() async {
    final String token = _session.sessionToken ?? '';
    try {
      final WorkPreferencesDto prefs =
          await _api.getWorkPreferences(authToken: token);
      final WorkPrefOptionsDto options =
          await _api.getWorkPreferenceOptions(authToken: token);

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
    } catch (_) {
      return (const <String>[], const <String>[]);
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

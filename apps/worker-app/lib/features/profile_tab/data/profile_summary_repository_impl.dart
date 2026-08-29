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
        // TD81/#503: carry the raw status so the profiling preview can tell a
        // real extraction ('extracted') from a content-poor one ('draft') and
        // refuse to confirm the latter into an empty resume.
        profileStatus: dto.profileStatus,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}

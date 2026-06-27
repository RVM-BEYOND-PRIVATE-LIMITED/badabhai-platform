import '../domain/profile_summary.dart';
import '../domain/profile_summary_repository.dart';

/// MOCK-ONLY profile summary for the alpha. PII-free canned data — the display
/// name is a fabricated mock string, never real worker PII, and is never sent to
/// an LLM, event, ai_jobs, audit_logs, or a log. This mock repository IS the
/// alpha source; a real profile-summary endpoint is a §7 follow-up.
class ProfileSummaryRepositoryImpl implements ProfileSummaryRepository {
  const ProfileSummaryRepositoryImpl();

  @override
  Future<ProfileSummary> summary() async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    return const ProfileSummary(
      initials: 'RK',
      displayName: 'Ramesh Kumar',
      tradeLabel: 'CNC Operator',
      city: 'Pune',
      verified: true,
      strength: 0.72,
    );
  }
}

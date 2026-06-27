import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';

/// MOCK-ONLY resume safe-field source for the alpha.
///
/// Photo display/storage has DPDP/consent implications (CLAUDE.md §2/§6) — this
/// is mock only; real GET/PATCH + photo capture are deferred behind an ADR.
/// These values are never sent to a real endpoint, event, ai_jobs, or a log.
/// The fabricated [displayName] is PII-shaped on a LIVE endpoint and stays
/// client-side until that boundary is designed.
class ResumeEditRepositoryImpl implements ResumeEditRepository {
  const ResumeEditRepositoryImpl();

  @override
  Future<ResumeSafeFields> load() async {
    // Mock network latency so the loading state renders.
    await Future<void>.delayed(const Duration(milliseconds: 300));
    return const ResumeSafeFields(
      displayName: 'Ramesh Kumar',
      showPhoto: true,
      showPhone: true,
      nightShiftReady: false,
    );
  }

  @override
  Future<void> save(ResumeSafeFields fields) async {
    // Mock network latency so the saving state renders. No-op: nothing is
    // persisted or sent anywhere (see header note).
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }
}

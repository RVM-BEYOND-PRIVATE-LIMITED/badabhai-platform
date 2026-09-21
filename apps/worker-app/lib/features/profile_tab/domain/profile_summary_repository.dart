import 'profile_summary.dart';

/// Read boundary for the tabbed Profile summary (spec §5.9).
abstract interface class ProfileSummaryRepository {
  /// The summary. Pass [includeDisplayExtras] ONLY on surfaces that render
  /// the display-only sections (languages, work types, v4 facts) — currently
  /// just the Profile tab. Every other caller (profiling preview, resume
  /// draft-pill) takes the lean default: the extras cost their own round
  /// trips, and background callers must never pay for pixels they never
  /// paint.
  ///
  /// Attestation IS part of the extras shape (correct on first paint): the
  /// badge read runs inside `summary()`'s own `Future.wait`, so it settles
  /// before `ready` emits and can neither pop in late nor outlive its tree.
  Future<ProfileSummary> summary({bool includeDisplayExtras = false});
}

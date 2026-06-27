import 'profile_summary.dart';

/// Read boundary for the tabbed Profile summary (spec §5.9).
abstract interface class ProfileSummaryRepository {
  Future<ProfileSummary> summary();
}

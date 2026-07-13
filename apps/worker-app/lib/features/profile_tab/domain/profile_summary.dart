import 'package:equatable/equatable.dart';

/// The tabbed Profile header summary (spec §5.9), mapped from the live
/// GET /workers/me/profile-summary response.
///
/// PII-free by contract: a coarse trade label, a city, a verified flag, and a
/// completeness bar — no phone, no employer. The worker's NAME is deliberately
/// NOT on the wire (an open §2 escalation), so [displayName]/[initials] are
/// nullable and are NEVER fabricated — a null name renders a name-free,
/// trade-led header. Distinct from the profiling-preview entity.
class ProfileSummary extends Equatable {
  const ProfileSummary({
    this.displayName,
    this.initials,
    this.tradeLabel,
    this.city,
    this.verified = false,
    required this.strength,
  });

  /// The worker's name, or `null` when the backend omits it (current reality —
  /// the name escalation is not built). Never fabricated.
  final String? displayName;

  /// Monogram derived from [displayName]; `null` when there is no name (the
  /// header then shows a neutral avatar icon instead of initials).
  final String? initials;

  /// Coarse trade label (`trade.display_name`); `null` until canonicalized.
  final String? tradeLabel;

  /// City; `null` when absent. PII — never logged.
  final String? city;

  /// True when the worker has a CONFIRMED profile.
  final bool verified;

  /// Profile completeness, 0..1 (normalized from the backend signal count for
  /// the strength bar — a display value, see ProfileSummaryRepositoryImpl).
  final double strength;

  @override
  List<Object?> get props =>
      <Object?>[displayName, initials, tradeLabel, city, verified, strength];
}

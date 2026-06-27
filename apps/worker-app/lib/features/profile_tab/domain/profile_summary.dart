import 'package:equatable/equatable.dart';

/// The tabbed Profile header summary (spec §5.9). PII-free by contract: only an
/// initials monogram, a mock display name, a coarse trade label, a city, and a
/// strength percentage — no phone, no employer, no address. Distinct from the
/// profiling-preview entity.
class ProfileSummary extends Equatable {
  const ProfileSummary({
    required this.initials,
    required this.displayName,
    required this.tradeLabel,
    required this.city,
    this.verified = true,
    required this.strength,
  });

  final String initials;
  final String displayName;
  final String tradeLabel;
  final String city;
  final bool verified;

  /// Profile completeness, 0..1.
  final double strength;

  @override
  List<Object?> get props =>
      <Object?>[initials, displayName, tradeLabel, city, verified, strength];
}

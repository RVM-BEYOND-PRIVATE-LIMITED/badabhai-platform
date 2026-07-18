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
    required this.strengthSignals,
    this.strengthMax,
    this.skills = const <String>[],
    this.machines = const <String>[],
    this.experienceYears,
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

  /// Profile strength as the backend reports it: an integer SIGNAL COUNT
  /// (`countFields` recomputed on read — apps/api profile-summary.mapper.ts),
  /// NOT a fraction. WA-4: this is rendered as an honest count ("N signals"),
  /// never divided by a client-side magic constant to fake a percent.
  final int strengthSignals;

  /// The denominator, WHEN the backend ships one (`strength_max` — not on the
  /// wire today, so this is null). Non-null unlocks a real N/max meter; until
  /// then no fraction/percent is fabricated.
  final int? strengthMax;

  /// Worker-confirmed canonical skill labels (`skills`); `[]` when none. PII-free
  /// taxonomy strings — safe to render as chips.
  final List<String> skills;

  /// Canonical machine labels (`machines`); `[]` when none. PII-free.
  final List<String> machines;

  /// Total years of experience (`experience.total_years`), a NUMBER only — the
  /// free-text summary is never on the wire (§2). `null` when unknown.
  final double? experienceYears;

  @override
  List<Object?> get props => <Object?>[
        displayName,
        initials,
        tradeLabel,
        city,
        verified,
        strengthSignals,
        strengthMax,
        skills,
        machines,
        experienceYears,
      ];
}

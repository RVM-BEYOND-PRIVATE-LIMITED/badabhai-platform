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
    this.missingFields = const <String>[],
    this.skills = const <String>[],
    this.machines = const <String>[],
    this.experienceYears,
    this.educationLevel,
    this.educationField,
    this.profileStatus = 'none',
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

  /// The still-missing field-group slots (`missing_fields`), ordered by the
  /// server largest-missing-weight FIRST — `missingFields.first` is the single
  /// most valuable slot to add next. PII-free field NAMES, `[]` when none/complete.
  /// Drives the Profile-strength NUDGE (one humanized prompt at a time); never a
  /// grade, never a raw slug on screen.
  final List<String> missingFields;

  /// Worker-confirmed canonical skill labels (`skills`); `[]` when none. PII-free
  /// taxonomy strings — safe to render as chips.
  final List<String> skills;

  /// Canonical machine labels (`machines`); `[]` when none. PII-free.
  final List<String> machines;

  /// Total years of experience (`experience.total_years`), a NUMBER only — the
  /// free-text summary is never on the wire (§2). `null` when unknown.
  final double? experienceYears;

  /// Highest academic/education level as a short label (`education_level`), e.g.
  /// '10th', '12th', 'ITI', 'Diploma', 'B.Tech'. NOT PII (same class as the
  /// coarse trade/skill labels). `null` when unknown — never fabricated.
  final String? educationLevel;

  /// Stream/branch of study (`education_field`), e.g. 'Electronics',
  /// 'Mechanical', 'Computer Science'. NOT PII. `null` when unknown — never
  /// fabricated. Distinct from the resume `education` list (ITI/diploma
  /// mentions) and from certifications.
  final String? educationField;

  /// The raw backend `profile_status` (`worker_profiles.profile_status`):
  /// 'none' | 'draft' | 'extracting' | 'extracted' | 'confirmed'. Defaults to
  /// `'none'` for a hand-built / no-profile summary.
  ///
  /// WHY IT IS CARRIED (TD81 / backend #503): a content-poor or mock/AI-down
  /// extraction now COMPLETES the ai_job with a real `profile_id` but stamps the
  /// row `'draft'` instead of `'extracted'`. The GET /workers/me/ai-jobs/:id status cannot
  /// tell the two apart — only this field can. The profiling preview gates the
  /// "Confirm & generate resume" step on it ([isDraft]) so a near-empty draft is
  /// never confirmed into an empty resume (the Phase-1 exit contract).
  final String profileStatus;

  /// True when the extraction produced too little to be a usable profile
  /// (backend `profile_status == 'draft'`). The preview blocks confirm and sends
  /// the worker back to chat to add more detail.
  bool get isDraft => profileStatus == 'draft';

  @override
  List<Object?> get props => <Object?>[
        displayName,
        initials,
        tradeLabel,
        city,
        verified,
        strengthSignals,
        strengthMax,
        missingFields,
        skills,
        machines,
        experienceYears,
        educationLevel,
        educationField,
        profileStatus,
      ];
}

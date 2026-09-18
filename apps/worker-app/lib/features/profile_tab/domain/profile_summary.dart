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
    this.attested = false,
    required this.strengthSignals,
    this.strengthMax,
    this.missingFields = const <String>[],
    this.skills = const <String>[],
    this.machines = const <String>[],
    this.experienceYears,
    this.educationLevel,
    this.educationField,
    this.languages = const <String>[],
    this.workTypes = const <String>[],
    this.commuteKm,
    this.willingToTravel = false,
    this.salaryPeriod,
    this.availabilityStatus,
    this.availableFrom,
    this.noticeDays,
    this.trainings = const <String>[],
    this.occupations = const <SecondaryOccupation>[],
    this.profileStatus = 'none',
    this.source,
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
  ///
  /// This is a LIFECYCLE signal, not a trust signal: it must never drive a
  /// "Verified" badge. Confirmation says the profile finished; only the
  /// server's attestation says someone checked it (see [attested]).
  final bool verified;

  /// True only when the SERVER attests this worker (`GET /resume/document`
  /// `header.trustBadge` non-empty). False for self-declared, employer-rated,
  /// unverified, unknown, and document-null (pre-render) — all of which render
  /// NO badge and NO "Unverified" copy. The ONLY driver of the Verified
  /// pill/seal (#1586).
  final bool attested;

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

  /// The worker's languages as PRINTABLE labels, resolved from the chat/form
  /// captured `languages` slugs against the server's dictionary. `[]` when
  /// absent — the section is then hidden, never shown as an empty row.
  final List<String> languages;

  /// The work types as PRINTABLE labels (the #1559 multi). When the stored
  /// multi is non-empty it WINS; otherwise the legacy single `job_type` is the
  /// one-entry fallback — the two are never shown together. `[]` hides the
  /// section.
  final List<String> workTypes;

  /// Stored commute distance in km (#1587, v4 elicitation). `null` when no row
  /// — the row is then hidden, never a "0 km" fabrication.
  final int? commuteKm;

  /// Stored travel willingness (#1587). Only `true` ever prints; `false` is a
  /// withdrawn claim, so the row is hidden — never a "travel nahi" verdict.
  final bool willingToTravel;

  /// The salary period as a PRINTABLE label (#1587: Mahina/Din/Saal), resolved
  /// against the server's `SALARY_PERIODS`. `null` when no row — hidden.
  final String? salaryPeriod;

  /// The availability status as a PRINTABLE label (#1587), resolved against
  /// the server's `AVAILABILITY_STATUSES`. `null` when unset — hidden.
  final String? availabilityStatus;

  /// The worker's stated start day, `YYYY-MM-DD`, printed as stated (#1587).
  /// `null`/blank when unset — hidden.
  final String? availableFrom;

  /// Notice period in days (#1587). `null` when unset — hidden.
  final int? noticeDays;

  /// The worker's courses as `name [· provider] [· year]` display lines
  /// (#1587, Layer A (d) trainings). `[]` when none — hidden.
  final List<String> trainings;

  /// Secondary occupations as the SERVER-resolved `{role_id, label}` rows
  /// (#1587, Layer A (f)). Labels render verbatim — a `role_*` id is never
  /// humanised client-side, and a row with an empty label is dropped, never
  /// guessed. `[]` when none — hidden.
  final List<SecondaryOccupation> occupations;

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

  /// The profiling ROAD that produced this profile (`source`): `"form"`,
  /// `"chat"`, or `null` when unknown (a pre-migration row, no profile, or an
  /// older server). NEVER guessed from the trade or a photo. Additive — a null
  /// value keeps today's single rendering path, byte for byte.
  final String? source;

  /// True when the extraction produced too little to be a usable profile
  /// (backend `profile_status == 'draft'`). The preview blocks confirm and sends
  /// the worker back to chat to add more detail.
  bool get isDraft => profileStatus == 'draft';

  /// True when the profile came off the chat road (`source == 'chat'`), which
  /// renders its own variant and edits by returning to the chat.
  bool get isChatSourced => source == 'chat';

  /// True when the profile came off the form road (`source == 'form'`), which
  /// renders the trade-sheet shape and edits by returning to the form.
  bool get isFormSourced => source == 'form';

  /// Returns a copy with attestation applied — the post-ready hydration step
  /// (#1586). The ONLY mutation the badge path performs; everything else on
  /// a loaded summary is final.
  ProfileSummary copyWith({bool? attested}) {
    return ProfileSummary(
      displayName: displayName,
      initials: initials,
      tradeLabel: tradeLabel,
      city: city,
      verified: verified,
      attested: attested ?? this.attested,
      strengthSignals: strengthSignals,
      strengthMax: strengthMax,
      missingFields: missingFields,
      skills: skills,
      machines: machines,
      experienceYears: experienceYears,
      educationLevel: educationLevel,
      educationField: educationField,
      languages: languages,
      workTypes: workTypes,
      commuteKm: commuteKm,
      willingToTravel: willingToTravel,
      salaryPeriod: salaryPeriod,
      availabilityStatus: availabilityStatus,
      availableFrom: availableFrom,
      noticeDays: noticeDays,
      trainings: trainings,
      occupations: occupations,
      profileStatus: profileStatus,
      source: source,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        displayName,
        initials,
        tradeLabel,
        city,
        verified,
        attested,
        strengthSignals,
        strengthMax,
        missingFields,
        skills,
        machines,
        experienceYears,
        educationLevel,
        educationField,
        languages,
        workTypes,
        commuteKm,
        willingToTravel,
        salaryPeriod,
        availabilityStatus,
        availableFrom,
        noticeDays,
        trainings,
        occupations,
        profileStatus,
        source,
      ];
}

/// One secondary occupation exactly as the server labelled it (Layer A (f)).
class SecondaryOccupation extends Equatable {
  const SecondaryOccupation({required this.roleId, required this.label});

  final String roleId;
  final String label;

  @override
  List<Object?> get props => <Object?>[roleId, label];
}

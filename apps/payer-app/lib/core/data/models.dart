import 'package:equatable/equatable.dart';

import '../session/app_session.dart';

/// PII-free, swappable DTOs for the payer app. These mirror the sample-data
/// arrays in the Payer App kit's `.dc.html` script block and are the binding
/// surface for the real API later. The masked/redacted projection of a
/// candidate is computed at the presentation layer from [Candidate]; the feed
/// never ships a real name to a card until a paid unlock flips `unlocked`.

/// Soft, non-numeric fit signal — "Strong fit" / "Good fit" or none. NEVER a
/// score and NEVER a demographic. Relevance sorts the feed; money never ranks.
enum FitLabel { strong, good, none }

extension FitLabelX on FitLabel {
  String? get label => switch (this) {
        FitLabel.strong => 'Strong fit',
        FitLabel.good => 'Good fit',
        FitLabel.none => null,
      };
}

/// A candidate as the payer sees them. Real identity ([name], [phone]) is only
/// surfaced on the Reveal screen after [unlocked] is true; in the feed the card
/// renders a redacted name and "••" avatar. No gender/age/caste/religion field
/// exists on this model by construction.
class Candidate extends Equatable {
  const Candidate({
    required this.id,
    required this.name,
    required this.trade,
    required this.skill,
    required this.exp,
    required this.loc,
    required this.avail,
    required this.hot,
    required this.fit,
    required this.phone,
    this.unlocked = false,
  });

  final int id;
  final String name;
  final String trade;
  final String skill;
  final String exp;
  final String loc;
  final String avail;
  final bool hot;
  final FitLabel fit;
  final String phone;
  final bool unlocked;

  Candidate copyWith({bool? unlocked}) => Candidate(
        id: id,
        name: name,
        trade: trade,
        skill: skill,
        exp: exp,
        loc: loc,
        avail: avail,
        hot: hot,
        fit: fit,
        phone: phone,
        unlocked: unlocked ?? this.unlocked,
      );

  @override
  List<Object?> get props =>
      <Object?>[id, name, trade, skill, exp, loc, avail, hot, fit, phone, unlocked];
}

/// Lifecycle of a job posting — drives the status pill + row dimming.
enum JobStatus { live, filled, review }

extension JobStatusX on JobStatus {
  String get label => switch (this) {
        JobStatus.live => 'Active',
        JobStatus.filled => 'Quota reached',
        JobStatus.review => 'In review',
      };
}

class JobPosting extends Equatable {
  const JobPosting({
    required this.title,
    required this.band,
    required this.filled,
    required this.quota,
    required this.applicants,
    required this.unlocks,
    required this.status,
    required this.verified,
    required this.boosted,
    this.id,
    this.locationLabel,
    this.createdAt,
    this.wireStatus,
    this.disclosuresCount = 0,
  });

  final String title;
  final String band;
  final int filled;
  final int quota;
  final int applicants;
  final int unlocks;
  final JobStatus status;
  final bool verified;
  final bool boosted;

  // --- Optional fields the REAL API row carries (additive, default null so the
  // mock constructors are unchanged). The server row has NO quota/applicants/
  // verified/boost (MISSING per the API map) — those keep their model defaults.
  /// Opaque job-posting id from `GET /payer/job-postings` (`null` in the mock).
  final String? id;

  /// "Pimpri, Pune" style label from the API row (`null` in the mock).
  final String? locationLabel;

  /// ISO timestamp from the API row (`null` in the mock).
  final String? createdAt;

  /// Raw lifecycle string from the company `/payer/job-postings` row
  /// (`'draft'|'open'|'paused'|'closed'`). `null` in the mock. The REAL My-jobs
  /// card renders its pill + picks legal lifecycle actions off THIS (the
  /// 3-value [JobStatus] enum has no `draft`/`paused`/`closed` split).
  final String? wireStatus;

  /// How many résumés the payer has downloaded for this posting
  /// (`disclosures_count` from the enriched API row) — a truthful per-posting
  /// engagement count. 0 in the mock and for a posting with no downloads.
  final int disclosuresCount;

  double get progress => quota == 0 ? 0 : filled / quota;
  int get pct => (progress * 100).round();

  @override
  List<Object?> get props => <Object?>[
        title,
        band,
        filled,
        quota,
        applicants,
        unlocks,
        status,
        verified,
        boosted,
        id,
        locationLabel,
        createdAt,
        wireStatus,
        disclosuresCount,
      ];
}

/// Direction of an unlock-ledger entry — drives the +/- mono colour.
enum LedgerDirection { credit, debit }

class LedgerEntry extends Equatable {
  const LedgerEntry({
    required this.label,
    required this.amount,
    required this.direction,
  });

  final String label;

  /// Pre-formatted mono amount ("+200" / "−1").
  final String amount;
  final LedgerDirection direction;

  @override
  List<Object?> get props => <Object?>[label, amount, direction];
}

/// The agency's referral link + funnel counts. The link is the one part of this
/// supply surface with a real backend (`POST /payer/agency/invites` →
/// `{code, link}`); the funnel mirrors `GET /payer/agency/referrals/summary`.
/// The kit shows only the link + QR; counts are kept for the later binding pass.
class ReferralLink extends Equatable {
  const ReferralLink({
    required this.code,
    required this.url,
  });

  /// The invite code, e.g. "APEX-7K2".
  final String code;

  /// The shareable URL shown in mono + encoded into the QR ("badabhai.in/r/…").
  final String url;

  @override
  List<Object?> get props => <Object?>[code, url];
}

/// One explainable ranking signal from the reach core — mirrors the API's
/// `ScoreComponentDto` (`{signal, raw, weight, reason}`). Only [reason] (human,
/// qualitative) is ever shown; [raw]/[weight] are never rendered as a number.
class ApplicantSignal extends Equatable {
  const ApplicantSignal({
    required this.signal,
    required this.raw,
    required this.weight,
    required this.reason,
  });

  final String signal;
  final double raw;
  final double weight;
  final String reason;

  @override
  List<Object?> get props => <Object?>[signal, raw, weight, reason];
}

/// One FACELESS applicant row from `GET /payer/reach/jobs/:jobId/applicants`
/// (the REAL, per-job feed). PII-free by construction: there is NO name, phone,
/// skill list, or numeric fit — only an opaque [workerId] plus coarse,
/// non-identifying facets. The card derives a [maskedLabel] from the UUID and up
/// to a couple of SOFT signal chips from [components]; a paid unlock (real UUID)
/// is the only path to a relay handle.
class Applicant extends Equatable {
  const Applicant({
    required this.workerId,
    required this.rank,
    required this.score,
    required this.hot,
    required this.pushEligible,
    this.components = const <ApplicantSignal>[],
    this.experienceBand,
    this.tradeLabel,
    this.cityLabel,
    this.matchTier,
    this.effectiveTier,
    this.skillMonths,
    this.industryMonths,
    this.matchedSkillLabel,
    this.lastWorkedAt,
    this.unlocked = false,
    this.unlockId,
  });

  /// Opaque worker UUID — the id sent to `POST /payer/unlocks` (NOT a mock int).
  final String workerId;
  final int rank;

  /// Relevance score from the deterministic RANK core. Sorts the feed; NEVER
  /// shown to the payer as a number (money never ranks, scores never render).
  final double score;
  final bool hot;
  final bool pushEligible;
  final List<ApplicantSignal> components;
  final String? experienceBand;
  final String? tradeLabel;
  final String? cityLabel;

  // --- Match V1 facets (additive, all nullable). The deterministic matcher may
  // enrich a per-job applicant row with a tier + coarse tenure/skill context.
  // Absent on legacy rows → null. PII-free (bands/labels only, never a name).
  /// Match tier: 1 = direct skill match, 2 = reached via a related skill.
  final int? matchTier;

  /// Effective tier after any per-posting adjustment (may differ from
  /// [matchTier]); null when the row carries no effective tier.
  final int? effectiveTier;

  /// Months of experience on the matched skill (coarse tenure signal).
  final int? skillMonths;

  /// Months of experience in the matched industry (coarse tenure signal).
  final int? industryMonths;

  /// Human label of the skill this applicant matched on (display only).
  final String? matchedSkillLabel;

  /// ISO timestamp / coarse "last worked" marker for the matched skill.
  final String? lastWorkedAt;

  final bool unlocked;

  /// The granted unlock id (set once a paid unlock succeeds) — carried so the
  /// Reveal screen can fetch the relay handle without a second unlock.
  final String? unlockId;

  /// True when this applicant surfaced via a RELATED skill (tier 2), not a
  /// direct skill match — lets the card badge "via related skill".
  bool get viaRelated => matchTier == 2;

  /// Masked, PII-free label derived from the opaque UUID — e.g. "Worker ••3f9a".
  /// Never a real name. Used on the faceless feed card + the unlock dialog.
  String get maskedLabel {
    final String id = workerId.replaceAll('-', '');
    final String tail = id.length >= 4 ? id.substring(id.length - 4) : id;
    return 'Worker ••$tail';
  }

  /// Up to [max] SOFT signal chips synthesized from the ranking reasons. Only
  /// the qualitative `reason` text — never a raw/weight number or a score.
  List<String> softSignals({int max = 2}) => components
      .map((ApplicantSignal s) => s.reason)
      .where((String reason) => reason.trim().isNotEmpty)
      .take(max)
      .toList(growable: false);

  Applicant copyWith({bool? unlocked, String? unlockId}) => Applicant(
        workerId: workerId,
        rank: rank,
        score: score,
        hot: hot,
        pushEligible: pushEligible,
        components: components,
        experienceBand: experienceBand,
        tradeLabel: tradeLabel,
        cityLabel: cityLabel,
        matchTier: matchTier,
        effectiveTier: effectiveTier,
        skillMonths: skillMonths,
        industryMonths: industryMonths,
        matchedSkillLabel: matchedSkillLabel,
        lastWorkedAt: lastWorkedAt,
        unlocked: unlocked ?? this.unlocked,
        unlockId: unlockId ?? this.unlockId,
      );

  @override
  List<Object?> get props => <Object?>[
        workerId,
        rank,
        score,
        hot,
        pushEligible,
        components,
        experienceBand,
        tradeLabel,
        cityLabel,
        matchTier,
        effectiveTier,
        skillMonths,
        industryMonths,
        matchedSkillLabel,
        lastWorkedAt,
        unlocked,
        unlockId,
      ];
}

/// Result of `POST /payer/unlocks`. The neutral DENY (HTTP 200
/// `{status:"unavailable"}` — no credit / already / capped) is a TYPED variant,
/// never an exception, so the UI can show the neutral "couldn't unlock" path
/// without inventing a reason. A grant requires the real [unlockId] on the wire
/// — the status string alone is never trusted.
class UnlockResult extends Equatable {
  const UnlockResult.granted({required this.unlockId, this.expiresAt})
      : available = true;

  const UnlockResult.unavailable()
      : available = false,
        unlockId = null,
        expiresAt = null;

  final bool available;
  final String? unlockId;
  final String? expiresAt;

  /// True only when the server granted a real unlock (carried an [unlockId]).
  bool get granted => available;

  @override
  List<Object?> get props => <Object?>[available, unlockId, expiresAt];
}

/// Result of `POST /payer/unlocks/:unlockId/reveal`. Success carries a
/// [relayHandle] (an in-app relay/proxy address — NEVER a raw phone) + [channel]
/// (`in_app_relay` | `proxy_number`). The neutral DENY is a typed variant.
class RevealResult extends Equatable {
  const RevealResult.relay({
    required this.relayHandle,
    required this.channel,
    this.expiresAt,
  }) : available = true;

  const RevealResult.unavailable()
      : available = false,
        relayHandle = null,
        channel = null,
        expiresAt = null;

  final bool available;
  final String? relayHandle;
  final String? channel;
  final String? expiresAt;

  bool get revealed => available;

  @override
  List<Object?> get props =>
      <Object?>[available, relayHandle, channel, expiresAt];
}

/// Result of `POST /payer/resume-disclosures`. Success carries a signed
/// [resumeUrl] to a MASKED résumé PDF (PII redacted server-side). The neutral
/// DENY is a typed variant.
class DisclosureResult extends Equatable {
  const DisclosureResult.disclosed({
    required this.disclosureId,
    required this.resumeUrl,
    this.expiresAt,
  }) : available = true;

  const DisclosureResult.unavailable()
      : available = false,
        disclosureId = null,
        resumeUrl = null,
        expiresAt = null;

  final bool available;
  final String? disclosureId;
  final String? resumeUrl;
  final String? expiresAt;

  bool get disclosed => available;

  @override
  List<Object?> get props =>
      <Object?>[available, disclosureId, resumeUrl, expiresAt];
}

/// One row of `GET /payer/resume-disclosures` — the caller's OWN masked-resume
/// disclosure history (newest-first, ≤500). PII-FREE: opaque worker/posting ids
/// + a masked resume ref + timestamps, NEVER a name or phone. The `payer_id` on
/// the wire is always the caller's own id, so it is not surfaced here.
class PayerDisclosure extends Equatable {
  const PayerDisclosure({
    required this.disclosureId,
    required this.workerId,
    required this.jobPostingId,
    required this.status,
    required this.resumeRef,
    required this.disclosedAt,
    required this.expiresAt,
    required this.createdAt,
  });

  final String disclosureId;

  /// Opaque worker UUID, or `null` after a DSAR worker hard-delete SET NULL the
  /// column (migration 0030). Mirrors the backend `worker_id: string | null`.
  final String? workerId;
  final String? jobPostingId;
  final String status;
  final String? resumeRef;
  final String? disclosedAt;
  final String? expiresAt;
  final String createdAt;

  factory PayerDisclosure.fromJson(Map<String, dynamic> json) =>
      PayerDisclosure(
        disclosureId: json['disclosure_id'] as String? ?? '',
        workerId: json['worker_id'] as String?,
        jobPostingId: json['job_posting_id'] as String?,
        status: json['status'] as String? ?? '',
        resumeRef: json['resume_ref'] as String?,
        disclosedAt: json['disclosed_at'] as String?,
        expiresAt: json['expires_at'] as String?,
        createdAt: json['created_at'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[
        disclosureId,
        workerId,
        jobPostingId,
        status,
        resumeRef,
        disclosedAt,
        expiresAt,
        createdAt,
      ];
}

/// A non-2xx from a WRITE endpoint the caller must handle honestly rather than
/// blindly retry — e.g. a 409 illegal lifecycle transition (already closed /
/// no active plan / active boost exists), a 400 no-op update, or a 404 unknown
/// pack. Carries only the HTTP status + an optional server error [code]; NEVER a
/// message with PII. Money DENY (HTTP 200 `{status:"unavailable"}`) is NOT this
/// — that is a typed unavailable result, not an exception.
class PayerApiException implements Exception {
  const PayerApiException(this.statusCode, {this.code});

  final int statusCode;

  /// Optional opaque server error code (never PII).
  final String? code;

  bool get isConflict => statusCode == 409;
  bool get isBadRequest => statusCode == 400;
  bool get isNotFound => statusCode == 404;

  @override
  String toString() =>
      'PayerApiException($statusCode${code == null ? '' : ', $code'})';
}

/// Result of buying/topping-up a job posting's applicant-visibility PLAN
/// (`POST /payer/job-postings/:id/plan` and `.../quota-topup`). Flattens the
/// `{plan{applicantVisibilityQuota,status}, quote{finalInr}, paused, wouldPause}`
/// response to the handful of fields the My-jobs card surfaces. PII-free.
class PlanPurchase extends Equatable {
  const PlanPurchase({
    this.applicantVisibilityQuota,
    this.status,
    this.finalInr,
    this.paused = false,
    this.wouldPause = false,
  });

  final int? applicantVisibilityQuota;
  final String? status;

  /// The charged amount in ₹ from the quote (`finalInr`) — shown in the toast.
  final int? finalInr;
  final bool paused;
  final bool wouldPause;

  @override
  List<Object?> get props =>
      <Object?>[applicantVisibilityQuota, status, finalInr, paused, wouldPause];
}

/// Result of boosting a job posting (`POST /payer/job-postings/:id/boost`).
/// Flattens `{boost{status}, quote{finalInr}}`. PII-free.
class BoostPurchase extends Equatable {
  const BoostPurchase({this.status, this.finalInr});

  final String? status;
  final int? finalInr;

  @override
  List<Object?> get props => <Object?>[status, finalInr];
}

// --- Agency demand (ADR-0022) — jobs + referral funnel --------------------
// The agency (role='agent') owns its OWN faceless `jobs` rows: a coarse
// trade/title/city/pay/experience posting with NO employer name or worker
// identity by construction. `snake_case` IN (create/update body), `camelCase`
// OUT (the [AgencyJobView] projection). Status is `open | paused | closed`
// (#1202): a pause is REVERSIBLE (`open -> paused -> open`); only a close is
// terminal.

/// The ratified manufacturing alpha trade keys the agency create/edit route
/// accepts (`trade_key` enum — the same set the Reach core + resume content
/// recognize). Ordered for the Post-a-job select; never free text (a job can
/// never smuggle PII through an arbitrary string).
const List<String> kAgencyTradeKeys = <String>[
  'cnc_operator',
  'vmc_operator',
  'cnc_vmc_setter',
  'cnc_programmer',
  'vmc_programmer',
  'cad_designer',
  'solidworks_designer',
  'autocad_draftsman',
  'quality_inspector',
  'production_engineer',
  'maintenance_technician',
  'tool_room_technician',
  'machine_operator',
  'assembly_technician',
  'fitter',
];

/// Human labels for the [kAgencyTradeKeys] enum (display only — the wire always
/// carries the key).
const Map<String, String> kAgencyTradeLabels = <String, String>{
  'cnc_operator': 'CNC Operator',
  'vmc_operator': 'VMC Operator',
  'cnc_vmc_setter': 'CNC / VMC Setter',
  'cnc_programmer': 'CNC Programmer',
  'vmc_programmer': 'VMC Programmer',
  'cad_designer': 'CAD Designer',
  'solidworks_designer': 'SolidWorks Designer',
  'autocad_draftsman': 'AutoCAD Draftsman',
  'quality_inspector': 'Quality Inspector',
  'production_engineer': 'Production Engineer',
  'maintenance_technician': 'Maintenance Technician',
  'tool_room_technician': 'Tool Room Technician',
  'machine_operator': 'Machine Operator',
  'assembly_technician': 'Assembly Technician',
  'fitter': 'Fitter',
};

/// Label for a trade key — falls back to the raw key for an unknown value.
String agencyTradeLabel(String key) => kAgencyTradeLabels[key] ?? key;

/// The coarse `needed_by` timing enum the agency route accepts.
const List<String> kAgencyNeededBy = <String>['immediate', 'soon', 'flexible'];

/// Label for a `needed_by` value.
String agencyNeededByLabel(String? value) => switch (value) {
      'immediate' => 'Immediate',
      'soon' => 'Soon',
      'flexible' => 'Flexible',
      _ => '—',
    };

/// Compact whole-rupee formatter (western thousands grouping — wages sit well
/// under a lakh so this matches Indian grouping for the band). "₹22,000".
String _formatInr(int value) {
  final String digits = value.abs().toString();
  final StringBuffer out = StringBuffer();
  for (int i = 0; i < digits.length; i++) {
    if (i != 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return '₹$out';
}

/// One agency-owned job posting (`GET /payer/agency/jobs` rows +
/// `POST/PATCH/close/pause/resume` results). PII-free by construction: a coarse
/// trade key, generic title, city/area label, integer ₹ pay band, year counts,
/// and a coarse timing enum — NEVER an employer name or worker identity.
/// [status] is `open | paused | closed` (#1202): a pause is REVERSIBLE
/// (`open -> paused -> open` via resume); only a close is terminal.
class AgencyJobView extends Equatable {
  const AgencyJobView({
    required this.id,
    required this.status,
    required this.tradeKey,
    required this.title,
    required this.city,
    required this.applicantsReceived,
    this.area,
    this.payMin,
    this.payMax,
    this.minExperienceYears,
    this.maxExperienceYears,
    this.neededBy,
    this.createdAt,
    this.updatedAt,
  });

  /// One camelCase wire row → [AgencyJobView] (create/list/get/patch/lifecycle
  /// all share this shape).
  factory AgencyJobView.fromJson(Map<String, dynamic> row) => AgencyJobView(
        id: row['id'] as String? ?? '',
        status: row['status'] as String? ?? 'open',
        tradeKey: row['tradeKey'] as String? ?? '',
        title: row['title'] as String? ?? '',
        city: row['city'] as String? ?? '',
        area: row['area'] as String?,
        payMin: (row['payMin'] as num?)?.toInt(),
        payMax: (row['payMax'] as num?)?.toInt(),
        minExperienceYears: (row['minExperienceYears'] as num?)?.toInt(),
        maxExperienceYears: (row['maxExperienceYears'] as num?)?.toInt(),
        neededBy: row['neededBy'] as String?,
        applicantsReceived: (row['applicantsReceived'] as num?)?.toInt() ?? 0,
        createdAt: row['createdAt'] as String?,
        updatedAt: row['updatedAt'] as String?,
      );

  /// Opaque job UUID.
  final String id;

  /// `open` | `paused` | `closed` (#1202). A pause is reversible via resume;
  /// only a close is terminal.
  final String status;
  final String tradeKey;
  final String title;
  final String city;
  final String? area;
  final int? payMin;
  final int? payMax;
  final int? minExperienceYears;
  final int? maxExperienceYears;
  final String? neededBy;
  final int applicantsReceived;
  final String? createdAt;
  final String? updatedAt;

  bool get isOpen => status == 'open';
  bool get isPaused => status == 'paused';
  bool get isClosed => status == 'closed';

  /// Display label for the trade key (never the raw key on-screen).
  String get tradeLabel => agencyTradeLabel(tradeKey);

  /// "Pune · Chakan" | "Pune" — the coarse location line.
  String get locationText =>
      area == null || area!.isEmpty ? city : '$city · $area';

  /// "₹22,000–₹28,000" | "₹22,000+" | "up to ₹28,000" | null (no band set).
  String? get payRangeLabel {
    final int? lo = payMin;
    final int? hi = payMax;
    if (lo == null && hi == null) return null;
    if (lo != null && hi != null) return '${_formatInr(lo)}–${_formatInr(hi)}';
    if (lo != null) return '${_formatInr(lo)}+';
    return 'up to ${_formatInr(hi!)}';
  }

  /// "2–6 yrs" | "2+ yrs" | "up to 6 yrs" | null (no band set).
  String? get experienceLabel {
    final int? lo = minExperienceYears;
    final int? hi = maxExperienceYears;
    if (lo == null && hi == null) return null;
    if (lo != null && hi != null) return '$lo–$hi yrs';
    if (lo != null) return '$lo+ yrs';
    return 'up to $hi yrs';
  }

  @override
  List<Object?> get props => <Object?>[
        id,
        status,
        tradeKey,
        title,
        city,
        area,
        payMin,
        payMax,
        minExperienceYears,
        maxExperienceYears,
        neededBy,
        applicantsReceived,
        createdAt,
        updatedAt,
      ];
}

/// The agency referral FUNNEL summary (`GET /payer/agency/referrals/summary`).
/// AGGREGATE counts only — there are NO per-worker rows on this seam (faceless).
/// A k-anonymity floor ([minBucket], e.g. 5) is applied server-side: a count
/// below the floor is suppressed to 0, so a `0` may mean "below the floor",
/// not literally "none".
class ReferralsSummary extends Equatable {
  const ReferralsSummary({
    required this.created,
    required this.clicked,
    required this.accepted,
    required this.minBucket,
  });

  factory ReferralsSummary.fromJson(Map<String, dynamic> row) =>
      ReferralsSummary(
        created: (row['created'] as num?)?.toInt() ?? 0,
        clicked: (row['clicked'] as num?)?.toInt() ?? 0,
        accepted: (row['accepted'] as num?)?.toInt() ?? 0,
        minBucket: (row['minBucket'] as num?)?.toInt() ?? 0,
      );

  /// Invites created (introduced).
  final int created;

  /// Invite links clicked.
  final int clicked;

  /// Invites accepted (worker onboarded/attributed).
  final int accepted;

  /// The k-anon floor — counts below it are suppressed to 0.
  final int minBucket;

  @override
  List<Object?> get props => <Object?>[created, clicked, accepted, minBucket];
}

// --- Agency supply-money — KYC · earnings · payouts (ADR-0022 Amdt 2) ------
// AGENT-only + FLAG-GATED: every `/payer/agency/{kyc,earnings,payouts}` route
// sits behind `AgencyPayoutsEnabledGuard`, which returns a NEUTRAL 404 while the
// launch flag is OFF (the whole surface is inert by default). The client treats
// that 404 as an honest "not available yet" state, NEVER a crash/generic error.
// All money is MOCK server-side (no disbursement); a payout REQUEST is a plain
// authed POST — there is NO gateway/card/checkout here (money-OUT, not money-IN).
// Reads are MASKED: KYC only ever returns last-4, never full PAN/bank. camelCase
// on the wire.

/// The masked KYC view (`POST /payer/agency/kyc` 201 + `GET /payer/agency/kyc`).
/// Financial PII is encrypted at rest server-side and NEVER echoed — the only
/// derivatives here are the [status] enum and the last-4 of PAN / bank account.
class AgencyKycView extends Equatable {
  const AgencyKycView({
    required this.status,
    this.panLast4,
    this.bankLast4,
    this.rejectReason,
    this.updatedAt,
  });

  factory AgencyKycView.fromJson(Map<String, dynamic> row) => AgencyKycView(
        status: row['status'] as String? ?? 'not_submitted',
        panLast4: row['panLast4'] as String?,
        bankLast4: row['bankLast4'] as String?,
        rejectReason: row['rejectReason'] as String?,
        updatedAt: row['updatedAt'] as String?,
      );

  /// `not_submitted` | `pending` | `verified` | `rejected`.
  final String status;

  /// Last 4 of the PAN (masked) — null until a submission exists.
  final String? panLast4;

  /// Last 4 of the bank account (masked) — null until a submission exists.
  final String? bankLast4;

  /// A bounded reason CODE when [status] is `rejected` (never free-text PII).
  final String? rejectReason;

  /// ISO-8601 last-updated timestamp, or null when never submitted.
  final String? updatedAt;

  bool get isNotSubmitted => status == 'not_submitted';
  bool get isPending => status == 'pending';
  bool get isVerified => status == 'verified';
  bool get isRejected => status == 'rejected';

  @override
  List<Object?> get props =>
      <Object?>[status, panLast4, bankLast4, rejectReason, updatedAt];
}

/// Earnings analytics + the payout-gate state (`GET /payer/agency/earnings`).
/// PII-free: ₹ integers + config economics + the gate flags. [canRequest] is the
/// server's own decision (KYC verified AND ≥ threshold AND flag on); the client
/// never re-derives it — it only reflects it and shows [blockedReason] honestly.
class AgencyEarnings extends Equatable {
  const AgencyEarnings({
    required this.totalAccruedInr,
    required this.requestableInr,
    required this.inRequestInr,
    required this.paidInr,
    required this.accrualCount,
    required this.kycStatus,
    required this.thresholdInr,
    required this.basisInr,
    required this.rateBps,
    required this.windowDays,
    required this.payoutsEnabled,
    required this.canRequest,
    this.blockedReason,
  });

  factory AgencyEarnings.fromJson(Map<String, dynamic> row) => AgencyEarnings(
        totalAccruedInr: (row['totalAccruedInr'] as num?)?.toInt() ?? 0,
        requestableInr: (row['requestableInr'] as num?)?.toInt() ?? 0,
        inRequestInr: (row['inRequestInr'] as num?)?.toInt() ?? 0,
        paidInr: (row['paidInr'] as num?)?.toInt() ?? 0,
        accrualCount: (row['accrualCount'] as num?)?.toInt() ?? 0,
        kycStatus: row['kycStatus'] as String? ?? 'not_submitted',
        thresholdInr: (row['thresholdInr'] as num?)?.toInt() ?? 0,
        basisInr: (row['basisInr'] as num?)?.toInt() ?? 0,
        rateBps: (row['rateBps'] as num?)?.toInt() ?? 0,
        windowDays: (row['windowDays'] as num?)?.toInt() ?? 0,
        payoutsEnabled: row['payoutsEnabled'] as bool? ?? false,
        canRequest: row['canRequest'] as bool? ?? false,
        blockedReason: row['blockedReason'] as String?,
      );

  /// Lifetime ₹ accrued (all commission ever earned).
  final int totalAccruedInr;

  /// Unclaimed ₹ available to request right now.
  final int requestableInr;

  /// ₹ claimed into an open (mock-pending) payout request.
  final int inRequestInr;

  /// ₹ claimed into a settled (mock) payout.
  final int paidInr;

  /// Number of commission accruals behind [totalAccruedInr].
  final int accrualCount;

  /// The KYC gate state (`not_submitted`|`pending`|`verified`|`rejected`).
  final String kycStatus;

  /// Minimum ₹ a request must clear.
  final int thresholdInr;

  /// ₹ commission basis per qualifying unlock.
  final int basisInr;

  /// Commission rate in basis points (e.g. 2500 = 25%).
  final int rateBps;

  /// The attribution window in days.
  final int windowDays;

  /// Whether the launch flag is on server-side.
  final bool payoutsEnabled;

  /// The server's decision: may a payout be requested right now?
  final bool canRequest;

  /// Why a request would be refused (`kyc_not_verified`|`below_threshold`|
  /// `disabled`), or null when [canRequest]. A CODE — humanize at the edge.
  final String? blockedReason;

  bool get isKycVerified => kycStatus == 'verified';

  /// ₹ short of the threshold (0 once cleared) — drives the progress copy.
  int get remainingToThresholdInr {
    final int gap = thresholdInr - requestableInr;
    return gap > 0 ? gap : 0;
  }

  @override
  List<Object?> get props => <Object?>[
        totalAccruedInr,
        requestableInr,
        inRequestInr,
        paidInr,
        accrualCount,
        kycStatus,
        thresholdInr,
        basisInr,
        rateBps,
        windowDays,
        payoutsEnabled,
        canRequest,
        blockedReason,
      ];
}

/// The outcome of `POST /payer/agency/payouts` — HTTP 200 EITHER way. A pass
/// carries the created request; a gate refusal carries a [blockedReason] CODE
/// and changes nothing server-side. NOT a payment: no gateway/card is involved.
class PayoutRequestResult extends Equatable {
  const PayoutRequestResult({
    required this.ok,
    this.requestId,
    this.amountInr,
    this.accrualCount,
    this.blockedReason,
  });

  factory PayoutRequestResult.fromJson(Map<String, dynamic> row) =>
      PayoutRequestResult(
        ok: row['ok'] as bool? ?? false,
        requestId: row['requestId'] as String?,
        amountInr: (row['amountInr'] as num?)?.toInt(),
        accrualCount: (row['accrualCount'] as num?)?.toInt(),
        blockedReason: row['reason'] as String?,
      );

  /// True when the request was accepted (accruals claimed into a payout row).
  final bool ok;

  /// The created payout request id (present only when [ok]).
  final String? requestId;

  /// ₹ claimed into the request (present only when [ok]).
  final int? amountInr;

  /// Accruals claimed into the request (present only when [ok]).
  final int? accrualCount;

  /// The refusal CODE when NOT [ok] (`kyc_not_verified`|`below_threshold`|
  /// `disabled`).
  final String? blockedReason;

  @override
  List<Object?> get props =>
      <Object?>[ok, requestId, amountInr, accrualCount, blockedReason];
}

/// One payout request in the agency's OWN history (`GET /payer/agency/payouts`
/// rows). PII-free: ₹ + opaque id + status enum. `status='paid'` is INERT in
/// alpha (no real disbursement — the §7 launch gate).
class AgencyPayout extends Equatable {
  const AgencyPayout({
    required this.id,
    required this.amountInr,
    required this.accrualCount,
    required this.status,
    this.createdAt,
  });

  factory AgencyPayout.fromJson(Map<String, dynamic> row) => AgencyPayout(
        id: row['id'] as String? ?? '',
        amountInr: (row['amountInr'] as num?)?.toInt() ?? 0,
        accrualCount: (row['accrualCount'] as num?)?.toInt() ?? 0,
        status: row['status'] as String? ?? 'requested',
        createdAt: row['createdAt'] as String?,
      );

  /// Opaque payout-request UUID.
  final String id;

  /// ₹ of the request.
  final int amountInr;

  /// Accruals claimed into the request.
  final int accrualCount;

  /// `requested` | `paid` | `rejected`.
  final String status;

  /// ISO-8601 created timestamp.
  final String? createdAt;

  @override
  List<Object?> get props =>
      <Object?>[id, amountInr, accrualCount, status, createdAt];
}

// --- Org / team members (ADR-0027) ----------------------------------------
// The signed-in payer's org/team. FACELESS: the ONLY identity ever carried is a
// server-MASKED email ([emailMasked], e.g. "r•••@acme.in") — a raw email never
// lives on this model. Owner-only actions (invite / remove) are gated on
// [OrgMemberView.isOwner] of the [isSelf] row. `snake_case` on the wire.

/// One org member (`GET /payer/org/members` rows + the invite/accept results).
/// PII-free by construction: opaque [memberId] + coarse role/status + a masked
/// email + when they were invited. [isSelf] marks the current session's row
/// (renders the "You" tag and drives the owner-only gate).
class OrgMemberView extends Equatable {
  const OrgMemberView({
    required this.memberId,
    required this.orgRole,
    required this.status,
    required this.emailMasked,
    this.invitedAt,
    this.isSelf = false,
  });

  /// One snake_case wire row → [OrgMemberView] (list/invite/accept share this).
  factory OrgMemberView.fromJson(Map<String, dynamic> row) => OrgMemberView(
        memberId: row['member_id'] as String? ?? '',
        orgRole: row['org_role'] as String? ?? 'recruiter',
        status: row['status'] as String? ?? 'active',
        emailMasked: row['email_masked'] as String? ?? '',
        invitedAt: row['invited_at'] as String?,
        isSelf: row['is_self'] as bool? ?? false,
      );

  /// Opaque member id — the id sent to `DELETE /payer/org/members/:id`.
  final String memberId;

  /// `owner` | `recruiter`. Only an `owner` session may invite/remove.
  final String orgRole;

  /// `active` | `invited` | `removed`.
  final String status;

  /// Server-MASKED email — the only identity ever shown ("r•••@acme.in").
  final String emailMasked;

  /// ISO timestamp of the invite (`null` when absent on the wire).
  final String? invitedAt;

  /// True for the current session's own row.
  final bool isSelf;

  bool get isOwner => orgRole == 'owner';
  bool get isActive => status == 'active';
  bool get isInvited => status == 'invited';

  /// Display label for the role chip.
  String get roleLabel => isOwner ? 'Owner' : 'Recruiter';

  /// Display label for the status chip.
  String get statusLabel => switch (status) {
        'active' => 'Active',
        'invited' => 'Invited',
        'removed' => 'Removed',
        _ => status,
      };

  @override
  List<Object?> get props =>
      <Object?>[memberId, orgRole, status, emailMasked, invitedAt, isSelf];
}

// --- Hiring capacity (ADR-0016) -------------------------------------------
// The payer's concurrent-active-vacancy allowance. PII-free: opaque payer_id +
// counts + a catalog tier code + a window timestamp only. `active_plan_count`
// is the DERIVED live count of the SESSION payer's active plans (headroom = the
// allowance minus what is in use).

/// The payer's OWN capacity read (`GET /payer/capacity`). [maxActiveVacancies]
/// is the ALLOWANCE and [activePlanCount] the amount USED; [sourceTier] +
/// [expiresAt] describe the tier that granted the current allowance (both
/// `null` on the base tier). PII-free.
class CapacityView extends Equatable {
  const CapacityView({
    required this.maxActiveVacancies,
    required this.activePlanCount,
    this.sourceTier,
    this.expiresAt,
  });

  factory CapacityView.fromJson(Map<String, dynamic> row) => CapacityView(
        maxActiveVacancies: (row['max_active_vacancies'] as num?)?.toInt() ?? 0,
        activePlanCount: (row['active_plan_count'] as num?)?.toInt() ?? 0,
        sourceTier: row['source_tier'] as String?,
        expiresAt: row['expires_at'] as String?,
      );

  final int maxActiveVacancies;
  final int activePlanCount;
  final String? sourceTier;
  final String? expiresAt;

  /// Headroom left in the allowance (never negative).
  int get remaining =>
      (maxActiveVacancies - activePlanCount).clamp(0, maxActiveVacancies);

  /// True once every allowed active vacancy is in use.
  bool get atCapacity =>
      maxActiveVacancies > 0 && activePlanCount >= maxActiveVacancies;

  /// 0..1 usage fraction for the meter (0 when no allowance).
  double get usage =>
      maxActiveVacancies == 0 ? 0 : activePlanCount / maxActiveVacancies;

  @override
  List<Object?> get props =>
      <Object?>[maxActiveVacancies, activePlanCount, sourceTier, expiresAt];
}

/// Display label for the capacity tier [code] the server reports as
/// `source_tier`. Display-only name for a code that came FROM the server — it
/// carries no price (the app has no capacity-purchase surface and must never
/// state a ₹ amount it cannot source). An unknown code renders as itself.
String capacityTierLabel(String? code) {
  if (code == null || code.isEmpty) return 'Base';
  return switch (code) {
    'cap_5' => '5 active vacancies',
    'cap_15' => '15 active vacancies',
    _ => code,
  };
}

// --- Match V1 · skill picker + reach preview -------------------------------
// The DEMAND-side skill taxonomy the payer picks from when posting, plus the
// deterministic reach preview that shows how many workers each picked skill (and
// its related skills) can reach. PII-free by construction: coarse skill ids +
// labels + integer counts only, NEVER a worker identity. `snake_case` on the
// wire, `camelCase` in Dart.

/// One selectable demand skill (`GET /payer/match/skills` rows). Carries the
/// skill's canonical [skillId] + display [label] + owning [industryId] and the
/// ids of RELATED skills the reach preview can widen into. Never free text — a
/// posting can only ever reference a known skill id.
class MatchSkill extends Equatable {
  const MatchSkill({
    required this.skillId,
    required this.label,
    required this.industryId,
    this.relatedSkillIds = const <String>[],
  });

  /// One wire row → [MatchSkill] (snake_case in, camelCase fallback for safety).
  factory MatchSkill.fromJson(Map<String, dynamic> row) => MatchSkill(
        skillId: (row['skill_id'] ?? row['skillId']) as String? ?? '',
        label: row['label'] as String? ?? '',
        industryId: (row['industry_id'] ?? row['industryId']) as String? ?? '',
        relatedSkillIds: ((row['related_skill_ids'] ?? row['relatedSkillIds'])
                    as List<dynamic>? ??
                const <dynamic>[])
            .whereType<String>()
            .toList(growable: false),
      );

  final String skillId;
  final String label;
  final String industryId;
  final List<String> relatedSkillIds;

  @override
  List<Object?> get props =>
      <Object?>[skillId, label, industryId, relatedSkillIds];
}

/// A related-skill preview under a picked [ReachSkill] (`related[]` rows of the
/// reach-preview response). [ticked] is the server's default include/exclude
/// state; the UI may untick it (sending the id in `unticked_related_ids`), which
/// removes its [reachCount] contribution on the next preview.
class RelatedPreview extends Equatable {
  const RelatedPreview({
    required this.skillId,
    required this.label,
    required this.ticked,
    required this.reachCount,
  });

  factory RelatedPreview.fromJson(Map<String, dynamic> row) => RelatedPreview(
        skillId: (row['skill_id'] ?? row['skillId']) as String? ?? '',
        label: row['label'] as String? ?? '',
        ticked: row['ticked'] as bool? ?? false,
        reachCount:
            ((row['reach_count'] ?? row['reachCount']) as num?)?.toInt() ?? 0,
      );

  final String skillId;
  final String label;
  final bool ticked;
  final int reachCount;

  @override
  List<Object?> get props => <Object?>[skillId, label, ticked, reachCount];
}

/// One picked skill's reach breakdown (`skills[]` rows of the reach-preview
/// response): the direct [reachCount] plus the [related] skills it can widen
/// into. Counts are how many workers the deterministic matcher would reach —
/// never a worker identity.
class ReachSkill extends Equatable {
  const ReachSkill({
    required this.skillId,
    required this.label,
    required this.reachCount,
    this.related = const <RelatedPreview>[],
  });

  factory ReachSkill.fromJson(Map<String, dynamic> row) => ReachSkill(
        skillId: (row['skill_id'] ?? row['skillId']) as String? ?? '',
        label: row['label'] as String? ?? '',
        reachCount:
            ((row['reach_count'] ?? row['reachCount']) as num?)?.toInt() ?? 0,
        related: ((row['related'] as List<dynamic>?) ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(RelatedPreview.fromJson)
            .toList(growable: false),
      );

  final String skillId;
  final String label;
  final int reachCount;
  final List<RelatedPreview> related;

  @override
  List<Object?> get props => <Object?>[skillId, label, reachCount, related];
}

/// The deterministic reach preview (`POST /payer/match/reach-preview`). Given
/// the picked [MatchSkill] ids (+ any unticked related ids), the matcher returns
/// per-skill breakdowns and the roll-up totals the post-a-job screen shows. All
/// counts are k-safe aggregates; [zeroReach] flags a picked set no worker meets
/// yet. PII-free.
class ReachPreview extends Equatable {
  const ReachPreview({
    this.skills = const <ReachSkill>[],
    this.reachSkillIds = const <String>[],
    this.reachTotal = 0,
    this.reachTier1 = 0,
    this.zeroReach = false,
    this.appliedUntickedIds = const <String>[],
    this.maxSkillsPerPosting = 0,
  });

  factory ReachPreview.fromJson(Map<String, dynamic> body) => ReachPreview(
        skills: ((body['skills'] as List<dynamic>?) ?? const <dynamic>[])
            .whereType<Map<String, dynamic>>()
            .map(ReachSkill.fromJson)
            .toList(growable: false),
        reachSkillIds:
            ((body['reach_skill_ids'] ?? body['reachSkillIds']) as List<dynamic>? ??
                    const <dynamic>[])
                .whereType<String>()
                .toList(growable: false),
        reachTotal:
            ((body['reach_total'] ?? body['reachTotal']) as num?)?.toInt() ?? 0,
        reachTier1:
            ((body['reach_tier1'] ?? body['reachTier1']) as num?)?.toInt() ?? 0,
        zeroReach: (body['zero_reach'] ?? body['zeroReach']) as bool? ?? false,
        appliedUntickedIds: ((body['applied_unticked_ids'] ??
                    body['appliedUntickedIds']) as List<dynamic>? ??
                const <dynamic>[])
            .whereType<String>()
            .toList(growable: false),
        maxSkillsPerPosting: ((body['max_skills_per_posting'] ??
                    body['maxSkillsPerPosting']) as num?)
                ?.toInt() ??
            0,
      );

  /// Per-picked-skill reach breakdowns (each with its related skills).
  final List<ReachSkill> skills;

  /// The skill ids that actually contribute reach (picked + still-ticked
  /// related), after applying [appliedUntickedIds].
  final List<String> reachSkillIds;

  /// Total distinct workers reachable across the picked set.
  final int reachTotal;

  /// Of [reachTotal], how many are tier-1 (direct) matches.
  final int reachTier1;

  /// True when the picked set reaches no worker yet (drives the empty/warn UX).
  final bool zeroReach;

  /// The related-skill ids the server applied as unticked in this preview.
  final List<String> appliedUntickedIds;

  /// The server-enforced cap on how many skills a single posting may carry.
  final int maxSkillsPerPosting;

  @override
  List<Object?> get props => <Object?>[
        skills,
        reachSkillIds,
        reachTotal,
        reachTier1,
        zeroReach,
        appliedUntickedIds,
        maxSkillsPerPosting,
      ];
}

// --- Agency · referred workers + batch invites -----------------------------
// AGENT-only supply surfaces. [AgencyWorker] is a FACELESS referral row (an
// opaque [ref] + coarse funnel counts, NEVER a name/phone); [MintedInvite] is a
// freshly minted invite code+link. Both are called only for an agency session —
// a company session's 403 surfaces as a typed [PayerApiException].

/// One referred worker in the agency's funnel (`GET /payer/agency/workers`).
/// PII-free: an opaque [ref] handle plus coarse progress/engagement counts and
/// a coarse last-active marker — never an identity. [lastActiveOn] is null when
/// the worker has not been active (or the marker is suppressed).
class AgencyWorker extends Equatable {
  const AgencyWorker({
    required this.ref,
    required this.profileComplete,
    required this.appliedCount,
    required this.unlockedCount,
    this.lastActiveOn,
  });

  /// One wire row → [AgencyWorker]. The route ships camelCase keys; snake_case
  /// is accepted as a defensive fallback.
  factory AgencyWorker.fromJson(Map<String, dynamic> row) => AgencyWorker(
        ref: row['ref'] as String? ?? '',
        profileComplete:
            (row['profileComplete'] ?? row['profile_complete']) as bool? ??
                false,
        appliedCount:
            ((row['appliedCount'] ?? row['applied_count']) as num?)?.toInt() ??
                0,
        unlockedCount:
            ((row['unlockedCount'] ?? row['unlocked_count']) as num?)?.toInt() ??
                0,
        lastActiveOn:
            (row['lastActiveOn'] ?? row['last_active_on']) as String?,
      );

  /// Opaque worker referral handle — never a name/phone.
  final String ref;
  final bool profileComplete;
  final int appliedCount;
  final int unlockedCount;
  final String? lastActiveOn;

  @override
  List<Object?> get props =>
      <Object?>[ref, profileComplete, appliedCount, unlockedCount, lastActiveOn];
}

/// One freshly minted agency invite (`POST /payer/agency/invites/batch` rows).
/// Carries the opaque [agencyInviteId] plus the shareable [code] and [link]. A
/// batch mints [count] of these in one call.
class MintedInvite extends Equatable {
  const MintedInvite({
    required this.agencyInviteId,
    required this.code,
    required this.link,
  });

  factory MintedInvite.fromJson(Map<String, dynamic> row) => MintedInvite(
        agencyInviteId:
            (row['agency_invite_id'] ?? row['agencyInviteId']) as String? ?? '',
        code: row['code'] as String? ?? '',
        link: row['link'] as String? ?? '',
      );

  final String agencyInviteId;
  final String code;
  final String link;

  @override
  List<Object?> get props => <Object?>[agencyInviteId, code, link];
}

/// Result of publishing an AI job-posting chat draft
/// (`POST /payer/job-posting-chat/sessions/:id/publish`). Carries the created
/// [jobPostingId] the caller routes to, plus any [unmappedFields] the server
/// could not map from the conversational draft onto the structured posting
/// (empty when everything mapped cleanly) — surfaced so the UI can nudge the
/// payer to fill them on the posting afterwards.
class PublishJobResult extends Equatable {
  const PublishJobResult({
    required this.jobPostingId,
    this.unmappedFields = const <String>[],
  });

  final String jobPostingId;
  final List<String> unmappedFields;

  @override
  List<Object?> get props => <Object?>[jobPostingId, unmappedFields];
}

/// Identity resolved at login for a chosen [PayerRole]. Kept here so the data
/// seam (not the UI) owns the canned identities, ready to be replaced by an
/// authenticated `/me` response.
PayerAccount accountFor(PayerRole role) => role.isAgency
    ? const PayerAccount(
        name: 'Apex Staffing',
        plan: 'Agency · supply + demand',
        initials: 'AS',
      )
    : const PayerAccount(
        name: 'Kalyani Industries',
        plan: 'Company account',
        initials: 'KI',
      );

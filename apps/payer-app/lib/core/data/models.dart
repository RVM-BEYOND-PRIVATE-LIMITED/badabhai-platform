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
      ];
}

/// A credit pack on the Buy-credits screen. [count] is the unlock count; the
/// price strings are pre-formatted (₹ in Roboto Mono at the view).
class CreditPack extends Equatable {
  const CreditPack({
    required this.count,
    required this.countLabel,
    required this.price,
    required this.per,
    required this.best,
    this.code,
  });

  /// Numeric unlock count actually added to the balance.
  final int count;

  /// Display count ("1,000").
  final String countLabel;
  final String price;
  final String per;
  final bool best;

  /// The server pack code (`pack_50` | `pack_200` | `pack_1000`) sent to
  /// `POST /payer/credits`. The catalogue is config-only (no endpoint); this is
  /// the one field the REAL purchase actually uses. `null` for bespoke packs.
  final String? code;

  @override
  List<Object?> get props => <Object?>[count, countLabel, price, per, best, code];
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

/// The Home-screen demand snapshot (mock figures mirror the kit).
class HomeMetrics extends Equatable {
  const HomeMetrics({
    required this.paidUnlocksThisWeek,
    required this.paidUnlocksDelta,
    required this.repeatUnlockRate,
    required this.activeJobs,
    required this.activeJobsNote,
    required this.candidatesForYou,
  });

  final String paidUnlocksThisWeek;
  final String paidUnlocksDelta;
  final String repeatUnlockRate;
  final String activeJobs;
  final String activeJobsNote;
  final int candidatesForYou;

  @override
  List<Object?> get props => <Object?>[
        paidUnlocksThisWeek,
        paidUnlocksDelta,
        repeatUnlockRate,
        activeJobs,
        activeJobsNote,
        candidatesForYou,
      ];
}

/// The agency-only Earn·Supply summary shown on Home (above Hire metrics).
class EarnSummary extends Equatable {
  const EarnSummary({
    required this.earnedThisMonth,
    required this.pendingPayout,
    required this.inWindow,
  });

  final String earnedThisMonth;
  final String pendingPayout;
  final String inWindow;

  @override
  List<Object?> get props => <Object?>[earnedThisMonth, pendingPayout, inWindow];
}

/// Attribution state of a referred worker — drives the row's status pill,
/// window-countdown line, dimming, and the earned-₹ colour. PII-free by
/// construction: a referred worker is only ever a masked label, never a name.
///
///  - [inWindow] — introduced + profiled, inside the 90-day attribution window;
///    nothing earned yet (the agency earns only if someone unlocks them).
///  - [earned]   — someone unlocked them inside the window → the 25% share paid.
///  - [expired]  — the window lapsed with no unlock; no resets, nothing earned.
enum ReferralStatus { inWindow, earned, expired }

extension ReferralStatusX on ReferralStatus {
  String get label => switch (this) {
        ReferralStatus.inWindow => 'In window',
        ReferralStatus.earned => 'Earned',
        ReferralStatus.expired => 'Expired',
      };
}

/// One worker the agency introduced via its referral link. [label] is the masked
/// identity the agency is allowed to see ("••• 3210") — NEVER a real name or
/// phone. [daysLeft] is the remaining attribution window; [earned] is a
/// pre-formatted mono ₹ string ("₹0" / "₹40").
class ReferredWorker extends Equatable {
  const ReferredWorker({
    required this.id,
    required this.label,
    required this.trade,
    required this.status,
    required this.daysLeft,
    required this.earned,
  });

  final int id;

  /// Masked last-4 identity, e.g. "••• 3210". No PII.
  final String label;
  final String trade;
  final ReferralStatus status;

  /// Days remaining in the 90-day attribution window (0 once expired/earned).
  final int daysLeft;

  /// Pre-formatted mono ₹ earned on this worker ("₹0" until an unlock pays out).
  final String earned;

  bool get isExpired => status == ReferralStatus.expired;
  bool get isEarned => status == ReferralStatus.earned;

  /// The countdown / state line under the row.
  String get windowText => switch (status) {
        ReferralStatus.expired => 'Window expired · no resets',
        ReferralStatus.earned => 'Unlocked · earned',
        ReferralStatus.inWindow => '$daysLeft days left in window',
      };

  @override
  List<Object?> get props =>
      <Object?>[id, label, trade, status, daysLeft, earned];
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

/// Earnings & payouts aggregates for the payouts screen. All ₹ pre-formatted
/// mono strings. [pendingMet] gates the "ready to pay out" / Withdraw CTA.
class PayoutSummary extends Equatable {
  const PayoutSummary({
    required this.totalEarned,
    required this.thisMonth,
    required this.pending,
    required this.minimum,
    required this.pendingMet,
  });

  final String totalEarned;
  final String thisMonth;
  final String pending;
  final String minimum;

  /// True once [pending] is at/above [minimum] — unlocks the Withdraw CTA.
  final bool pendingMet;

  @override
  List<Object?> get props =>
      <Object?>[totalEarned, thisMonth, pending, minimum, pendingMet];
}

/// A settled payout row in the history list (most-recent first).
class PayoutEntry extends Equatable {
  const PayoutEntry({
    required this.label,
    required this.method,
    required this.date,
    required this.amount,
  });

  final String label;

  /// Rail, e.g. "UPI".
  final String method;

  /// Settlement date, e.g. "02 Jun".
  final String date;

  /// Pre-formatted mono ₹ ("₹4,160").
  final String amount;

  @override
  List<Object?> get props => <Object?>[label, method, date, amount];
}

/// KYC lifecycle for the agency payout account. Drives the KYC screen's state
/// machine + the badge on the Earn-hub card.
///
///  - [none]     — nothing submitted → show the PAN/bank form.
///  - [review]   — submitted, verifying (1–2 working days).
///  - [verified] — approved → withdrawals enabled.
enum KycStatus { none, review, verified }

extension KycStatusX on KycStatus {
  String get badgeLabel => switch (this) {
        KycStatus.none => 'Not started',
        KycStatus.review => 'In review',
        KycStatus.verified => 'Verified',
      };
}

/// The details an agency submits for payout KYC. This is the ONE place the
/// payer app collects PAN/bank data; on the mock seam it is never persisted or
/// logged — the screen only flips [KycStatus] to `review`.
class KycSubmission extends Equatable {
  const KycSubmission({
    required this.fullName,
    required this.pan,
    required this.accountNumber,
    required this.ifsc,
  });

  final String fullName;
  final String pan;
  final String accountNumber;
  final String ifsc;

  @override
  List<Object?> get props => <Object?>[fullName, pan, accountNumber, ifsc];
}

/// A recent-activity row on Home.
enum ActivityTone { success, brand, warning }

class ActivityItem extends Equatable {
  const ActivityItem({
    required this.title,
    required this.time,
    required this.tone,
  });

  final String title;
  final String time;
  final ActivityTone tone;

  @override
  List<Object?> get props => <Object?>[title, time, tone];
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
  final bool unlocked;

  /// The granted unlock id (set once a paid unlock succeeds) — carried so the
  /// Reveal screen can fetch the relay handle without a second unlock.
  final String? unlockId;

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
// OUT (the [AgencyJobView] projection). Phase-1 status is only `open|closed`
// (there is NO `paused` literal — a pause maps to closed server-side).

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
/// `POST/PATCH/close/pause` results). PII-free by construction: a coarse trade
/// key, generic title, city/area label, integer ₹ pay band, year counts, and a
/// coarse timing enum — NEVER an employer name or worker identity. [status] is
/// only `open|closed` (Phase-1 has no `paused` literal — a pause maps to
/// closed server-side; the difference is only in the emitted event).
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

  /// `open` | `closed` — the only Phase-1 states (a pause returns `closed`).
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

/// Result of `POST /payer/capacity` (buy/upgrade a tier). MIXED casing on the
/// wire: top-level `snake_case` (`max_active_vacancies` / `source_tier` /
/// `expires_at` / `resumed_plan_ids`) with a NESTED camelCase `quote`
/// (`finalInr`). [finalInr] is the charged ₹ for the toast; [resumedPlanIds]
/// are postings the higher allowance auto-un-paused. PII-free (opaque ids only).
class CapacityPurchase extends Equatable {
  const CapacityPurchase({
    required this.maxActiveVacancies,
    this.sourceTier,
    this.expiresAt,
    this.finalInr,
    this.resumedPlanIds = const <String>[],
  });

  factory CapacityPurchase.fromJson(Map<String, dynamic> body) {
    final Map<String, dynamic> quote =
        (body['quote'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    final List<dynamic> resumed =
        (body['resumed_plan_ids'] as List<dynamic>?) ?? const <dynamic>[];
    return CapacityPurchase(
      maxActiveVacancies: (body['max_active_vacancies'] as num?)?.toInt() ?? 0,
      sourceTier: body['source_tier'] as String?,
      expiresAt: body['expires_at'] as String?,
      // Nested quote is camelCase even though the top level is snake_case.
      finalInr: (quote['finalInr'] as num?)?.toInt(),
      resumedPlanIds: resumed.whereType<String>().toList(growable: false),
    );
  }

  final int maxActiveVacancies;
  final String? sourceTier;
  final String? expiresAt;
  final int? finalInr;
  final List<String> resumedPlanIds;

  @override
  List<Object?> get props => <Object?>[
        maxActiveVacancies,
        sourceTier,
        expiresAt,
        finalInr,
        resumedPlanIds,
      ];
}

/// A buyable hiring-capacity tier (ADR-0016 seeded catalog). The wire always
/// carries the [code] (`cap_5` | `cap_15`); the rest is display. An unknown code
/// is a fail-closed backend error (never a ₹0 buy) — never invent codes here.
class CapacityTier extends Equatable {
  const CapacityTier({
    required this.code,
    required this.maxActiveVacancies,
    required this.price,
    required this.validityLabel,
  });

  /// Server tier code sent as `tier` to `POST /payer/capacity`.
  final String code;

  /// Concurrent active vacancies this tier grants.
  final int maxActiveVacancies;

  /// Pre-formatted ₹ price ("₹5,000").
  final String price;

  /// Validity window label ("30 days").
  final String validityLabel;

  /// "5 active vacancies" — the tier headline.
  String get label => '$maxActiveVacancies active vacancies';

  @override
  List<Object?> get props =>
      <Object?>[code, maxActiveVacancies, price, validityLabel];
}

/// The seeded capacity tiers the payer can buy (mirrors the pricing catalog —
/// `cap_5` ₹5,000/5/30d, `cap_15` ₹12,000/15/30d). Display order = ascending.
const List<CapacityTier> kCapacityTiers = <CapacityTier>[
  CapacityTier(
    code: 'cap_5',
    maxActiveVacancies: 5,
    price: '₹5,000',
    validityLabel: '30 days',
  ),
  CapacityTier(
    code: 'cap_15',
    maxActiveVacancies: 15,
    price: '₹12,000',
    validityLabel: '30 days',
  ),
];

/// Display label for a capacity tier [code] (falls back to the raw code).
String capacityTierLabel(String? code) {
  if (code == null || code.isEmpty) return 'Base';
  for (final CapacityTier t in kCapacityTiers) {
    if (t.code == code) return t.label;
  }
  return code;
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

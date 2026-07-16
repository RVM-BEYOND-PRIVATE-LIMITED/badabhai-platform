/// Typed response models for the BadaBhai API.
///
/// These mirror the JSON shapes returned by the NestJS API (see apps/api).
/// JSON is snake_case; Dart fields are camelCase. Parsing is defensive so a
/// missing optional field can't crash the worker flow.
///
/// The value models are immutable [Equatable] (const ctors + value equality) so
/// they compose into BLoC states without breaking emit de-duplication. The two
/// exception types stay plain (they're thrown, not held in state).
library;

import 'package:equatable/equatable.dart';

/// Thrown when the API returns a non-2xx response.
class ApiException implements Exception {
  ApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// Thrown when an async profile-extraction job does not finish within the
/// client's bounded poll budget. The job may still complete server-side; the
/// caller can offer a retry.
class ProfileExtractionTimeout implements Exception {
  ProfileExtractionTimeout(this.aiJobId);

  final String aiJobId;

  @override
  String toString() =>
      'ProfileExtractionTimeout: job $aiJobId did not complete in time';
}

/// One job card the worker swipes on. Result item of GET /feed.
///
/// PII-free by contract: coarse [tradeKey] / [title] / [city] / [area] plus the
/// job's experience window in YEAR COUNTS — the API returns NO employer name and
/// NO pay, so this model carries none. Year counts are PII-free by the same rule
/// the schema applies to pay bands (`packages/db/src/schema.ts` jobs: "PII-FREE:
/// pay bands / year counts / a coarse timing enum" — never an employer, never a
/// worker identity). [rank] is the 1-based seed display position (not a
/// relevance rank).
class FeedItem extends Equatable {
  const FeedItem({
    required this.jobId,
    required this.tradeKey,
    required this.title,
    required this.city,
    required this.area,
    required this.rank,
    this.minExperienceYears,
    this.maxExperienceYears,
  });

  final String jobId;
  final String tradeKey;
  final String title;
  final String city;

  /// Coarse area/locality bucket. Nullable — not every job has one.
  final String? area;

  /// Experience window the job targets, in years — passed through HONESTLY by
  /// the API, nulls included: a null [minExperienceYears] means "no floor" and a
  /// null [maxExperienceYears] means "open-ended". Read the window as
  /// [min ?? 0, max ?? infinity]; do NOT coerce either null to 0 (that would
  /// invent a floor the employer never set). See `jobMatchesExperience` in
  /// features/swipe/domain/job_filter.dart for the matching rule.
  final int? minExperienceYears;
  final int? maxExperienceYears;

  /// 1-based seed display position the card was shown at. Sent back on apply so
  /// the server can record the position the decision was taken from.
  final int rank;

  factory FeedItem.fromJson(Map<String, dynamic> json) => FeedItem(
        jobId: json['job_id'] as String,
        tradeKey: json['trade_key'] as String? ?? '',
        title: json['title'] as String? ?? '',
        city: json['city'] as String? ?? '',
        area: json['area'] as String?,
        // Absent key and explicit null both land on null — "no bound stated".
        minExperienceYears: (json['min_experience_years'] as num?)?.toInt(),
        maxExperienceYears: (json['max_experience_years'] as num?)?.toInt(),
        rank: (json['rank'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[
        jobId,
        tradeKey,
        title,
        city,
        area,
        minExperienceYears,
        maxExperienceYears,
        rank,
      ];
}

/// A worker's apply/skip decision row from `GET /workers/me/applications` (the
/// "Applied jobs" screen filters to `action == 'applied'`). Coarse, PII-free
/// fields only — exactly the projection the ops service already returns. Parsing
/// is defensive: missing optionals → null; a missing/bad date → epoch (never
/// crashes).
class AppliedJob extends Equatable {
  const AppliedJob({
    required this.jobId,
    required this.tradeKey,
    required this.title,
    required this.city,
    required this.area,
    required this.action,
    required this.reason,
    required this.sourceSurface,
    required this.rank,
    required this.createdAt,
    required this.updatedAt,
  });

  final String jobId;

  /// One of the 15 alpha trades — kept as a plain String (no enum).
  final String tradeKey;
  final String title;
  final String city;

  /// Coarse locality bucket. Nullable — not every job has one.
  final String? area;

  /// 'applied' | 'skipped' — the list mixes both; the screen shows only
  /// 'applied' (matches the `ApplicationAction` enum on the API).
  final String action;

  /// Coarse skip reason enum, or null for an apply. Nullable.
  final String? reason;

  /// Where the decision was taken: 'feed' | 'search' | 'share' | 'other'.
  final String sourceSurface;

  /// 1-based feed position the decision was taken from. Nullable.
  final int? rank;

  final DateTime createdAt;
  final DateTime updatedAt;

  static DateTime _date(Object? v) =>
      DateTime.tryParse(v as String? ?? '') ??
      DateTime.fromMillisecondsSinceEpoch(0);

  factory AppliedJob.fromJson(Map<String, dynamic> json) => AppliedJob(
        jobId: json['job_id'] as String? ?? '',
        tradeKey: json['trade_key'] as String? ?? '',
        title: json['title'] as String? ?? '',
        city: json['city'] as String? ?? '',
        area: json['area'] as String?,
        action: json['action'] as String? ?? '',
        reason: json['reason'] as String?,
        sourceSurface: json['source_surface'] as String? ?? 'other',
        rank: (json['rank'] as num?)?.toInt(),
        createdAt: _date(json['created_at']),
        updatedAt: _date(json['updated_at']),
      );

  @override
  List<Object?> get props => <Object?>[
        jobId,
        tradeKey,
        title,
        city,
        area,
        action,
        reason,
        sourceSurface,
        rank,
        createdAt,
        updatedAt,
      ];
}

/// One worker Alerts row (GET /workers/me/notifications). PII-FREE by contract:
/// only an opaque event id, a coarse [type], faceless server copy, and a timestamp
/// — never an employer, pay, name, or phone. [type] is one of `resume_ready`,
/// `resume_updated`, `profile_ready`, `voice_processed`, `security`.
class WorkerNotification extends Equatable {
  const WorkerNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.createdAt,
  });

  final String id;
  final String type;
  final String title;
  final String body;
  final DateTime createdAt;

  factory WorkerNotification.fromJson(Map<String, dynamic> json) =>
      WorkerNotification(
        id: json['id'] as String? ?? '',
        type: json['type'] as String? ?? '',
        title: json['title'] as String? ?? '',
        body: json['body'] as String? ?? '',
        createdAt: DateTime.tryParse(json['created_at'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
      );

  @override
  List<Object?> get props => <Object?>[id, type, title, body, createdAt];
}

/// Result of POST /applications/:jobId/apply.
class ApplyResult extends Equatable {
  const ApplyResult({
    required this.ok,
    required this.applicationId,
    required this.action,
  });

  final bool ok;
  final String applicationId;
  final String action;

  factory ApplyResult.fromJson(Map<String, dynamic> json) => ApplyResult(
        ok: json['ok'] as bool? ?? false,
        applicationId: json['application_id'] as String? ?? '',
        action: json['action'] as String? ?? 'applied',
      );

  @override
  List<Object?> get props => <Object?>[ok, applicationId, action];
}

/// Result of POST /applications/:jobId/skip.
class SkipResult extends Equatable {
  const SkipResult({
    required this.ok,
    required this.applicationId,
    required this.action,
  });

  final bool ok;
  final String applicationId;
  final String action;

  factory SkipResult.fromJson(Map<String, dynamic> json) => SkipResult(
        ok: json['ok'] as bool? ?? false,
        applicationId: json['application_id'] as String? ?? '',
        action: json['action'] as String? ?? 'skipped',
      );

  @override
  List<Object?> get props => <Object?>[ok, applicationId, action];
}

/// Result of POST /chat/message.
class ChatReply extends Equatable {
  const ChatReply({
    required this.reply,
    required this.blocked,
    required this.isMock,
    required this.suggestedFollowups,
  });

  final String reply;
  final bool blocked;
  final bool isMock;
  final List<String> suggestedFollowups;

  factory ChatReply.fromJson(Map<String, dynamic> json) => ChatReply(
        reply: json['reply'] as String? ?? '',
        blocked: json['blocked'] as bool? ?? false,
        isMock: json['is_mock'] as bool? ?? false,
        suggestedFollowups: (json['suggested_followups'] as List<dynamic>?)
                ?.map((dynamic e) => e as String)
                .toList() ??
            <String>[],
      );

  @override
  List<Object?> get props => <Object?>[reply, blocked, isMock, suggestedFollowups];
}

/// Result of POST /profile/extract.
///
/// Profile extraction is now asynchronous: the API enqueues a background job
/// (BullMQ) and returns 202 with the job id. The client polls GET /ai-jobs/{id}
/// (see [AiJob]) until the job completes and yields a profile id.
class EnqueueResult extends Equatable {
  const EnqueueResult({
    required this.aiJobId,
    required this.status,
  });

  final String aiJobId;
  final String status;

  factory EnqueueResult.fromJson(Map<String, dynamic> json) => EnqueueResult(
        aiJobId: json['ai_job_id'] as String,
        status: json['status'] as String? ?? 'queued',
      );

  @override
  List<Object?> get props => <Object?>[aiJobId, status];
}

/// One async AI job. Result of GET /ai-jobs/{id} (NO auth — see the contract).
///
/// [status] moves queued -> running -> completed | failed. On a completed
/// PROFILE-extraction job [profileId] (read from `output_ref.profile_id`) is
/// non-null; on a completed TRANSCRIPTION job [voiceNoteId] (read from
/// `output_ref.voice_note_id`) is non-null. When failed, [errorMessage] explains
/// why. The `output_ref` for transcription carries only the voice-note id — NOT
/// the transcript text (there is no route that returns the transcript body; see
/// the A2-storage blocker), so this model exposes the reference only.
class AiJob extends Equatable {
  const AiJob({
    required this.id,
    required this.jobType,
    required this.status,
    required this.profileId,
    required this.errorMessage,
    this.voiceNoteId,
  });

  final String id;
  final String jobType;
  final String status;
  final String? profileId;
  final String? errorMessage;

  /// Set from `output_ref.voice_note_id` when this is a completed transcription
  /// job. Null for profile-extraction jobs.
  final String? voiceNoteId;

  bool get isCompleted => status == 'completed';
  bool get isFailed => status == 'failed';

  /// True once the job has reached a terminal state (completed OR failed) — the
  /// poll loop stops here.
  bool get isTerminal => isCompleted || isFailed;

  factory AiJob.fromJson(Map<String, dynamic> json) {
    final dynamic outputRef = json['output_ref'];
    final Map<String, dynamic>? ref =
        outputRef is Map<String, dynamic> ? outputRef : null;
    return AiJob(
      id: json['id'] as String? ?? '',
      jobType: json['job_type'] as String? ?? '',
      status: json['status'] as String? ?? 'queued',
      profileId: ref?['profile_id'] as String?,
      voiceNoteId: ref?['voice_note_id'] as String?,
      errorMessage: json['error_message'] as String?,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[id, jobType, status, profileId, errorMessage, voiceNoteId];
}

/// Result of POST /voice/upload (A2a). Registers an already-stored audio clip so
/// it can be transcribed. PII-FREE: the clip is referenced by an opaque
/// [voiceNoteId] and a server-side [storagePath] — no audio bytes, transcript, or
/// worker identity live here.
class VoiceUploadResult extends Equatable {
  const VoiceUploadResult({
    required this.voiceNoteId,
    required this.durationSeconds,
  });

  final String voiceNoteId;
  final int durationSeconds;

  factory VoiceUploadResult.fromJson(Map<String, dynamic> json) =>
      VoiceUploadResult(
        voiceNoteId: json['voice_note_id'] as String? ?? '',
        durationSeconds: (json['duration_seconds'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[voiceNoteId, durationSeconds];
}

/// Result of POST /voice/upload-url (A2-storage). The server mints a
/// worker-scoped storage slot: [storagePath] (`voice-notes/<workerId>/<uuid>.m4a`
/// — the exact value POST /voice/upload expects back) plus a short-lived signed
/// [uploadUrl] the clip bytes are PUT to.
///
/// PRIVACY: [uploadUrl] embeds a signing token — never log or persist it; use it
/// immediately and re-mint on expiry. [storagePath] is PII-free (opaque ids).
class VoiceUploadTicket extends Equatable {
  const VoiceUploadTicket({
    required this.storagePath,
    required this.uploadUrl,
    required this.expiresInSeconds,
  });

  final String storagePath;
  final String uploadUrl;
  final int expiresInSeconds;

  factory VoiceUploadTicket.fromJson(Map<String, dynamic> json) =>
      VoiceUploadTicket(
        storagePath: json['storage_path'] as String? ?? '',
        uploadUrl: json['upload_url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[storagePath, uploadUrl, expiresInSeconds];
}

/// Result of GET /voice/:voiceNoteId — the registered clip + its transcript once
/// the STT job has landed. [transcriptText] (source language) is preferred over
/// [transcriptEnglish]; both are null while transcription is pending.
///
/// PII NOTE: the transcript is worker-authored content (may carry personal
/// detail). It is held transiently to merge into the chat — NEVER logged.
class VoiceNoteDetail extends Equatable {
  const VoiceNoteDetail({
    required this.voiceNoteId,
    required this.durationSeconds,
    required this.transcriptText,
    required this.transcriptEnglish,
    required this.transcriptConfidence,
  });

  final String voiceNoteId;
  final int durationSeconds;
  final String? transcriptText;
  final String? transcriptEnglish;
  final double? transcriptConfidence;

  factory VoiceNoteDetail.fromJson(Map<String, dynamic> json) =>
      VoiceNoteDetail(
        voiceNoteId: json['voice_note_id'] as String? ?? '',
        durationSeconds: (json['duration_seconds'] as num?)?.toInt() ?? 0,
        transcriptText: json['transcript_text'] as String?,
        transcriptEnglish: json['transcript_english'] as String?,
        transcriptConfidence: (json['transcript_confidence'] as num?)?.toDouble(),
      );

  @override
  List<Object?> get props => <Object?>[
        voiceNoteId,
        durationSeconds,
        transcriptText,
        transcriptEnglish,
        transcriptConfidence,
      ];
}

/// Result of POST /voice/transcribe (A2b). Enqueues an STT job for a registered
/// voice note; poll GET /ai-jobs/{id} on [aiJobId] until it is terminal.
class TranscribeResult extends Equatable {
  const TranscribeResult({required this.aiJobId, required this.status});

  final String aiJobId;
  final String status;

  factory TranscribeResult.fromJson(Map<String, dynamic> json) =>
      TranscribeResult(
        aiJobId: json['ai_job_id'] as String? ?? '',
        status: json['status'] as String? ?? 'queued',
      );

  @override
  List<Object?> get props => <Object?>[aiJobId, status];
}

/// Result of POST /invites (A3). The server mints a referral [code] (12 hex) and
/// a relative [link] (`/i/<code>`); the share sheet composes the absolute URL.
/// PII-FREE: no worker phone/name — only the opaque invite id + code.
class InviteResult extends Equatable {
  const InviteResult({
    required this.inviteId,
    required this.code,
    required this.link,
  });

  final String inviteId;
  final String code;

  /// Server-relative path, e.g. `/i/ab12cd34ef56`. The invite cubit composes the
  /// absolute share URL by prefixing the configured invite-link base.
  final String link;

  factory InviteResult.fromJson(Map<String, dynamic> json) => InviteResult(
        inviteId: json['invite_id'] as String? ?? '',
        code: json['code'] as String? ?? '',
        link: json['link'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[inviteId, code, link];
}

/// Result of POST /auth/account/delete/request (A4). Starts the DPDP delete OTP
/// flow. [resendInSeconds] is the cooldown before another request is allowed.
class AccountDeleteRequestResult extends Equatable {
  const AccountDeleteRequestResult({
    required this.success,
    required this.resendInSeconds,
  });

  final bool success;
  final int resendInSeconds;

  factory AccountDeleteRequestResult.fromJson(Map<String, dynamic> json) =>
      AccountDeleteRequestResult(
        success: json['success'] as bool? ?? false,
        resendInSeconds: (json['resend_in_seconds'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[success, resendInSeconds];
}

/// Result of GET /resume/:id/download (ADR-0009 Stream C / G1c).
///
/// A short-lived, server-minted SIGNED url to the worker's resume PDF, plus its
/// TTL in seconds. PRIVACY: [url] embeds a single-use token — it must NEVER be
/// logged, persisted, or held in a BLoC state; launch it immediately and
/// re-fetch when it expires.
class ResumeDownload extends Equatable {
  const ResumeDownload({required this.url, required this.expiresInSeconds});

  final String url;
  final int expiresInSeconds;

  factory ResumeDownload.fromJson(Map<String, dynamic> json) => ResumeDownload(
        url: json['url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[url, expiresInSeconds];
}

/// Result of GET /interview-kit/:tradeKey/download.
///
/// A short-lived SIGNED url to the trade's interview-kit PDF (PII-free, static
/// curated content — the route is public). Same privacy rule as
/// [ResumeDownload]: [url] embeds a token; never log it, re-fetch on expiry.
class InterviewKitDownload extends Equatable {
  const InterviewKitDownload({required this.url, required this.expiresInSeconds});

  final String url;
  final int expiresInSeconds;

  factory InterviewKitDownload.fromJson(Map<String, dynamic> json) =>
      InterviewKitDownload(
        url: json['url'] as String? ?? '',
        expiresInSeconds: (json['expires_in'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[url, expiresInSeconds];
}

/// Result of POST /resume/generate.
class ResumeResult extends Equatable {
  const ResumeResult({
    required this.resumeId,
    required this.version,
    required this.resumeText,
    required this.isMock,
  });

  final String resumeId;
  final int version;
  final String resumeText;
  final bool isMock;

  factory ResumeResult.fromJson(Map<String, dynamic> json) => ResumeResult(
        resumeId: json['resume_id'] as String,
        version: (json['version'] as num?)?.toInt() ?? 1,
        resumeText: json['resume_text'] as String? ?? '',
        isMock: json['is_mock'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[resumeId, version, resumeText, isMock];
}

/// The worker-editable resume "safe fields" (GET /workers/me/resume-fields) — the
/// worker's OWN name spelling + the two display prefs. `fullName` is null until a
/// name is set; the edit screen renders it as an empty spelling to fill in.
class ResumeFieldsDto extends Equatable {
  const ResumeFieldsDto({
    required this.fullName,
    required this.showPhoto,
    required this.nightShiftReady,
  });

  final String? fullName;
  final bool showPhoto;
  final bool nightShiftReady;

  factory ResumeFieldsDto.fromJson(Map<String, dynamic> json) => ResumeFieldsDto(
        fullName: json['full_name'] as String?,
        showPhoto: json['show_photo'] as bool? ?? true,
        nightShiftReady: json['night_shift_ready'] as bool? ?? false,
      );

  @override
  List<Object?> get props => <Object?>[fullName, showPhoto, nightShiftReady];
}

/// Worker's current profile + latest resume (GET /workers/:id/profile). Used to
/// restore the session's profileId (and reuse an already-generated resume) for a
/// worker who logged in without re-running profiling this session. Any field is
/// null when the worker has no profile / no resume yet. Parses both snake_case
/// and camelCase since this endpoint returns raw rows.
class WorkerProfileBundle extends Equatable {
  const WorkerProfileBundle({this.profileId, this.resumeId, this.resumeText});

  final String? profileId;
  final String? resumeId;
  final String? resumeText;

  bool get hasProfile => profileId != null && profileId!.isNotEmpty;
  bool get hasResume =>
      resumeId != null && resumeText != null && resumeText!.isNotEmpty;

  factory WorkerProfileBundle.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic>? profile =
        json['profile'] as Map<String, dynamic>?;
    final Map<String, dynamic>? resume =
        json['resume'] as Map<String, dynamic>?;
    return WorkerProfileBundle(
      profileId: profile?['id'] as String?,
      resumeId: resume?['id'] as String?,
      resumeText: (resume?['resume_text'] ?? resume?['resumeText']) as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[profileId, resumeId, resumeText];
}

/// Response of GET /workers/me/profile-summary (WorkerProfileSummary,
/// apps/api workers.dto.ts). Mirrors the wire shape EXACTLY: a flat object with
/// a nested `trade` block.
///
/// PII posture (CLAUDE.md §2): there is NO name field — the `Namaste, <name>`
/// line is an OPEN §2 escalation and is deliberately omitted server-side, so the
/// client never receives (and never fabricates) a name. `city` is the only
/// sensitive field here and must NEVER be logged. `strength` is an integer
/// SIGNAL COUNT (countFields-equivalent), 0 when no profile — not a fraction.
class ProfileSummaryDto extends Equatable {
  const ProfileSummaryDto({
    required this.profileStatus,
    required this.confirmedAt,
    required this.tradeDisplayName,
    required this.canonicalTradeId,
    required this.canonicalRoleId,
    required this.city,
    required this.strength,
    this.strengthMax,
  });

  /// `"none"` when the worker has no profile row yet; else a ProfileStatus.
  final String profileStatus;

  /// ISO-8601, `null` until the profile is confirmed.
  final String? confirmedAt;

  /// `trade.display_name` — `null` until the trade is canonicalized.
  final String? tradeDisplayName;
  final String? canonicalTradeId;
  final String? canonicalRoleId;

  /// First of `location_preference.preferred_cities`; `null` when absent. PII.
  final String? city;

  /// Recomputed-on-read signal COUNT; `0` when no profile. NOT a 0..1 fraction.
  final int strength;

  /// The count's denominator (`strength_max`) — NOT sent by the API today, so
  /// this is null on the live wire. Parsed defensively now so a real N/max
  /// meter lights up the day the backend ships it (WA-4 seam); the UI never
  /// fabricates a denominator while it is null.
  final int? strengthMax;

  factory ProfileSummaryDto.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> trade =
        (json['trade'] as Map<String, dynamic>?) ?? const <String, dynamic>{};
    return ProfileSummaryDto(
      profileStatus: json['profile_status'] as String? ?? 'none',
      confirmedAt: json['confirmed_at'] as String?,
      tradeDisplayName: trade['display_name'] as String?,
      canonicalTradeId: trade['canonical_trade_id'] as String?,
      canonicalRoleId: trade['canonical_role_id'] as String?,
      city: json['city'] as String?,
      strength: (json['strength'] as num?)?.toInt() ?? 0,
      strengthMax: (json['strength_max'] as num?)?.toInt(),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        profileStatus,
        confirmedAt,
        tradeDisplayName,
        canonicalTradeId,
        canonicalRoleId,
        city,
        strength,
        strengthMax,
      ];
}

/// One row of GET /interview-kits (InterviewKitListItem, apps/api
/// interview-kit.dto.ts). PII-FREE by construction (per-trade, never per-worker).
class InterviewKitListItem extends Equatable {
  const InterviewKitListItem({
    required this.tradeKey,
    required this.displayName,
  });

  final String tradeKey;
  final String displayName;

  factory InterviewKitListItem.fromJson(Map<String, dynamic> json) =>
      InterviewKitListItem(
        tradeKey: json['trade_key'] as String? ?? '',
        displayName: json['display_name'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[tradeKey, displayName];
}

/// Response of GET /interview-kits/:tradeKey (InterviewKitContent, apps/api
/// interview-kit-content.ts). A per-trade PREP PACK — an overview, four question
/// LISTS (there are NO model answers on the wire — this is not a Q&A-with-answers
/// set), a skill checklist, revise-before / documents-to-carry / common-mistakes
/// lists, and a Hinglish note. PII-FREE by construction. Mirrors the DTO exactly.
class InterviewKitContentDto extends Equatable {
  const InterviewKitContentDto({
    required this.tradeKey,
    required this.displayName,
    required this.overview,
    required this.commonQuestions,
    required this.practicalQuestions,
    required this.safetyQuestions,
    required this.drawingMeasurementQuestions,
    required this.skillChecklist,
    required this.reviseBefore,
    required this.documentsToCarry,
    required this.commonMistakes,
    required this.hinglishNote,
  });

  final String tradeKey;
  final String displayName;
  final String overview;
  final List<String> commonQuestions;
  final List<String> practicalQuestions;
  final List<String> safetyQuestions;
  final List<String> drawingMeasurementQuestions;
  final List<String> skillChecklist;
  final List<String> reviseBefore;
  final List<String> documentsToCarry;
  final List<String> commonMistakes;
  final String hinglishNote;

  static List<String> _strList(Object? value) => value is List
      ? value.whereType<String>().toList(growable: false)
      : const <String>[];

  factory InterviewKitContentDto.fromJson(Map<String, dynamic> json) =>
      InterviewKitContentDto(
        tradeKey: json['trade_key'] as String? ?? '',
        displayName: json['display_name'] as String? ?? '',
        overview: json['overview'] as String? ?? '',
        commonQuestions: _strList(json['common_questions']),
        practicalQuestions: _strList(json['practical_questions']),
        safetyQuestions: _strList(json['safety_questions']),
        drawingMeasurementQuestions:
            _strList(json['drawing_measurement_questions']),
        skillChecklist: _strList(json['skill_checklist']),
        reviseBefore: _strList(json['revise_before']),
        documentsToCarry: _strList(json['documents_to_carry']),
        commonMistakes: _strList(json['common_mistakes']),
        hinglishNote: json['hinglish_note'] as String? ?? '',
      );

  @override
  List<Object?> get props => <Object?>[
        tradeKey,
        displayName,
        overview,
        commonQuestions,
        practicalQuestions,
        safetyQuestions,
        drawingMeasurementQuestions,
        skillChecklist,
        reviseBefore,
        documentsToCarry,
        commonMistakes,
        hinglishNote,
      ];
}

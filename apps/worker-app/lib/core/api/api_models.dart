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

/// Result of POST /auth/otp/verify.
///
/// Carries the bearer [accessToken] the API mints for the worker session. The
/// app stores it (in-memory, in the SessionRepository) and sends it as
/// `Authorization: Bearer <token>` on worker-scoped routes (feed / apply /
/// skip). It is the worker's own session credential — never logged, never
/// persisted to disk.
class VerifyOtpResult extends Equatable {
  const VerifyOtpResult({
    required this.workerId,
    required this.accessToken,
    required this.isNewWorker,
    required this.status,
  });

  final String workerId;
  final String accessToken;
  final bool isNewWorker;
  final String status;

  factory VerifyOtpResult.fromJson(Map<String, dynamic> json) => VerifyOtpResult(
        workerId: json['worker_id'] as String,
        accessToken: json['access_token'] as String? ?? '',
        isNewWorker: json['is_new_worker'] as bool? ?? false,
        status: json['status'] as String? ?? 'active',
      );

  @override
  List<Object?> get props => <Object?>[workerId, accessToken, isNewWorker, status];
}

/// One job card the worker swipes on. Result item of GET /feed.
///
/// PII-free by contract: coarse [tradeKey] / [title] / [city] / [area] only —
/// the API returns NO employer name and NO pay, so this model carries none.
/// [rank] is the 1-based seed display position (not a relevance rank).
class FeedItem extends Equatable {
  const FeedItem({
    required this.jobId,
    required this.tradeKey,
    required this.title,
    required this.city,
    required this.area,
    required this.rank,
  });

  final String jobId;
  final String tradeKey;
  final String title;
  final String city;

  /// Coarse area/locality bucket. Nullable — not every job has one.
  final String? area;

  /// 1-based seed display position the card was shown at. Sent back on apply so
  /// the server can record the position the decision was taken from.
  final int rank;

  factory FeedItem.fromJson(Map<String, dynamic> json) => FeedItem(
        jobId: json['job_id'] as String,
        tradeKey: json['trade_key'] as String? ?? '',
        title: json['title'] as String? ?? '',
        city: json['city'] as String? ?? '',
        area: json['area'] as String?,
        rank: (json['rank'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => <Object?>[jobId, tradeKey, title, city, area, rank];
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

/// One async AI job. Result of GET /ai-jobs/{id}.
///
/// [status] moves queued -> running -> completed | failed. When completed,
/// [profileId] (read from `output_ref.profile_id`) is non-null. When failed,
/// [errorMessage] explains why.
class AiJob extends Equatable {
  const AiJob({
    required this.id,
    required this.jobType,
    required this.status,
    required this.profileId,
    required this.errorMessage,
  });

  final String id;
  final String jobType;
  final String status;
  final String? profileId;
  final String? errorMessage;

  bool get isCompleted => status == 'completed';
  bool get isFailed => status == 'failed';

  factory AiJob.fromJson(Map<String, dynamic> json) {
    final dynamic outputRef = json['output_ref'];
    final String? profileId = outputRef is Map<String, dynamic>
        ? outputRef['profile_id'] as String?
        : null;
    return AiJob(
      id: json['id'] as String? ?? '',
      jobType: json['job_type'] as String? ?? '',
      status: json['status'] as String? ?? 'queued',
      profileId: profileId,
      errorMessage: json['error_message'] as String?,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[id, jobType, status, profileId, errorMessage];
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

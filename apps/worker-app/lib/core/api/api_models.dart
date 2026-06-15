/// Typed response models for the BadaBhai API.
///
/// These mirror the JSON shapes returned by the NestJS API (see apps/api).
/// JSON is snake_case; Dart fields are camelCase. Parsing is defensive so a
/// missing optional field can't crash the worker flow.
library;

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
class VerifyOtpResult {
  VerifyOtpResult({
    required this.workerId,
    required this.isNewWorker,
    required this.status,
  });

  final String workerId;
  final bool isNewWorker;
  final String status;

  factory VerifyOtpResult.fromJson(Map<String, dynamic> json) => VerifyOtpResult(
        workerId: json['worker_id'] as String,
        isNewWorker: json['is_new_worker'] as bool? ?? false,
        status: json['status'] as String? ?? 'active',
      );
}

/// Result of POST /chat/message.
class ChatReply {
  ChatReply({
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
}

/// Result of POST /profile/extract.
///
/// Profile extraction is now asynchronous: the API enqueues a background job
/// (BullMQ) and returns 202 with the job id. The client polls GET /ai-jobs/{id}
/// (see [AiJob]) until the job completes and yields a profile id.
class EnqueueResult {
  EnqueueResult({
    required this.aiJobId,
    required this.status,
  });

  final String aiJobId;
  final String status;

  factory EnqueueResult.fromJson(Map<String, dynamic> json) => EnqueueResult(
        aiJobId: json['ai_job_id'] as String,
        status: json['status'] as String? ?? 'queued',
      );
}

/// One async AI job. Result of GET /ai-jobs/{id}.
///
/// [status] moves queued -> running -> completed | failed. When completed,
/// [profileId] (read from `output_ref.profile_id`) is non-null. When failed,
/// [errorMessage] explains why.
class AiJob {
  AiJob({
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
}

/// Result of POST /resume/generate.
class ResumeResult {
  ResumeResult({
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
}

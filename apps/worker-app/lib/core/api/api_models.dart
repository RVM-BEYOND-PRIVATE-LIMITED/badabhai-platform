/// Typed response models for the BadaBhai API.
///
/// These mirror the JSON shapes returned by the NestJS API (see apps/api).
/// JSON is snake_case; Dart fields are camelCase. Parsing is defensive so a
/// missing optional field can't crash the worker flow.

/// Thrown when the API returns a non-2xx response.
class ApiException implements Exception {
  ApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => 'ApiException($statusCode): $message';
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
class ExtractResult {
  ExtractResult({
    required this.profileId,
    required this.profileStatus,
    required this.isMock,
  });

  final String profileId;
  final String profileStatus;
  final bool isMock;

  factory ExtractResult.fromJson(Map<String, dynamic> json) => ExtractResult(
        profileId: json['profile_id'] as String,
        profileStatus: json['profile_status'] as String? ?? 'extracted',
        isMock: json['is_mock'] as bool? ?? false,
      );
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

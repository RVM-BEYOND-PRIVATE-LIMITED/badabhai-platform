import 'package:equatable/equatable.dart';

/// Immutable snapshot of the worker's in-memory session.
///
/// PRIVACY: [phoneE164] is transient (only while the worker is entering it) and
/// [sessionToken] is the worker's own bearer credential — both live ONLY in
/// memory, are never persisted to disk, and are never logged. The id fields are
/// opaque server UUIDs.
class Session extends Equatable {
  const Session({
    this.phoneE164,
    this.workerId,
    this.sessionToken,
    this.sessionId,
    this.profileId,
    this.resumeId,
  });

  final String? phoneE164;
  final String? workerId;
  final String? sessionToken;
  final String? sessionId;
  final String? profileId;
  final String? resumeId;

  Session copyWith({
    String? phoneE164,
    String? workerId,
    String? sessionToken,
    String? sessionId,
    String? profileId,
    String? resumeId,
  }) {
    return Session(
      phoneE164: phoneE164 ?? this.phoneE164,
      workerId: workerId ?? this.workerId,
      sessionToken: sessionToken ?? this.sessionToken,
      sessionId: sessionId ?? this.sessionId,
      profileId: profileId ?? this.profileId,
      resumeId: resumeId ?? this.resumeId,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[phoneE164, workerId, sessionToken, sessionId, profileId, resumeId];
}

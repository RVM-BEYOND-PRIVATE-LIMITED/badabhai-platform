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
    this.deletionScheduledFor,
  });

  final String? phoneE164;
  final String? workerId;
  final String? sessionToken;
  final String? sessionId;
  final String? profileId;
  final String? resumeId;

  /// When a pending account deletion is due (ADR-0031 grace window), or null
  /// when none is pending. PII-free — a timestamp only. Set from the OTP-verify
  /// login response / delete-confirm; cleared on cancel.
  final DateTime? deletionScheduledFor;

  /// Copies the session, overriding only the fields passed.
  ///
  /// [deletionScheduledFor] is DELIBERATELY NOT a parameter here (ADR-0031). Its
  /// null is meaningful — "no deletion pending" — and a `??` merge structurally
  /// cannot express it: passing null would silently retain a stale date rather
  /// than clear it, which is exactly how a cancelled deletion would keep
  /// prompting a worker to cancel it again. So the ONLY way to change it is the
  /// explicit [Session] constructor (see
  /// `SessionRepository.setDeletionScheduledFor`), and every copyWith carries
  /// the current value through untouched. Making the gap unreachable beats
  /// documenting it: this class of bug has already bitten once in this feature.
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
      deletionScheduledFor: deletionScheduledFor,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        phoneE164,
        workerId,
        sessionToken,
        sessionId,
        profileId,
        resumeId,
        deletionScheduledFor,
      ];
}

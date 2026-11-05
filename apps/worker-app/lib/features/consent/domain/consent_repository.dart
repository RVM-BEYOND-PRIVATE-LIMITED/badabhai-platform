import 'employer_contact.dart';

/// DPDP consent boundary. Records the worker's consent for the given purposes.
/// Implementations throw a [Failure] on error and take the worker from the
/// session (never from the widget).
abstract interface class ConsentRepository {
  /// Records consent. [age18Plus] is the worker's yes/no answer to the sign-up
  /// age gate — it rides the same call as the DPDP purposes.
  Future<void> acceptConsent({
    required List<String> purposes,
    required bool age18Plus,
  });

  /// Withdraws the session worker's DPDP consent (POST /consent/withdraw).
  /// Implementations throw a [Failure] on error and take the worker from the
  /// session bearer (never from the widget). On success the SERVER has revoked
  /// every session — the caller must hard-log-out locally.
  Future<void> withdrawConsent();

  /// The caller's LATEST consent row (GET /consent/me, #1637) — the server truth
  /// the stop-employer-contact switch renders from. Throws a [Failure] on error.
  Future<EmployerContactInfo> employerContactState();

  /// The PER-PURPOSE exit from employer contact (POST
  /// /consent/employer-contact/withdraw, E0 C-2). Unlike [withdrawConsent] this
  /// does NOT revoke sessions and keeps profiling/resume/voice. Idempotent.
  Future<void> withdrawEmployerContact();

  /// The way back IN (POST /consent/employer-contact/grant), certifying the
  /// current notice version. The server derives the purposes; idempotent.
  /// Throws a [Failure] on error (400 stale version, 404 no live row).
  Future<void> grantEmployerContact();
}

/// Resume boundary. Generates the worker's resume from the confirmed profile,
/// stores the resume id in the session, and returns the resume text.
/// Implementations throw a [Failure] on error.
abstract interface class ResumeRepository {
  Future<String> generateResume();

  /// Fetches a short-lived SIGNED url to the worker's resume PDF
  /// (GET /resume/:id/download). Reads the resume id + session token from the
  /// session. Throws a [Failure] on error. PRIVACY: the returned url embeds a
  /// token — callers launch it immediately and never log it.
  Future<String> resumeDownloadUrl();
}

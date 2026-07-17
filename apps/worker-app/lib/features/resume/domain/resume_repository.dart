/// Resume boundary. Generates the worker's resume from the confirmed profile,
/// stores the resume id in the session, and returns the resume text.
/// Implementations throw a [Failure] on error.
abstract interface class ResumeRepository {
  /// Returns the worker's resume text, REUSING the already-generated resume when
  /// one exists and only generating when there genuinely is none.
  ///
  /// [force] re-POSTs `/resume/generate` even when a resume exists — for a
  /// deliberate rebuild after the worker edits their NAME, which is baked in at
  /// generation time. Server-side a generate OVERWRITES the row and resets
  /// `render_status` to 'pending' with a null `pdf_storage_key`, so it also
  /// re-enqueues the PDF render. That is exactly right after a name change, and
  /// exactly wrong on a routine screen open — hence the flag rather than
  /// generating every time.
  Future<String> generateResume({bool force = false});

  /// Fetches a short-lived SIGNED url to the worker's resume PDF
  /// (GET /resume/:id/download). Reads the resume id + session token from the
  /// session. Throws a [Failure] on error. PRIVACY: the returned url embeds a
  /// token — callers launch it immediately and never log it.
  Future<String> resumeDownloadUrl();
}

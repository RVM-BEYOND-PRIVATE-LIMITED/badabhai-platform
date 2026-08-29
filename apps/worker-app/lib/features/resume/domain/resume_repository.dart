import '../../../core/api/api_models.dart' show ResumeDocument;

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

  /// Best-effort report that the worker shared their resume (POST
  /// /resume/:id/share → `resume.shared`, #1317). [channel] is a closed
  /// kResumeShareChannels enum token (whatsapp | link | download | other),
  /// never a link or any PII. Reads the resume id + session token from the
  /// session; a missing id/token or ANY transport error is SWALLOWED and NEVER
  /// thrown — this is fired after a successful native share, so a failed report
  /// must never surface to the worker or undo the share they just made.
  Future<void> reportShared(String channel);

  /// #1343 — the worker's OWN resume AS STRUCTURED DATA (GET
  /// /resume/document), the same projection the PDF template renders from.
  /// Reads the session token; NO resume id is needed (the server derives it).
  ///
  /// Returns null — and NEVER THROWS — when the server has none (an ordinary
  /// `document: null` answer, or a 404 because there is no resume row at all
  /// yet) OR on ANY transport failure. This is a best-effort UPGRADE over the
  /// `resume_text` rendering path: that path stays the resume tab's source of
  /// truth on any hiccup here, so a caller must treat null as "render the
  /// text instead", never as "the worker has no resume".
  Future<ResumeDocument?> loadResumeDocument();

  /// #1353/#1354 — records the worker's choice of which text prints for ONE
  /// work-history entry: [ownWords] `true` keeps what they typed (`source:
  /// "own_words"`), `false` (re-)selects the model's rewrite (`source:
  /// "polished"`). Reversible in both directions.
  ///
  /// UNLIKE [loadResumeDocument] and [reportShared], this NEVER swallows a
  /// failure — it PROPAGATES a [Failure] (throws [UnauthorizedFailure] with no
  /// session; maps any transport error via the usual [mapError]). The worker
  /// tapped a specific, deliberate choice about a sentence carrying their name;
  /// a failed write must surface honestly, never look like it silently worked.
  /// A 404 (the id does not belong to this worker, or does not exist) is one
  /// such honest failure — it should not happen from this screen (the id comes
  /// straight from the document the worker is looking at), but is never turned
  /// into a silent no-op if it somehow does.
  Future<void> setEmploymentDescriptionSource(
    String employmentId, {
    required bool ownWords,
  });
}

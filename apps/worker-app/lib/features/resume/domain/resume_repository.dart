import '../../../core/api/api_models.dart'
    show ResumeDocument, ResumeHistory;

/// What ONE `GET /resume/document` call learned: the structured document (or
/// null) AND the PDF's real render state.
///
/// The two travel together because they arrive together. The alternative was
/// a second method — and therefore a second HTTP call on every resume load —
/// just to find out whether the PDF the first call described actually exists
/// yet.
class ResumeDocumentSnapshot {
  const ResumeDocumentSnapshot({
    this.document,
    this.renderStatus,
    this.renderedAt,
  });

  /// The structured projection, or null for the two ORDINARY reasons the
  /// wire documents (no projection yet / still pending its first render) and
  /// for any transport failure. Never "the worker has no resume".
  final ResumeDocument? document;

  /// `'pending' | 'rendered' | 'failed'`, or null when unknown — a raw token
  /// the UI never prints. See [ResumeDocumentResponse.renderStatus].
  final String? renderStatus;

  /// When that render finished, straight from `GET /resume/document`
  /// (`rendered_at`). Null while pending, on a failure, or when the server
  /// omits it. Carried so the document poll can tell a STALE projection from
  /// a fresh one — see [isStalePendingDocument].
  final DateTime? renderedAt;

  /// True only when the server said `'rendered'`. Fails closed: unknown is
  /// not ready (ruling R6).
  bool get isRendered => renderStatus == 'rendered';

  /// The STALE-under-pending shape (`GET /resume/document` after a manual
  /// regenerate): a manual `POST /resume/generate` overwrites the row and
  /// resets `render_status` to `'pending'` with `rendered_at` null, but
  /// deliberately leaves the previous render's `document` in place — so a
  /// poll that stops on the first non-null document lands on the OLD skills
  /// (exactly the section-walk edit bug: back to step 1, change, submit, and
  /// the resume still prints the old list). `rendered_at: null` is what marks
  /// it stale; a caller waiting for the fresh render must keep polling.
  bool get isStalePendingDocument =>
      document != null && renderStatus == 'pending' && renderedAt == null;
}

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

  /// The same signed url for ONE SPECIFIC resume of the worker's (#1687) — a
  /// history card downloads ITS OWN pdf, not whatever the session last touched.
  ///
  /// [resumeDownloadUrl] is left exactly as it is rather than being widened:
  /// it reads the CURRENT resume id off the session and every existing caller
  /// means precisely that. Same error posture as it, including the 409 →
  /// [ResumeNotReadyFailure] mapping a still-rendering pdf needs.
  Future<String> resumeDownloadUrlFor(String resumeId);

  /// [reportShared] for ONE SPECIFIC resume (#1687). Same swallow-everything
  /// posture: a failed report must never cost the worker the share they made.
  Future<void> reportSharedFor(String resumeId, String channel);

  /// The worker's resume HISTORY — the newest few, plus whether an accepted
  /// chat update is still on its way (GET /resume/history, #1687 / #1688).
  ///
  /// NEVER THROWS and never reports an error state. It returns
  /// [ResumeHistory.empty] for every reason the route cannot answer, which the
  /// Resume tab renders as "no history section at all" — byte-identical to the
  /// screen before this feature existed. The route is an ADDITION to a screen
  /// that already works; it must never be able to break it.
  Future<ResumeHistory> loadResumeHistory();

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
  /// Returns a snapshot whose [ResumeDocumentSnapshot.document] is null — and
  /// NEVER THROWS — when the server has none (an ordinary `document: null`
  /// answer, or a 404 because there is no resume row at all yet) OR on ANY
  /// transport failure. This is a best-effort UPGRADE over the `resume_text`
  /// rendering path: that path stays the resume tab's source of truth on any
  /// hiccup here, so a caller must treat a null document as "render the text
  /// instead", never as "the worker has no resume".
  ///
  /// It returns a [ResumeDocumentSnapshot] rather than a bare document so the
  /// tab can gate its READY pill on the PDF's real `render_status` from the
  /// SAME call (ruling R6) instead of inferring readiness from the presence
  /// of resume text.
  Future<ResumeDocumentSnapshot> loadResumeDocument();

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

  /// The same choice for a free-text ANSWER rather than a work-history entry
  /// (#1492) — the fresher's `iti_project_work` sentence is the case it exists
  /// for, since he has no employments for the route above to address.
  ///
  /// [attributeKey] comes from the document's `own_words_key`, never a
  /// hardcoded string: the server allow-lists which answers may be re-sourced.
  /// Propagates a [Failure] for the same reason as the employment route — the
  /// worker tapped a deliberate choice about a sentence carrying their name.
  Future<void> setAnswerTextSource(
    String attributeKey, {
    required bool ownWords,
  });
}

import 'feedback_category.dart';

/// How a submit landed. The worker's TEXT reached the server in both cases; the
/// difference is only whether the photos they attached made it with it.
///
/// Returned (never thrown) so the screen can be HONEST about a partial success:
/// a report that sent minus its images is a success, not a failure, and the
/// worker is told the photo did not attach rather than left thinking it did.
enum FeedbackSubmitOutcome {
  /// The submit succeeded as sent — no images, or the images went with the text.
  sent,

  /// The text landed but the ATTACHMENTS did not: the submit that carried them
  /// was rejected server-side (a 5xx — e.g. the store cannot hold them on this
  /// deploy), so it was resent WITHOUT them. The report is filed; the photo is
  /// not attached to it.
  sentWithoutAttachments,
}

/// Boundary for submitting the worker's app feedback to the admin console.
///
/// Implementations read the bearer token off the session (never the widget) and
/// throw a [Failure] on error.
abstract interface class FeedbackRepository {
  /// Submit [message] (the worker's own words) with an optional [category].
  ///
  /// [screen] is the RAW route the worker was on when they opened Feedback. It is
  /// passed raw ON PURPOSE: the implementation normalizes it into a route pattern
  /// (dropping ids, query and fragment) at the wire boundary, so no caller can
  /// forget to and no caller has to know the contract. A value that cannot be
  /// normalized is simply not sent — it must never cost the worker their message.
  ///
  /// [attachmentPaths] are the server-owned storage keys of the images that
  /// UPLOADED (the screen uploads best-effort BEFORE calling this, so a dropped
  /// image is already absent). Defaults to empty — the overwhelming case — and an
  /// empty list is sent as an ABSENT `attachment_paths` on the wire, keeping a
  /// no-image submission byte-identical to a released build.
  ///
  /// Returns [FeedbackSubmitOutcome.sentWithoutAttachments] when the images had
  /// to be dropped for the text to land (see the enum); [FeedbackSubmitOutcome.sent]
  /// otherwise. Throws a [Failure] only when the text itself could not be filed.
  Future<FeedbackSubmitOutcome> submit({
    required String message,
    FeedbackCategory? category,
    String? screen,
    List<String> attachmentPaths = const <String>[],
  });
}

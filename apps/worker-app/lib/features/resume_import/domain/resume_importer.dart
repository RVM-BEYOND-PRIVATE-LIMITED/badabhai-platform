import 'resume_document.dart';

/// Where an import left the worker. FOUR cases, and THREE of them continue in
/// the chat — which is the shape of the feature, not a pessimistic reading of
/// it: only 9 of 21 declared trades have a form at all, so
/// [ResumeImportRoutedToChat] is the ordinary success, not the error path.
sealed class ResumeImportOutcome {
  const ResumeImportOutcome();
}

/// Parsed, and the server decided this worker's trade has a form to prefill.
class ResumeImportRoutedToForm extends ResumeImportOutcome {
  const ResumeImportRoutedToForm({this.formKind});

  /// The pack the résumé routed to, when the server named one. Carried for
  /// completeness only — the form screen loads its own schema from
  /// `GET /profiling/form` and does not take a kind from the client.
  final String? formKind;
}

/// Parsed, and the worker continues in the chat — with whatever the résumé
/// found already known to the server.
class ResumeImportRoutedToChat extends ResumeImportOutcome {
  const ResumeImportRoutedToChat();
}

/// The upload door is CLOSED server-side (`RESUME_UPLOADS_BUCKET` unset → 503).
///
/// THE STATE ON EVERY BOX TODAY, so it is a first-class outcome rather than an
/// error branch. Nothing left the device: the 503 comes from the mint, before
/// any bytes are PUT.
class ResumeImportUnavailable extends ResumeImportOutcome {
  const ResumeImportUnavailable();
}

/// Anything else — a failed parse, a refused confirm, a dropped connection, or
/// polling that ran out of patience.
///
/// ONE case for all of them ON PURPOSE (ruling D9). The server's
/// `failure_reason` is a closed machine vocabulary (`no_text_layer`,
/// `ocr_below_floor`, `parse_output_invalid`, …) and none of those words belong
/// on a worker's screen; every one of them means the same thing to him, which
/// is "the résumé did not work, and we carry on talking".
class ResumeImportFailed extends ResumeImportOutcome {
  const ResumeImportFailed();
}

/// The whole import: mint → PUT → register → poll → a routing decision.
///
/// NEVER THROWS. Every failure is an [ResumeImportOutcome], because the one
/// thing this must not do is leave a worker at a dead end (ruling D9) — and a
/// thrown exception is how a dead end happens by accident.
abstract interface class ResumeImporter {
  Future<ResumeImportOutcome> importResume(PickedResumeDocument document);
}

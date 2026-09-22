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
  const ResumeImportRoutedToChat({this.learnedNothing = false});

  /// #1660 — the import succeeded by every wire field but extracted NOTHING, so
  /// no identity turn is staged and the chat opens on the ordinary first
  /// question. The worker has to be told one honest line on the way, or he
  /// spends his data and his patience and gets no answer at all.
  ///
  /// FALSE unless the server said otherwise (see [ResumeImportDto.learnedNothing]):
  /// against a server that does not send the field this is today's behaviour,
  /// byte for byte.
  final bool learnedNothing;
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
/// ONE case for all of them ON PURPOSE (ruling D9): the worker is told one
/// thing and carries on talking, never given eight machine words.
///
/// [reason] is carried only so the client can tell apart the ONE distinction
/// that now matters to him (#1661, after the #1654 option-C ruling): a document
/// we could not read at all, versus a document we DID read where only our own
/// model reply was malformed. In the second case the server may still stage the
/// identity turn from the same text, so the chat can open on "Resume se ye
/// mila: … Kya ye aap hi hain?" — and telling him we could not read it a second
/// before that bubble is the app not listening to itself.
///
/// It is NEVER rendered. The display vocabulary stays closed
/// (`ResumeUploadNotice`); this is a routing input, not copy.
class ResumeImportFailed extends ResumeImportOutcome {
  const ResumeImportFailed({this.reason});

  /// The server's raw `failure_reason`, or null when we never got one (a
  /// dropped connection, an exhausted poll budget, a thrown error).
  final String? reason;

  /// The two reasons where extraction SUCCEEDED and only our model's reply was
  /// bad, ruled on #1654 (option C, 2026-09-22) as the only failures that may
  /// still carry a staged identity summary. Every other failure degrades inside
  /// the summary pipeline's own extraction and stages nothing.
  static const Set<String> readButModelFailedReasons = <String>{
    'parse_output_invalid',
    'parse_deadline_exceeded',
  };

  /// True when the document itself was read and only our reply was unusable.
  bool get documentWasRead =>
      reason != null && readButModelFailedReasons.contains(reason);
}

/// The whole import: mint → PUT → register → poll → a routing decision.
///
/// NEVER THROWS. Every failure is an [ResumeImportOutcome], because the one
/// thing this must not do is leave a worker at a dead end (ruling D9) — and a
/// thrown exception is how a dead end happens by accident.
abstract interface class ResumeImporter {
  Future<ResumeImportOutcome> importResume(PickedResumeDocument document);
}

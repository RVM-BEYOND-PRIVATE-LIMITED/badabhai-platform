import 'resume_document.dart';

/// Why a pick did not produce a document.
enum ResumePickRejection {
  /// The worker backed out of the picker. NOT an error — no message, no state
  /// change, the three doors simply stay on screen.
  cancelled,

  /// The chosen file is not one of the four types ruling D3 accepts.
  unsupportedType,

  /// Over [kResumeUploadMaxBytes]. Refused HERE so the worker's data is not
  /// spent uploading something the server will refuse anyway.
  tooLarge,

  /// The file could not be read off the device at all.
  unreadable,
}

/// The outcome of asking the worker for a document: exactly one of the two
/// fields is set.
class ResumePickResult {
  const ResumePickResult.picked(this.document) : rejection = null;
  const ResumePickResult.rejected(this.rejection) : document = null;

  final PickedResumeDocument? document;
  final ResumePickRejection? rejection;

  bool get isPicked => document != null;
}

/// Asking the worker for a résumé file.
///
/// Behind an interface for the same two reasons every other device seam in this
/// app is (`VoiceStorageUploader`, `PhotoUploader`, `LocationLookup`): mock mode
/// must never touch a platform channel, and the three-door screen must be
/// testable without one.
abstract interface class ResumeDocumentPicker {
  /// Opens the platform document picker, filtered to
  /// [ResumeDocumentKind.allExtensions], and reads the choice into memory.
  ///
  /// Never throws for an ordinary refusal — a cancel, a wrong type and an
  /// over-sized file all come back as a [ResumePickRejection] so the caller has
  /// one branch to render rather than a mix of results and exceptions.
  Future<ResumePickResult> pickResume();
}

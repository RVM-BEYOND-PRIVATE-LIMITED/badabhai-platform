import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../domain/resume_document.dart';
import '../../domain/resume_document_picker.dart';
import '../../domain/resume_importer.dart';

/// What the three-door screen is doing.
enum ResumeUploadStatus {
  /// The three doors, and NOTHING has been asked of the network. This is the
  /// state the screen is built in and returns to, and it is why doors 2 and 3
  /// are byte-for-byte today's behaviour.
  doors,

  /// The platform picker is open.
  picking,

  /// Bytes are moving, or the server is reading the document.
  working,

  /// Terminal: the screen must now leave. [ResumeUploadState.destination] says
  /// where and [ResumeUploadState.notice] says what to admit on the way.
  done,
}

/// Where the worker goes next. The screen owns the route constants; the cubit
/// owns the DECISION, so the decision is testable without a router.
enum ResumeUploadDestination { chat, tradeForm }

/// The one honest line shown when something did not work.
///
/// A CLOSED CLIENT VOCABULARY, and note what is NOT in it: the server's
/// `failure_reason`. `no_text_layer`, `ocr_below_floor` and
/// `parse_output_invalid` are machine causes; they mean the same single thing
/// to a worker, and ruling D9 asks for that one thing said plainly rather than
/// for eight ways of saying it.
enum ResumeUploadNotice {
  /// The upload door is switched off server-side. The state on every box today.
  uploadsUnavailable,

  /// The document was read but nothing usable came out of it — OR the upload
  /// itself did not complete. One line for both, on purpose: from where the
  /// worker sits they are the same event.
  couldNotRead,

  /// The chosen file is not a PDF, DOCX, JPEG or PNG.
  unsupportedType,

  /// Over the 10 MB ceiling.
  tooLarge,
}

class ResumeUploadState extends Equatable {
  const ResumeUploadState({
    this.status = ResumeUploadStatus.doors,
    this.destination,
    this.notice,
  });

  final ResumeUploadStatus status;

  /// Set only when [status] is [ResumeUploadStatus.done].
  final ResumeUploadDestination? destination;

  /// The line to show. May be set WITHOUT [status] being done — a rejected pick
  /// (wrong type, too large) leaves the worker on the three doors with an
  /// explanation, because there is a useful thing for him to do from there.
  final ResumeUploadNotice? notice;

  bool get isBusy =>
      status == ResumeUploadStatus.picking ||
      status == ResumeUploadStatus.working;

  bool get isDone => status == ResumeUploadStatus.done;

  @override
  List<Object?> get props => <Object?>[status, destination, notice];
}

/// Drives the résumé-upload door (#1499).
///
/// ── WHAT THIS CUBIT DELIBERATELY DOES NOT DO ────────────────────────────────
///
/// It makes NO request when it is created, and none at all unless the worker
/// taps the upload door. That is the pin holding the issue's hardest
/// requirement: doors 2 and 3 must be today's behaviour byte for byte, and the
/// only way to guarantee an identical request sequence and an identical first
/// chat turn is for the new screen to have contributed no requests to it. A
/// capability probe on entry — however cheap, however well-meant — would break
/// that, so the 503 is discovered by attempting the mint instead.
///
/// ── IT HOLDS NO DOCUMENT ────────────────────────────────────────────────────
///
/// The picked bytes are a local in [chooseDocument] and are gone when it
/// returns. A résumé is the densest PII this app touches; it never enters BLoC
/// state, where it would ride every `toString()`, every state-change log and
/// every crash report (the same rule `NameState` follows for a plaintext name).
class ResumeUploadCubit extends Cubit<ResumeUploadState> {
  ResumeUploadCubit({
    required ResumeDocumentPicker picker,
    required ResumeImporter importer,
  })  : _picker = picker,
        _importer = importer,
        super(const ResumeUploadState());

  final ResumeDocumentPicker _picker;
  final ResumeImporter _importer;

  /// Door 1 — pick a document, upload it, and route on what the server says.
  Future<void> chooseDocument() async {
    if (state.isBusy || state.isDone) return;

    emit(const ResumeUploadState(status: ResumeUploadStatus.picking));
    final ResumePickResult picked = await _picker.pickResume();
    if (isClosed) return;

    if (!picked.isPicked) {
      // A cancel is not an event: back to the doors with nothing said. The
      // other three rejections keep him on the doors WITH a reason, because
      // picking a different file is a thing he can actually do.
      emit(ResumeUploadState(notice: _noticeFor(picked.rejection!)));
      return;
    }

    emit(const ResumeUploadState(status: ResumeUploadStatus.working));
    final PickedResumeDocument document = picked.document!;
    final ResumeImportOutcome outcome = await _importer.importResume(document);
    if (isClosed) return;

    // EVERY branch below leaves the worker somewhere. There is no branch that
    // stays on this screen with an error, because that would be the dead end
    // ruling D9 forbids.
    emit(switch (outcome) {
      ResumeImportRoutedToForm() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.tradeForm,
        ),
      ResumeImportRoutedToChat() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
        ),
      ResumeImportUnavailable() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          notice: ResumeUploadNotice.uploadsUnavailable,
        ),
      ResumeImportFailed() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          notice: ResumeUploadNotice.couldNotRead,
        ),
    });
  }

  /// Doors 2 and 3 — "Hinglish mein baat karein" and "Mere paas resume nahi
  /// hai".
  ///
  /// TWO DOORS, ONE METHOD, and no notice: both are a plain continue to the
  /// chat, which is exactly what `/name` did before this screen existed. They
  /// are separate BUTTONS because they answer different questions a worker
  /// might be asking — but they must not be separate BEHAVIOUR, or one of them
  /// would drift off today's path.
  ///
  /// Emits state only; it issues no request of its own, so the chat's own first
  /// call is the first thing the network sees.
  void continueInChat() {
    if (state.isBusy || state.isDone) return;
    emit(const ResumeUploadState(
      status: ResumeUploadStatus.done,
      destination: ResumeUploadDestination.chat,
    ));
  }

  /// NULL for a cancel — a worker who backed out of the picker has not been
  /// told anything and does not need to be. Every other rejection names
  /// something he can act on.
  ResumeUploadNotice? _noticeFor(ResumePickRejection rejection) =>
      switch (rejection) {
        ResumePickRejection.cancelled => null,
        ResumePickRejection.unsupportedType =>
          ResumeUploadNotice.unsupportedType,
        ResumePickRejection.tooLarge => ResumeUploadNotice.tooLarge,
        ResumePickRejection.unreadable => ResumeUploadNotice.couldNotRead,
      };
}

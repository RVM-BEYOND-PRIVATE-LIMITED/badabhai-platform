import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../domain/resume_document.dart';
import '../../domain/resume_document_picker.dart';
import '../../domain/resume_importer.dart';

/// What the two-door screen is doing.
enum ResumeUploadStatus {
  /// The two doors, and NOTHING has been asked of the network. This is the
  /// state the screen is built in and returns to, and it is why the no-résumé
  /// door is byte-for-byte today's behaviour.
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
/// A CLOSED CLIENT VOCABULARY: the server's `failure_reason` is never shown.
/// `no_text_layer`, `ocr_below_floor`, `encrypted_document` and the rest are
/// machine causes that mean the same single thing to a worker, and ruling D9
/// asks for that one thing said plainly rather than for eight ways of saying it.
///
/// ONE DISTINCTION IS NOW REAL, though (#1661, after the #1654 option-C ruling
/// of 2026-09-22), and it is why this vocabulary has two failure buckets
/// instead of one: `parse_output_invalid` and `parse_deadline_exceeded` are
/// cases where the document WAS read and only our own model reply was
/// malformed. The server may still stage the identity summary off that same
/// text, so the chat can open on "Resume se ye mila: … Kya ye aap hi hain?".
/// Saying "we could not read it" a second before that bubble is the app
/// contradicting itself — so those two get [readButNoDetails], whose line makes
/// no claim about readability and sits truthfully in front of either chat
/// opening. The premise that every failure "means the same single thing" no
/// longer holds; nothing else about D9 changes.
enum ResumeUploadNotice {
  /// The upload door is switched off server-side. The state on every box today.
  uploadsUnavailable,

  /// We could not read the document at all — no text layer, an encrypted or
  /// empty file, OCR below the floor — or the upload itself did not complete.
  /// One line for all of them, on purpose: from where the worker sits they are
  /// the same event.
  couldNotRead,

  /// We DID read the document; what we could not do is turn it into details.
  /// Two ways to get here, and they are the same sentence to a worker:
  ///
  ///  - the parse FAILED on our side only (`parse_output_invalid` /
  ///    `parse_deadline_exceeded`), where the chat may still quote the document
  ///    back to him one screen later — so this line must never claim the file
  ///    was unreadable (#1661);
  ///  - the parse SUCCEEDED and extracted nothing (#1660), where no identity
  ///    turn is staged at all and this line is the only thing standing between
  ///    him and total silence.
  readButNoDetails,

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
    this.cameFromImport = false,
  });

  final ResumeUploadStatus status;

  /// Set only when [status] is [ResumeUploadStatus.done].
  final ResumeUploadDestination? destination;

  /// The line to show. May be set WITHOUT [status] being done — a rejected pick
  /// (wrong type, too large) leaves the worker on the two doors with an
  /// explanation, because there is a useful thing for him to do from there.
  final ResumeUploadNotice? notice;

  /// #1660 — this state came from a REAL import that routed to the chat and
  /// said nothing on the way. The chat screen then checks whether an identity
  /// turn was actually staged (`resume_pending`) and says the one honest line
  /// when none was, so an import that extracted nothing is never silent.
  ///
  /// False for the "Mere paas resume nahi hai" door (nothing was uploaded), for
  /// a closed upload door, and whenever a notice was already shown here.
  final bool cameFromImport;

  bool get isBusy =>
      status == ResumeUploadStatus.picking ||
      status == ResumeUploadStatus.working;

  bool get isDone => status == ResumeUploadStatus.done;

  @override
  List<Object?> get props =>
      <Object?>[status, destination, notice, cameFromImport];
}

/// Drives the résumé-upload door (#1499).
///
/// ── WHAT THIS CUBIT DELIBERATELY DOES NOT DO ────────────────────────────────
///
/// It makes NO request when it is created, and none at all unless the worker
/// taps the upload door. That is the pin holding the issue's hardest
/// requirement: the no-résumé door must be today's behaviour byte for byte,
/// and the only way to guarantee an identical request sequence and an
/// identical first chat turn is for the new screen to have contributed no
/// requests to it. A capability probe on entry — however cheap, however
/// well-meant — would break that, so the 503 is discovered by attempting the
/// mint instead.
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
      // RI-identity: EVERY successful upload goes to the chat first, form-routed or
      // not. The chat opens on the "is this you?" turn (confirm_first); Haan on a
      // form-routed import hands over to the form from there, Nahi interviews on.
      // Navigating form-routed uploads straight to the form skipped the identity
      // turn entirely — the worker never saw the yes/no.
      ResumeImportRoutedToForm() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          cameFromImport: true,
        ),
      // #1660 — an import that learned NOTHING is a clean success on the wire
      // and a silent one for the worker: no identity bubble is staged, so the
      // chat opens on the ordinary first question. He is told the one honest
      // line on the way through — still a continue, never a dead end (D9).
      ResumeImportRoutedToChat(learnedNothing: true) => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          notice: ResumeUploadNotice.readButNoDetails,
          // The server SAID it learned nothing, so the line is already said
          // here and the chat must not say it a second time.
          cameFromImport: false,
        ),
      // #1660 — a plain chat-routed success. We cannot yet tell from the import
      // read whether it extracted anything (that field is backend #1656), so
      // the chat itself finishes the job: it knows whether an identity turn was
      // staged, and says the line when none was. [cameFromImport] is what
      // separates this from a worker who never uploaded anything.
      ResumeImportRoutedToChat() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          cameFromImport: true,
        ),
      ResumeImportUnavailable() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          notice: ResumeUploadNotice.uploadsUnavailable,
        ),
      // #1661 — a document we READ but could not turn into details must not be
      // announced as unreadable: the identity turn may quote that very document
      // one screen later. Everything else keeps today's single line.
      ResumeImportFailed(documentWasRead: true) => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          notice: ResumeUploadNotice.readButNoDetails,
        ),
      ResumeImportFailed() => const ResumeUploadState(
          status: ResumeUploadStatus.done,
          destination: ResumeUploadDestination.chat,
          notice: ResumeUploadNotice.couldNotRead,
        ),
    });
  }

  /// Door 2 — "Mere paas resume nahi hai".
  ///
  /// A plain continue to the chat with no notice, because that is exactly what
  /// `/name` did before this screen existed and nothing has happened yet that
  /// the worker needs told.
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

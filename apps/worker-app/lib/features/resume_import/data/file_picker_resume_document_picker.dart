import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';

import '../domain/resume_document.dart';
import '../domain/resume_document_picker.dart';

/// REAL document picker: the platform document picker (Android
/// ACTION_OPEN_DOCUMENT / iOS UIDocumentPicker), filtered to the four types
/// ruling D3 accepts, read into memory and size-checked before it is handed on.
///
/// ── WHY `withData: false` ───────────────────────────────────────────────────
///
/// The plugin will happily buffer the whole document itself, and then we read
/// it again — two copies of a worker's résumé in memory for no gain. We read
/// the path once, here, and the plugin holds nothing.
///
/// ── WHY THE EXTENSION DECIDES THE TYPE ──────────────────────────────────────
///
/// Not the picker-reported mime. The Android document picker reports
/// `application/octet-stream` for a surprising share of real PDFs (it depends
/// on the provider app, not on the file), and a worker who picked his résumé
/// must not be told it is not one. The server re-reads the true content type
/// from Storage at confirm time and refuses a genuine mismatch, so being
/// generous here costs nothing and being strict here would cost real uploads.
///
/// PRIVACY: the file NAME is used for the extension check and nothing else. It
/// is not stored, not shown and not logged — workers name these files after
/// themselves, so a name is a full name.
class FilePickerResumeDocumentPicker implements ResumeDocumentPicker {
  const FilePickerResumeDocumentPicker();

  @override
  Future<ResumePickResult> pickResume() async {
    final FilePickerResult? result;
    try {
      result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ResumeDocumentKind.allExtensions,
        allowMultiple: false,
        // See the class docblock — we read the path ourselves.
        withData: false,
      );
    } catch (_) {
      // A platform channel that refuses to open the picker at all. No detail is
      // captured: the exception text can carry a provider URI, which can carry
      // a path with the worker's own name in it.
      return const ResumePickResult.rejected(ResumePickRejection.unreadable);
    }

    final PlatformFile? file = result?.files.isNotEmpty == true
        ? result!.files.first
        : null;
    // A null result IS the cancel — not an error, and the screen renders
    // nothing for it.
    if (file == null) {
      return const ResumePickResult.rejected(ResumePickRejection.cancelled);
    }

    final ResumeDocumentKind? kind =
        ResumeDocumentKind.forFileName(file.name);
    if (kind == null) {
      return const ResumePickResult.rejected(
        ResumePickRejection.unsupportedType,
      );
    }

    // Checked from the picker's OWN size before the bytes are read, so a
    // 40MB scan is refused without being loaded into a phone's memory first.
    if (file.size > kResumeUploadMaxBytes) {
      return const ResumePickResult.rejected(ResumePickRejection.tooLarge);
    }

    final String? path = file.path;
    if (path == null) {
      return const ResumePickResult.rejected(ResumePickRejection.unreadable);
    }

    final Uint8List bytes;
    try {
      bytes = await File(path).readAsBytes();
    } catch (_) {
      return const ResumePickResult.rejected(ResumePickRejection.unreadable);
    }

    // Re-checked against what was actually read: `file.size` is the provider's
    // claim, and this is the measurement.
    if (bytes.isEmpty) {
      return const ResumePickResult.rejected(ResumePickRejection.unreadable);
    }
    if (bytes.length > kResumeUploadMaxBytes) {
      return const ResumePickResult.rejected(ResumePickRejection.tooLarge);
    }

    return ResumePickResult.picked(
      PickedResumeDocument(kind: kind, bytes: bytes),
    );
  }
}

/// MOCK document picker: no platform channel, a tiny canned "document".
///
/// Returns a cancel by DEFAULT so mock mode does not silently invent an upload
/// nobody asked for; set [next] to walk the other branches.
class MockResumeDocumentPicker implements ResumeDocumentPicker {
  MockResumeDocumentPicker({ResumePickResult? next})
      : next = next ??
            const ResumePickResult.rejected(ResumePickRejection.cancelled);

  ResumePickResult next;

  @override
  Future<ResumePickResult> pickResume() async {
    await Future<void>.delayed(const Duration(milliseconds: 200));
    return next;
  }
}

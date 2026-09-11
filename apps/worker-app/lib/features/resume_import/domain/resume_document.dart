import 'dart:typed_data';

import 'package:equatable/equatable.dart';

/// The document types ruling D3 accepts — FOUR, because this is what workers
/// actually have.
///
/// PDF and DOCX cover a cybercafe export; JPEG and PNG cover a PHOTOGRAPH of a
/// printed sheet, which for this user base is the common case rather than the
/// fallback.
///
/// The [mime] strings mirror `RESUME_UPLOAD_MIME_TYPES` in `@badabhai/types`
/// exactly, and the server rejects anything else at the mint. [extension] is
/// what the device pickers filter on — the same closed set said the other way
/// round, because a picker takes extensions and an API takes mimes and neither
/// will take the other's spelling.
enum ResumeDocumentKind {
  pdf('application/pdf', <String>['pdf']),
  docx(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    <String>['docx'],
  ),
  jpeg('image/jpeg', <String>['jpg', 'jpeg']),
  png('image/png', <String>['png']);

  const ResumeDocumentKind(this.mime, this.extensions);

  /// The DECLARED content type. It picks the server's object-key extension and
  /// nothing else: the confirm step re-reads the real type from Storage and
  /// refuses a mismatch, so this is never a claim the client gets to make
  /// stick.
  final String mime;

  final List<String> extensions;

  /// Every extension the pickers may offer, flattened. Kept derived rather than
  /// written out again so a fifth document type widens both at once.
  static List<String> get allExtensions => <String>[
        for (final ResumeDocumentKind k in ResumeDocumentKind.values)
          ...k.extensions,
      ];

  /// The kind for a file NAME, or null when the extension is not one we accept.
  ///
  /// Matches on the extension rather than trusting a picker-reported mime: the
  /// Android document picker reports `application/octet-stream` for a
  /// surprising share of real PDFs, and a worker who picked a résumé must not
  /// be told it is not one.
  static ResumeDocumentKind? forFileName(String name) {
    final int dot = name.lastIndexOf('.');
    if (dot < 0 || dot == name.length - 1) return null;
    final String ext = name.substring(dot + 1).toLowerCase();
    for (final ResumeDocumentKind k in ResumeDocumentKind.values) {
      if (k.extensions.contains(ext)) return k;
    }
    return null;
  }
}

/// A document the worker has chosen, already read into memory.
///
/// BYTES, NOT A PATH, and deliberately so: the only consumer is the signed PUT,
/// the size cap has to be checked before anything leaves the device, and a path
/// that has to be re-read later is a path that can be gone by then (the
/// Android document picker hands out a cache copy the OS may evict).
///
/// PRIVACY: [bytes] is a worker's résumé — the densest PII this app ever holds.
/// It is never logged, never written anywhere on device by us, and dropped as
/// soon as the PUT resolves. [fileName] is WORSE than the bytes for leaking by
/// accident: workers name these files after themselves ("Ramesh Kumar CV.pdf"),
/// so it is used for the extension check and for nothing else — never shown,
/// never logged, never sent.
class PickedResumeDocument extends Equatable {
  const PickedResumeDocument({
    required this.kind,
    required this.bytes,
  });

  final ResumeDocumentKind kind;
  final Uint8List bytes;

  int get sizeBytes => bytes.length;

  /// props deliberately EXCLUDES [bytes]: Equatable's == would hash a résumé,
  /// and `toString()` on a mismatch would print one.
  @override
  List<Object?> get props => <Object?>[kind, bytes.length];
}

/// The local ceiling, mirroring the server's `RESUME_UPLOAD_MAX_BYTES` default.
///
/// Checked ON DEVICE as well as server-side, because the server can only refuse
/// an over-sized document AFTER it has been uploaded — which on a 2G uplink is
/// several minutes of a worker's data spent to be told no. The server stays the
/// authority; this is the courtesy.
const int kResumeUploadMaxBytes = 10 * 1024 * 1024;

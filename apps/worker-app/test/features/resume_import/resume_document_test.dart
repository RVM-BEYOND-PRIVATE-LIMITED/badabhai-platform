import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';

/// The four document types ruling D3 accepts, and the closed sets derived from
/// them (#1499 / ADR-0041).
void main() {
  group('the mime set is the server\'s, exactly', () {
    test('FOUR types, spelled as `RESUME_UPLOAD_MIME_TYPES` spells them', () {
      // Pinned as literals against `packages/types/src/index.ts`. A fifth type,
      // or a single character out of place in the DOCX mime, is a 400 from the
      // mint on a route the worker cannot retry his way past — and the DOCX
      // string is long enough that a typo would otherwise ship unnoticed.
      expect(
        ResumeDocumentKind.values.map((ResumeDocumentKind k) => k.mime).toList(),
        <String>[
          'application/pdf',
          'application/vnd.openxmlformats-officedocument'
              '.wordprocessingml.document',
          'image/jpeg',
          'image/png',
        ],
      );
    });

    test('the picker extensions are derived from the same four', () {
      expect(
        ResumeDocumentKind.allExtensions,
        <String>['pdf', 'docx', 'jpg', 'jpeg', 'png'],
      );
    });
  });

  group('kind from a file name', () {
    test('recognises each accepted extension, case-insensitively', () {
      expect(ResumeDocumentKind.forFileName('cv.pdf'), ResumeDocumentKind.pdf);
      expect(ResumeDocumentKind.forFileName('CV.PDF'), ResumeDocumentKind.pdf);
      expect(
        ResumeDocumentKind.forFileName('resume.docx'),
        ResumeDocumentKind.docx,
      );
      // Both spellings of a JPEG, because both are what phones produce.
      expect(
        ResumeDocumentKind.forFileName('photo.jpg'),
        ResumeDocumentKind.jpeg,
      );
      expect(
        ResumeDocumentKind.forFileName('photo.jpeg'),
        ResumeDocumentKind.jpeg,
      );
      expect(
        ResumeDocumentKind.forFileName('scan.PNG'),
        ResumeDocumentKind.png,
      );
    });

    test('a name with dots in it reads the LAST extension', () {
      // "resume.final.v2.pdf" is what a cybercafe hands back.
      expect(
        ResumeDocumentKind.forFileName('resume.final.v2.pdf'),
        ResumeDocumentKind.pdf,
      );
    });

    test('refuses everything else, and does not throw doing it', () {
      expect(ResumeDocumentKind.forFileName('notes.txt'), isNull);
      expect(ResumeDocumentKind.forFileName('cv.doc'), isNull);
      expect(ResumeDocumentKind.forFileName('noextension'), isNull);
      expect(ResumeDocumentKind.forFileName('trailing.'), isNull);
      expect(ResumeDocumentKind.forFileName(''), isNull);
    });
  });

  group('the picked document', () {
    test('the local ceiling matches the server default', () {
      // `RESUME_UPLOAD_MAX_BYTES` in `packages/config/src/server.ts`. The
      // server stays the authority; this is the courtesy that saves a worker
      // several minutes of 2G uplink to be told no.
      expect(kResumeUploadMaxBytes, 10 * 1024 * 1024);
    });

    test('equality and toString never carry the résumé bytes', () {
      // A résumé is the densest PII this app touches. `props` holds the LENGTH,
      // so an Equatable mismatch prints a number rather than a document.
      final PickedResumeDocument doc = PickedResumeDocument(
        kind: ResumeDocumentKind.pdf,
        bytes: Uint8List.fromList(<int>[1, 2, 3, 4]),
      );
      expect(doc.props, <Object?>[ResumeDocumentKind.pdf, 4]);
      expect(doc.sizeBytes, 4);
      expect(doc.toString(), isNot(contains('1, 2, 3, 4')));
    });
  });
}

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_pdf_download.dart';

/// The shared render wait every in-app résumé download goes through — the
/// Résumé tab's Download / Share and the Bada Bhai chat's tile.
///
/// Every MINT is charged to the server's per-IP download cap (20 an hour, a
/// 409 included); the history READ the wait uses instead is not. So the wait
/// must mint as little as it can, stay bounded, and end on the truth.
void main() {
  group('pollSignedResumeUrl', () {
    /// Runs the poll to completion on a virtual clock and returns what it ended
    /// with — the url, or the error it threw.
    Object? run(
      Future<String?> Function() mint, {
      Future<String?> Function()? renderStatus,
    }) {
      Object? outcome;
      fakeAsync((FakeAsync async) {
        pollSignedResumeUrl(
          mint: mint,
          onPreparing: () {},
          renderStatus: renderStatus,
        ).then<void>(
          (String? url) {
            outcome = url;
          },
          onError: (Object e) {
            outcome = e;
          },
        );
        async.elapse(const Duration(minutes: 3));
      });
      return outcome;
    }

    test('a render that NEVER lands ends on the server\'s own "still rendering" — '
        'the last attempt always mints — after TWO mints, not fifty', () {
      int mints = 0;
      int reads = 0;
      final Object? outcome = run(
        () async {
          mints++;
          throw const ResumeNotReadyFailure();
        },
        renderStatus: () async {
          reads++;
          return 'pending';
        },
      );

      expect(outcome, isA<ResumeNotReadyFailure>());
      expect(mints, 2);
      expect(reads, 49);
    });

    test('the read saying the render landed is what mints again — and the url '
        'comes back', () {
      int mints = 0;
      int reads = 0;
      final Object? outcome = run(
        () async {
          mints++;
          if (reads < 3) throw const ResumeNotReadyFailure();
          return 'https://signed/pdf';
        },
        renderStatus: () async {
          reads++;
          return reads < 3 ? 'pending' : 'rendered';
        },
      );

      expect(outcome, 'https://signed/pdf');
      expect(mints, 2);
      expect(reads, 3);
    });

    test('the read saying FAILED ends the wait at once with the honest failure', () {
      int mints = 0;
      final Object? outcome = run(
        () async {
          mints++;
          throw const ResumeNotReadyFailure();
        },
        renderStatus: () async => 'failed',
      );

      expect(outcome, isA<ResumePdfUnavailableFailure>());
      expect(mints, 1);
    });

    test('a "not available" mint is never waited on', () {
      int mints = 0;
      final Object? outcome = run(
        () async {
          mints++;
          throw const ResumePdfUnavailableFailure();
        },
        renderStatus: () async => 'pending',
      );

      expect(outcome, isA<ResumePdfUnavailableFailure>());
      expect(mints, 1);
    });

    test('a read that cannot answer — no reader, or one that throws — mints on '
        'every check, as before, and stays bounded', () {
      for (final Future<String?> Function()? reader in <Future<String?> Function()?>[
        null,
        () async => throw StateError('offline'),
      ]) {
        int mints = 0;
        final Object? outcome = run(() async {
          mints++;
          throw const ResumeNotReadyFailure();
        }, renderStatus: reader);

        expect(outcome, isA<ResumeNotReadyFailure>());
        expect(mints, 50);
      }
    });
  });
}

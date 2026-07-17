import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/resume_file_name.dart';

void main() {
  group('resumeDownloadFileName ("all words")', () {
    test('two words → FIRST_LAST_RESUME.pdf', () {
      expect(resumeDownloadFileName('Ramesh Kumar'), 'RAMESH_KUMAR_RESUME.pdf');
    });

    test('single word → NAME_RESUME.pdf', () {
      expect(resumeDownloadFileName('Ramesh'), 'RAMESH_RESUME.pdf');
    });

    test('three+ words keeps EVERY token (all-words format)', () {
      expect(
        resumeDownloadFileName('Ram Kumar Sharma'),
        'RAM_KUMAR_SHARMA_RESUME.pdf',
      );
    });

    test('collapses extra / leading / trailing whitespace', () {
      expect(
        resumeDownloadFileName('  Ravi   Verma  '),
        'RAVI_VERMA_RESUME.pdf',
      );
    });

    test('uppercases mixed case', () {
      expect(resumeDownloadFileName('ravi verma'), 'RAVI_VERMA_RESUME.pdf');
    });

    group('fallback', () {
      test('null → generic file name', () {
        expect(resumeDownloadFileName(null), kFallbackResumeFileName);
      });

      test('empty / whitespace-only → generic file name', () {
        expect(resumeDownloadFileName(''), kFallbackResumeFileName);
        expect(resumeDownloadFileName('   '), kFallbackResumeFileName);
      });

      test('name with nothing filename-safe → generic file name', () {
        expect(resumeDownloadFileName('/// \\\\'), kFallbackResumeFileName);
      });
    });

    group('sanitisation', () {
      test('strips path/reserved chars inside a token', () {
        expect(
          resumeDownloadFileName('Ram/Kumar'),
          'RAMKUMAR_RESUME.pdf',
        );
        expect(
          resumeDownloadFileName(r'Ra*m Ku?mar'),
          'RAM_KUMAR_RESUME.pdf',
        );
      });

      test('trims leading/trailing dots on a token (Md. → MD)', () {
        expect(resumeDownloadFileName('Md. Rashid'), 'MD_RASHID_RESUME.pdf');
      });

      test('keeps an internal dot', () {
        expect(resumeDownloadFileName('S.K Sharma'), 'S.K_SHARMA_RESUME.pdf');
      });
    });

    test('preserves non-latin (Devanagari) letters — MediaStore is UTF-8', () {
      // Uppercasing is a no-op for Devanagari; the letters must survive.
      expect(resumeDownloadFileName('राम कुमार'), 'राम_कुमार_RESUME.pdf');
    });

    test('bounds a pathologically long name and never dangles a separator', () {
      final String longName = List<String>.filled(60, 'Kumaraswamy').join(' ');
      final String result = resumeDownloadFileName(longName);
      expect(result.endsWith('_RESUME.pdf'), isTrue);
      // Well under the ~255 filesystem ceiling.
      expect(result.length, lessThanOrEqualTo(140));
      expect(result.contains('__'), isFalse);
      expect(result.contains('_RESUME.pdf'), isTrue);
      expect(RegExp(r'_+_RESUME\.pdf$').hasMatch(result), isFalse);
    });
  });
}

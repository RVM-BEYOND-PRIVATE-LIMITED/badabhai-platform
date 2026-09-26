import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_companion_keys.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';

/// ── THE COMPANION'S CHIP KEYS MUST NOT DRIFT (ADR-0044) ─────────────────────
///
/// The client routes on `option_key`, never on the display copy. The keys live
/// in the server's `companion-keys.ts`; this test READS that TypeScript source
/// and fails on any drift, exactly as `chat_resume_menu_test.dart` does for the
/// résumé menu.
void main() {
  final File server = File('../api/src/chat-companion/companion-keys.ts');

  String readServer() {
    expect(
      server.existsSync(),
      isTrue,
      reason: 'the server source (${server.path}) must be readable from the '
          'worker-app package root — the parity net is worthless if it silently '
          'skips',
    );
    return server.readAsStringSync();
  }

  test('the four fixed keys match the server constants byte-for-byte', () {
    final String ts = readServer();
    final Set<String> serverKeys =
        RegExp('COMPANION_[A-Z_]+_KEY\\s*=\\s*"([^"]+)"')
            .allMatches(ts)
            .map((Match m) => m.group(1)!)
            .toSet();
    expect(serverKeys, <String>{
      kCompanionNewJobsKey,
      kCompanionJobsTabKey,
      kCompanionAppliedKey,
      kCompanionResumeKey,
    });
  });

  test('the job-key prefix and the label separator match the server', () {
    final String ts = readServer();
    final String? prefix = RegExp('COMPANION_JOB_KEY_PREFIX\\s*=\\s*"([^"]+)"')
        .firstMatch(ts)
        ?.group(1);
    final String? separator =
        RegExp('COMPANION_JOB_LABEL_SEPARATOR\\s*=\\s*"([^"]+)"')
            .firstMatch(ts)
            ?.group(1);
    expect(prefix, kCompanionJobKeyPrefix);
    expect(separator, kCompanionJobLabelSeparator);
  });

  test('no companion key collides with a key a shipped client routes on', () {
    for (final String key in <String>[
      kCompanionNewJobsKey,
      kCompanionJobsTabKey,
      kCompanionAppliedKey,
      kCompanionResumeKey,
      kCompanionJobKeyPrefix,
    ]) {
      expect(key.startsWith('companion_'), isTrue);
      expect(resumeMenuActionFor(key), ResumeMenuAction.sendToServer,
          reason: '$key must not trigger a résumé-menu route');
    }
  });

  group('companionActionFor', () {
    const String id = '11111111-1111-4111-8111-111111111111';

    test('routes the three app-handled keys', () {
      expect(companionActionFor('$kCompanionJobKeyPrefix$id'),
          CompanionAction.openJob);
      expect(companionActionFor(kCompanionJobsTabKey), CompanionAction.openJobsTab);
      expect(companionActionFor(kCompanionAppliedKey), CompanionAction.openApplied);
    });

    test('server-answered and foreign keys fall through untouched', () {
      for (final String key in <String>[
        kCompanionNewJobsKey,
        kCompanionResumeKey,
        kResumeMenuEditKey,
        kResumeMenuUploadKey,
        'section_general_info',
        'update_offer_yes',
        'kuch_aur',
        'llm_a',
      ]) {
        expect(companionActionFor(key), CompanionAction.none, reason: key);
      }
    });

    test('a job key carrying anything but a uuid never becomes a route', () {
      for (final String bad in <String>[
        kCompanionJobKeyPrefix,
        '$kCompanionJobKeyPrefix../../admin',
        '${kCompanionJobKeyPrefix}123',
      ]) {
        expect(companionJobId(bad), isNull, reason: bad);
        // #1747 — it stays a companion JOB action (the call site's null-id guard
        // makes it a no-op). Answering `none` sent it down the ordinary path
        // instead, and the worker's transcript gained the chip's LABEL as a
        // message he never typed.
        expect(companionActionFor(bad), CompanionAction.openJob, reason: bad);
      }
      expect(companionJobId('$kCompanionJobKeyPrefix$id'), id);
    });
  });

  group('companionJobLabelParts', () {
    test('splits the title from the city', () {
      final ({String title, String? city}) p =
          companionJobLabelParts('CNC Operator — Pune');
      expect(p.title, 'CNC Operator');
      expect(p.city, 'Pune');
    });

    test('a label with no city is all title', () {
      final ({String title, String? city}) p =
          companionJobLabelParts('CNC Operator');
      expect(p.title, 'CNC Operator');
      expect(p.city, isNull);
    });
  });
}

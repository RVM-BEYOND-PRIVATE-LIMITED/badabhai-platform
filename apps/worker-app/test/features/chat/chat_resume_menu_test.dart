import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';

/// ── THE POST-COMPLETION MENU'S STABLE KEYS MUST NOT DRIFT (#1566) ───────────
///
/// The client routes on `option_key` and NEVER on the display copy (an owner
/// rule, and the only way a label edit cannot silently reroute a tap). The keys
/// and the six section keys live in the server's `resume-menu.ts`; this test
/// READS that TypeScript source and fails on any drift, exactly as
/// `chat_opening_parity_test.dart` does for the opener.
void main() {
  final File server = File('../api/src/chat/resume-menu.ts');

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

  test('the four menu keys match the server constants byte-for-byte', () {
    final String ts = readServer();
    final Set<String> serverKeys = RegExp('RESUME_MENU_[A-Z_]+_KEY\\s*=\\s*"([^"]+)"')
        .allMatches(ts)
        .map((Match m) => m.group(1)!)
        .toSet();

    expect(serverKeys, <String>{
      kResumeMenuEditKey,
      kResumeMenuRedoKey,
      kResumeMenuUploadKey,
      kResumeMenuChatCreateKey,
    });
  });

  test('the six section keys match the server and share the prefix', () {
    final String ts = readServer();
    final List<String> sectionKeys =
        RegExp('key:\\s*"([^"]+)"').allMatches(ts).map((Match m) => m.group(1)!).toList();

    expect(sectionKeys.length, 6);
    for (final String key in sectionKeys) {
      expect(key.startsWith(kResumeMenuSectionPrefix), isTrue,
          reason: '$key must carry the $kResumeMenuSectionPrefix prefix');
    }
    expect(sectionKeys, <String>[
      'section_general_info',
      'section_technical_skills',
      'section_work_history',
      'section_education',
      'section_location',
      'section_availability_salary',
    ]);
    // The piloted per-section walk keys off this const — it must name a real
    // server key, not a second spelling kept beside it.
    expect(sectionKeys, contains(kResumeMenuTechnicalSkillsKey));
  });

  group('resumeMenuActionFor', () {
    test('routes the client-side actions', () {
      expect(resumeMenuActionFor(kResumeMenuUploadKey),
          ResumeMenuAction.openResumeUpload);
      expect(resumeMenuActionFor(kResumeMenuChatCreateKey),
          ResumeMenuAction.startFreshChat);
      expect(resumeMenuActionFor('section_general_info'),
          ResumeMenuAction.openSection);
      expect(resumeMenuActionFor('section_availability_salary'),
          ResumeMenuAction.openSection);
    });

    test('the menu-navigation keys go to the server for the next menu', () {
      expect(resumeMenuActionFor(kResumeMenuEditKey),
          ResumeMenuAction.sendToServer);
      expect(resumeMenuActionFor(kResumeMenuRedoKey),
          ResumeMenuAction.sendToServer);
    });

    test('an ordinary (non-menu) option is untouched', () {
      expect(resumeMenuActionFor('kuch_aur'), ResumeMenuAction.sendToServer);
      expect(resumeMenuActionFor('llm_a'), ResumeMenuAction.sendToServer);
      expect(resumeMenuActionFor('shift_any'), ResumeMenuAction.sendToServer);
    });
  });
}

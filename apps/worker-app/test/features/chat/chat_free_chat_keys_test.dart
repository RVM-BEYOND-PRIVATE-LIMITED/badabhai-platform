import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_free_chat_keys.dart';

/// ── THE FREE-CHAT CHIP KEYS MUST NOT DRIFT (ADR-0051 §5.1) ──────────────────
///
/// Same net as `chat_companion_keys_test.dart`: the client routes on
/// `option_key`, never on the display copy, so the keys are byte-pinned to the
/// source that declares them.
///
/// PINNED TO THE ADR, NOT YET TO THE SERVER MODULE. The server's own
/// declaration lives in `apps/api/src/profiling/free-chat/free-chat.copy.ts`
/// (`FREE_CHAT_START_KEY` / `_LATER_KEY` / `_RESUME_KEY`), which is still in
/// review on #2047. ADR-0051 is merged and names all three, so that is the
/// authority available today; [serverModule] below is the forward pin — it
/// takes over automatically the moment the module lands, and until then this
/// test does NOT silently skip, because the ADR check always runs.
void main() {
  final File adr = File('../../docs/decisions/0051-profiling-stage-free-chat.md');
  final File serverModule =
      File('../api/src/profiling/free-chat/free-chat.copy.ts');

  test('the three mode keys match ADR-0051 byte-for-byte', () {
    expect(
      adr.existsSync(),
      isTrue,
      reason: 'ADR-0051 (${adr.path}) must be readable from the worker-app '
          'package root — the parity net is worthless if it silently skips',
    );
    final String md = adr.readAsStringSync();
    // §5.1 writes each chip as: "<label>" → `free_chat_<slug>`
    final Set<String> adrKeys = RegExp(r'`(free_chat_[a-z_]+)`')
        .allMatches(md)
        .map((Match m) => m.group(1)!)
        .toSet();
    expect(adrKeys, <String>{
      kFreeChatStartKey,
      kFreeChatLaterKey,
      kFreeChatResumeKey,
    });
  });

  test('the résumé label matches ADR-0051', () {
    final String md = adr.readAsStringSync();
    expect(md, contains(kFreeChatResumeLabel));
  });

  test('once the server module lands, it is the authority', () {
    if (!serverModule.existsSync()) {
      // #2047 not merged yet. Deliberately not a skip-with-pass of the WHOLE
      // file: the ADR test above is the live pin meanwhile.
      return;
    }
    final String ts = serverModule.readAsStringSync();
    final Set<String> serverKeys =
        RegExp('FREE_CHAT_[A-Z_]+_KEY\\s*=\\s*"([^"]+)"')
            .allMatches(ts)
            .map((Match m) => m.group(1)!)
            .toSet();
    expect(serverKeys, <String>{
      kFreeChatStartKey,
      kFreeChatLaterKey,
      kFreeChatResumeKey,
    });
    expect(ts, contains(kFreeChatResumeLabel));
  });

  group('freeChatModeAfterTap', () {
    test('"Baad mein" opens free chat', () {
      expect(freeChatModeAfterTap(kFreeChatLaterKey), isTrue);
    });

    test('both ways back to the interview end it', () {
      expect(freeChatModeAfterTap(kFreeChatStartKey), isFalse);
      expect(freeChatModeAfterTap(kFreeChatResumeKey), isFalse);
    });

    test('everything else says NOTHING — null, never false', () {
      // Null is load-bearing. Treating a model follow-up chip or a typed
      // message as "false" would end free mode under the worker mid-chat.
      for (final String? key in <String?>[
        null,
        '',
        'fcq_a',
        'fcq_b',
        'companion_resume',
        '__declined',
        'Resume banayein',
        'FREE_CHAT_LATER',
      ]) {
        expect(freeChatModeAfterTap(key), isNull, reason: 'key=$key');
      }
    });
  });

  group('isFreeChatKey', () {
    test('covers the mode chips and the model follow-ups', () {
      expect(isFreeChatKey(kFreeChatStartKey), isTrue);
      expect(isFreeChatKey(kFreeChatLaterKey), isTrue);
      expect(isFreeChatKey(kFreeChatResumeKey), isTrue);
      expect(isFreeChatKey('fcq_a'), isTrue);
      expect(isFreeChatKey('fcq_d'), isTrue);
    });

    test('and nothing else', () {
      for (final String? key in <String?>[
        null,
        '',
        'companion_resume',
        'section_skills',
        '__declined',
        'free_chatter',
      ]) {
        expect(isFreeChatKey(key), isFalse, reason: 'key=$key');
      }
    });
  });
}

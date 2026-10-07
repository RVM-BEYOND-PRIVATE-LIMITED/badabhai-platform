import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_free_chat_keys.dart';

/// ── THE FREE-CHAT CHIP KEYS MUST NOT DRIFT (ADR-0051 §5.1) ──────────────────
///
/// Same net as `chat_companion_keys_test.dart`: the client routes on
/// `option_key`, never on the display copy, so the keys are byte-pinned to the
/// source that declares them.
///
/// PINNED TO THE ADR, NOT TO THE SERVER MODULE — DELIBERATELY, AND THIS IS THE
/// ONE THING TO CHANGE WHEN #2047 LANDS.
///
/// The server declares these in `free-chat.copy.ts` under
/// `apps/api/src/profiling/free-chat/`, and that module is still in review. The
/// `TD144` guard (`apps/api/src/config/worker-app-parity-filter.guard.test.ts`)
/// requires ci.yml's `worker-app-parity` filter to list EVERY server file a
/// worker-app parity test reads — and separately requires every listed path to
/// EXIST. So naming that file here before it is merged reddens CI whichever way
/// the filter is written. It is referenced in prose only, on purpose.
///
/// ADR-0051 is merged and names all three keys, so it is the authority today
/// and this pin is live, not a placeholder.
///
/// WHEN #2047 MERGES: add a `File(...)` pin here pointing at that module (the
/// path is the api package's profiling/free-chat directory), AND add the same
/// path to the `worker-app-parity` filter in `.github/workflows/ci.yml`, in the
/// same PR. The guard enforces the pair; one without the other is red.
///
/// The literal path is spelled out nowhere in this file on purpose: the guard
/// scans the raw source for quoted relative paths into the api package,
/// comments included, so writing
/// it even inside a comment would demand a filter entry for a file that does
/// not exist yet.
void main() {
  final File adr = File('../../docs/decisions/0051-profiling-stage-free-chat.md');

  test('the three mode keys match ADR-0051 byte-for-byte', () {
    expect(
      adr.existsSync(),
      isTrue,
      reason: 'ADR-0051 (${adr.path}) must be readable from the worker-app '
          'package root — the parity net is worthless if it silently skips',
    );
    final String md = adr.readAsStringSync();
    // §5.1 writes each chip as: "<label>" → `free_chat_<slug>`. Match that chip shape, not every
    // `free_chat_*` token: Release 2 (#2086) documents the reply field `free_chat_mode` in the same
    // ADR, and a bare-token match counted it as a fourth chip key.
    final Set<String> adrKeys = RegExp(r'" → `(free_chat_[a-z_]+)`')
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

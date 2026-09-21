import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

/// ── THE CANNED OPENER MUST NOT DRIFT FROM THE SERVER'S (#1526) ──────────────
///
/// The client's `kChatOpeningText` is only the offline / no-server-turn fallback,
/// but it is the SAME sentence the API serves as `CHAT_OPENING_TEXT`, so a worker
/// who gets the fallback must read exactly what a server-opened worker reads. A
/// comment asking a future editor to "keep them in step" is not a test — this is:
/// the Dart test READS the TypeScript source and fails on any drift.
///
/// The Devanagari read-aloud twin is checked the same way against `ttsTextFor`'s
/// map in `question-tts-text.ts`, so the canned bubble does not speak a sentence
/// the server would never have said.
void main() {
  // `flutter test` runs with the worker-app package root as CWD (the same
  // assumption `persona_neutrality_test.dart` makes with `Directory('lib')`), so
  // the sibling API app is one level up, not two.
  const String serverReplies = '../api/src/chat/chat-replies.ts';
  const String serverTts = '../api/src/profiling/question-tts-text.ts';

  String readServer(String path) {
    final File file = File(path);
    expect(
      file.existsSync(),
      isTrue,
      reason: 'the server source ($path) must be readable from the worker-app '
          'package root — the parity net is worthless if it silently skips',
    );
    return file.readAsStringSync();
  }

  /// The double-quoted literal of `export const <name> = "…";`.
  String serverConstant(String source, String name) {
    final RegExp re =
        RegExp('export\\s+const\\s+$name\\s*=\\s*"([^"]*)"');
    final Match? match = re.firstMatch(source);
    expect(
      match,
      isNotNull,
      reason: 'could not find `export const $name = "…"` in $source',
    );
    return match!.group(1)!;
  }

  test('kChatOpeningText is byte-identical to the server CHAT_OPENING_TEXT', () {
    final String serverText =
        serverConstant(readServer(serverReplies), 'CHAT_OPENING_TEXT');

    expect(
      kChatOpeningText,
      serverText,
      reason: 'the client fallback opener drifted from the server constant. Edit '
          'apps/api/src/chat/chat-replies.ts FIRST, then mirror it here (and its '
          'Devanagari twin via question-tts-text.ts).',
    );
  });

  test('kChatOpeningTtsText matches the server Devanagari twin of the opener',
      () {
    // The API serves `opening_tts_text` from an exact-match map keyed by the
    // romanized constant; the same map entry is the canned bubble's twin.
    final String source = readServer(serverTts);
    final RegExp re = RegExp(
      '"${RegExp.escape(kChatOpeningText)}"\\s*:\\s*"([^"]*)"',
    );
    final Match? match = re.firstMatch(source);
    expect(
      match,
      isNotNull,
      reason: 'no Devanagari twin found for "$kChatOpeningText" in $source',
    );
    expect(
      kChatOpeningTtsText,
      match!.group(1),
      reason: 'the canned read-aloud twin drifted from the API transliteration.',
    );
  });
}

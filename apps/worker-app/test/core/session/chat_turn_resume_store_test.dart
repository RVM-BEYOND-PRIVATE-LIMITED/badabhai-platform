import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/session/chat_turn_resume_store.dart';

/// #2030 ask 3 — the store behind the chip restore. Best-effort by contract:
/// nothing here may throw, because a storage miss costs only the chips.
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  Future<SharedPreferences> prefs() => SharedPreferences.getInstance();
  const SharedPrefsChatTurnResumeStore store =
      SharedPrefsChatTurnResumeStore();

  test('nothing stored reads as null, not an empty state', () async {
    expect(await store.read(), isNull);
  });

  test('a written turn round-trips, order preserved', () async {
    await store.write(const ChatTurnResumeState(
      sessionId: 's1',
      options: <({String optionKey, String labelText})>[
        (optionKey: 'free_chat_start', labelText: 'Haan, shuru karein'),
        (optionKey: 'free_chat_later', labelText: 'Baad mein'),
      ],
      freeChat: true,
    ));

    final ChatTurnResumeState? read = await store.read();
    expect(read!.sessionId, 's1');
    expect(read.freeChat, isTrue);
    expect(
      read.options.map((({String optionKey, String labelText}) o) => o.optionKey),
      <String>['free_chat_start', 'free_chat_later'],
    );
    expect(read.options.first.labelText, 'Haan, shuru karein');
  });

  test('a label holding commas and an em dash survives', () async {
    // Labels are server copy, and a model follow-up chip can hold anything —
    // which is why entries are unit-separated, not comma-joined.
    const String awkward = 'CNC, VMC — kaunsa, bhai?';
    await store.write(const ChatTurnResumeState(
      sessionId: 's1',
      options: <({String optionKey, String labelText})>[
        (optionKey: 'fcq_a', labelText: awkward),
      ],
      freeChat: true,
    ));
    expect((await store.read())!.options.single.labelText, awkward);
  });

  test('a malformed row is dropped, never drawn blank', () async {
    final SharedPreferences p = await prefs();
    await p.setString(SharedPrefsChatTurnResumeStore.kSessionKey, 's1');
    await p.setStringList(SharedPrefsChatTurnResumeStore.kOptionsKey, <String>[
      'no-separator-at-all',
      '\u0001label-with-no-key',
      'key-with-no-label\u0001',
      'free_chat_later\u0001Baad mein',
    ]);

    final ChatTurnResumeState? read = await store.read();
    expect(read!.options.single.optionKey, 'free_chat_later');
  });

  test('a later write replaces the earlier turn', () async {
    await store.write(const ChatTurnResumeState(
      sessionId: 's1',
      options: <({String optionKey, String labelText})>[
        (optionKey: 'free_chat_later', labelText: 'Baad mein'),
      ],
      freeChat: false,
    ));
    await store.write(const ChatTurnResumeState(
      sessionId: 's2',
      options: <({String optionKey, String labelText})>[
        (optionKey: 'free_chat_resume', labelText: 'Resume banayein'),
      ],
      freeChat: true,
    ));

    final ChatTurnResumeState? read = await store.read();
    expect(read!.sessionId, 's2');
    expect(read.freeChat, isTrue);
    expect(read.options.single.optionKey, 'free_chat_resume');
  });

  test('clearAll leaves nothing behind — the shared-phone rule', () async {
    await store.write(const ChatTurnResumeState(
      sessionId: 's1',
      options: <({String optionKey, String labelText})>[
        (optionKey: 'free_chat_later', labelText: 'Baad mein'),
      ],
      freeChat: true,
    ));
    await store.clearAll();

    expect(await store.read(), isNull);
    final SharedPreferences p = await prefs();
    expect(p.getString(SharedPrefsChatTurnResumeStore.kSessionKey), isNull);
    expect(p.getStringList(SharedPrefsChatTurnResumeStore.kOptionsKey), isNull);
    expect(p.getBool(SharedPrefsChatTurnResumeStore.kFreeChatKey), isNull);
  });

  test('the in-memory seam behaves the same way', () async {
    final InMemoryChatTurnResumeStore mem = InMemoryChatTurnResumeStore();
    expect(await mem.read(), isNull);
    await mem.write(const ChatTurnResumeState(
      sessionId: 's1',
      options: <({String optionKey, String labelText})>[],
      freeChat: true,
    ));
    expect((await mem.read())!.freeChat, isTrue);
    await mem.clearAll();
    expect(await mem.read(), isNull);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// A hand fake for the ON-DEVICE recogniser: [listen] feeds [emit] straight back
/// through the result callback so the widget's live-fill can be asserted without
/// a platform channel.
class FakeSpeechDictation implements SpeechDictation {
  bool ready = true;
  bool listening = false;
  String emit = '';
  int initCalls = 0;
  int listenCalls = 0;
  int stopCalls = 0;

  @override
  Future<bool> initialize() async {
    initCalls++;
    return ready;
  }

  @override
  Future<void> listen({
    required void Function(DictationResult result) onResult,
    String? localeId,
  }) async {
    listenCalls++;
    listening = true;
    if (emit.isNotEmpty) onResult(DictationResult(emit, isFinal: true));
  }

  @override
  Future<void> stop() async {
    stopCalls++;
    listening = false;
  }

  @override
  Future<void> cancel() async {
    listening = false;
  }

  @override
  bool get isListening => listening;
}

/// Hold-to-talk on the chat composer mic: a LONG-PRESS runs the DEVICE speech
/// recogniser and fills the input field live (voice → text). The worker then taps
/// Send and it goes as an ORDINARY chat message — no server voice endpoint. A
/// plain TAP still opens the full voice-note screen.
void main() {
  late MockChatRepository chat;
  late FakeSpeechDictation speech;

  setUp(() async {
    chat = MockChatRepository();
    speech = FakeSpeechDictation();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(chat));
    locator.registerLazySingleton<SpeechDictation>(() => speech);
    when(() => chat.ensureSession()).thenAnswer((_) async => null);
  });

  tearDown(() async => locator.reset());

  Future<void> pumpScreen(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
    await tester.pump(); // ChatStarted -> ensureSession resolves, spinner drops
    await tester.pumpAndSettle();
  }

  double abBolenOpacity(WidgetTester tester) {
    final AnimatedOpacity ao = tester.widget<AnimatedOpacity>(
      find.ancestor(
        of: find.text('AB BOLEN'),
        matching: find.byType(AnimatedOpacity),
      ),
    );
    return ao.opacity;
  }

  Finder composerMic() => find.byIcon(Icons.mic);

  testWidgets('holding the mic runs device dictation, flashes "AB BOLEN", and '
      'fills the composer — sending nothing', (WidgetTester tester) async {
    speech.emit = 'Me CNC per kaam krta hun';

    await pumpScreen(tester);
    expect(abBolenOpacity(tester), 0);

    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(composerMic()),
    );
    await tester.pump(const Duration(milliseconds: 600)); // long-press fires
    await tester.pump(); // initialize()
    await tester.pump(); // listen() -> onResult fills the field

    expect(speech.initCalls, 1);
    expect(speech.listenCalls, 1);
    expect(abBolenOpacity(tester), 1, reason: 'the cue shows during the hold');
    expect(find.text('Me CNC per kaam krta hun'), findsOneWidget);

    await gesture.up();
    await tester.pump();
    await tester.pumpAndSettle();

    expect(speech.stopCalls, 1);
    // Nothing was sent — the recognised text only reached the composer.
    verifyNever(() => chat.sendMessage(any()));
    expect(abBolenOpacity(tester), 0);
  });

  testWidgets('the cue stays for the WHOLE hold (no auto-hide) and hides on '
      'release', (WidgetTester tester) async {
    speech.emit = 'kuch';

    await pumpScreen(tester);
    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(composerMic()),
    );
    await tester.pump(const Duration(milliseconds: 600)); // long-press
    await tester.pump(); // initialize()
    await tester.pump(); // listen() -> result
    expect(abBolenOpacity(tester), 1);

    // The old build hid the cue at ~1.1s; it must now persist for the hold.
    await tester.pump(const Duration(seconds: 3));
    expect(
      abBolenOpacity(tester),
      1,
      reason: 'cue shows until the button is let go',
    );

    await gesture.up();
    await tester.pumpAndSettle();
    expect(abBolenOpacity(tester), 0, reason: 'hidden on release');
  });

  testWidgets('recognised words append onto text already typed', (
    WidgetTester tester,
  ) async {
    speech.emit = 'CNC operator';

    await pumpScreen(tester);
    await tester.enterText(find.byType(TextField), 'Mera naam');

    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(composerMic()),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump();
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    expect(find.text('Mera naam CNC operator'), findsOneWidget);
  });

  testWidgets(
    'no recogniser / denied mic → honest notice, composer stays empty',
    (WidgetTester tester) async {
      speech.ready = false;

      await pumpScreen(tester);

      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(composerMic()),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      await gesture.up();
      await tester.pumpAndSettle();

      expect(
        speech.listenCalls,
        0,
        reason: 'never listens without a recogniser',
      );
      expect(find.text(const MicPermissionFailure().message), findsOneWidget);
      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, isEmpty);
    },
  );
}

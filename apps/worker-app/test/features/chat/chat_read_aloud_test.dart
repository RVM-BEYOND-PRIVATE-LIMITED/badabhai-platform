import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_reader.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// A hand fake for the on-device reader: [speak] records the text and stays
/// pending (like real playback) until [finish]/[stop], so the widget's speaking
/// state can be asserted.
class FakeSpeechReader implements SpeechReader {
  final List<String> spoken = <String>[];
  int stopCalls = 0;
  Completer<void>? _completer;

  @override
  Future<void> speak(String text) {
    spoken.add(text);
    _completer = Completer<void>();
    return _completer!.future;
  }

  @override
  Future<void> stop() async {
    stopCalls++;
    finish();
  }

  void finish() {
    if (_completer != null && !_completer!.isCompleted) _completer!.complete();
  }
}

/// Read-aloud: every bada bhai QUESTION bubble carries a speaker icon; tapping it
/// speaks that question via the device recogniser. The worker's own messages
/// carry no icon (questions only).
void main() {
  late MockChatRepository chat;
  late FakeSpeechReader reader;

  setUp(() async {
    chat = MockChatRepository();
    reader = FakeSpeechReader();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(chat));
    locator.registerLazySingleton<SpeechReader>(() => reader);
    when(() => chat.ensureSession()).thenAnswer((_) async => null);
  });

  tearDown(() async => locator.reset());

  Future<void> pumpScreen(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
    await tester.pump();
    await tester.pumpAndSettle();
  }

  // Worker 'hi' + one bot reply → exactly one bot bubble. [ttsText] (#896) is the
  // Devanagari read-aloud script the reply bubble carries (null = older API).
  Future<void> seedBotReply(
    WidgetTester tester,
    String reply, {
    String? ttsText,
  }) async {
    when(
      () => chat.sendMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer((_) async => ChatTurn(reply: reply, ttsText: ttsText));
    await tester.enterText(find.byType(TextField), 'hi');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'a bot question has a speaker; tapping it reads THAT question aloud',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await seedBotReply(tester, 'Aap kaunsa kaam karte hain?');

      // The newest bot bubble is the reply; its speaker is the last one.
      await tester.tap(find.byIcon(Icons.volume_up_rounded).last);
      await tester.pump();
      expect(reader.spoken, <String>['Aap kaunsa kaam karte hain?']);
      // Reading → the glyph flips to stop.
      expect(find.byIcon(Icons.stop_circle_outlined), findsOneWidget);

      reader.finish();
      await tester.pumpAndSettle();
      // Back to idle when playback completes.
      expect(find.byIcon(Icons.stop_circle_outlined), findsNothing);
    },
  );

  testWidgets('tapping the same speaker again stops it', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    await seedBotReply(tester, 'Aap kahan rehte hain?');

    await tester.tap(find.byIcon(Icons.volume_up_rounded).last);
    await tester.pump();
    expect(find.byIcon(Icons.stop_circle_outlined), findsOneWidget);

    await tester.tap(find.byIcon(Icons.stop_circle_outlined));
    await tester.pumpAndSettle();
    expect(reader.stopCalls, greaterThan(0));
    expect(find.byIcon(Icons.stop_circle_outlined), findsNothing);
  });

  // #896 — the on-screen text is romanized Hindi, which no TTS voice pronounces
  // right; read-aloud must SPEAK the Devanagari `tts_text` when present.
  testWidgets(
    'a bot reply with tts_text is READ ALOUD in Devanagari, not the romanized text',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await seedBotReply(
        tester,
        'Aap kaunsa kaam karte hain?',
        ttsText: 'आप कौनसा काम करते हैं?',
      );

      await tester.tap(find.byIcon(Icons.volume_up_rounded).last);
      await tester.pump();
      expect(
        reader.spoken,
        <String>['आप कौनसा काम करते हैं?'],
        reason: 'the SPOKEN string is the Devanagari, never the romanized text',
      );
    },
  );

  testWidgets(
    'a bot reply with no tts_text falls back to speaking the on-screen text',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await seedBotReply(tester, 'Aap kahan rehte hain?'); // no tts_text

      await tester.tap(find.byIcon(Icons.volume_up_rounded).last);
      await tester.pump();
      expect(reader.spoken, <String>['Aap kahan rehte hain?'],
          reason: 'absent tts_text -> speak the romanized text, as before');
    },
  );

  testWidgets('the opener bubble reads its Devanagari constant aloud (#896)', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    // The opener is bubble 0; its speaker is the first on screen.
    await tester.tap(find.byIcon(Icons.volume_up_rounded).first);
    await tester.pump();
    expect(reader.spoken, <String>[kChatOpeningTtsText],
        reason: 'the first question speaks Devanagari from turn one');
  });

  testWidgets('a bot reply adds ONE speaker; the worker message adds none', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    final int before =
        tester.widgetList(find.byIcon(Icons.volume_up_rounded)).length;
    await seedBotReply(tester, 'ok'); // worker 'hi' + one bot reply
    final int after =
        tester.widgetList(find.byIcon(Icons.volume_up_rounded)).length;
    expect(
      after - before,
      1,
      reason: 'the bot reply gets a speaker; the worker message does not',
    );
  });
}

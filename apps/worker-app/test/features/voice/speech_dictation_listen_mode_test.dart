import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:speech_to_text/speech_to_text.dart';

import 'package:badabhai_worker_app/features/voice/data/speech_dictation_impl.dart';

/// Regression: a worker speaking three sentences was transcribed down to a single
/// word ("me") because the recogniser listened in the DEFAULT
/// [ListenMode.confirmation] — a short-command mode that endpoints hard after the
/// first phrase. [RealSpeechDictation] must ask for [ListenMode.dictation]
/// (sentences/paragraphs). This pins that so the option cannot be silently dropped
/// again.
class _MockSpeechToText extends Mock implements SpeechToText {}

void main() {
  test('listen() uses ListenMode.dictation, not confirmation', () async {
    final _MockSpeechToText stt = _MockSpeechToText();
    when(() => stt.initialize(
          onError: any(named: 'onError'),
          onStatus: any(named: 'onStatus'),
        )).thenAnswer((_) async => true);
    when(() => stt.isListening).thenReturn(false);

    SpeechListenOptions? used;
    when(() => stt.listen(
          onResult: any(named: 'onResult'),
          onSoundLevelChange: any(named: 'onSoundLevelChange'),
          listenOptions: any(named: 'listenOptions'),
        )).thenAnswer((Invocation inv) async {
      used = inv.namedArguments[#listenOptions] as SpeechListenOptions?;
    });

    final RealSpeechDictation dictation = RealSpeechDictation(stt);
    await dictation.initialize();
    await dictation.listen(onResult: (_) {});

    expect(used, isNotNull, reason: 'the recogniser was never asked to listen');
    expect(used!.listenMode, ListenMode.dictation);
    // Guard the two options the fix must leave intact.
    expect(used!.partialResults, isTrue);
    expect(used!.onDevice, isTrue);
  });
}
